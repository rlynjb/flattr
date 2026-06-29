# Replication and read consistency

**Industry name(s):** replication / primary-replica / replication lag / stale
reads / read-your-writes / eventual consistency · **Type:** Industry standard.

> **Status in flattr: `not yet exercised`.** flattr is a single device reading a
> single bundled artifact — there are no replicas, no lag, no failover. But there
> *is* a clean real-world analog already in the repo: the bundled `graph.json` is
> a *replica* of the pipeline's output, and it can go *stale* relative to the
> source data. This file teaches replication in full and grounds the consistency
> lessons in that analog.

## Zoom out, then zoom in

```
  Zoom out — replication copies the write path's output to read paths

  ┌─ Source of truth ────────────────────────────────────────┐
  │  pipeline output (data/graph.json) · a future primary DB  │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Replication layer ────────▼─────────────────────────────┐
  │  ★ copy graph.json into mobile/assets (manual "replica") ★│ ← the analog
  │  ✗ DB replicas · ✗ streaming WAL · ✗ failover (not present)│
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Read paths ───────────────▼─────────────────────────────┐
  │  loadGraph() on each device reads its bundled copy        │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. Replication is *keeping multiple copies of the data in sync so reads can
be served from any of them.* The central problem it creates is **lag**: a replica
is always a little behind the primary, so a read from a replica can be **stale** —
return a value that's already been overwritten. flattr has no live replicas, but
it ships the *static* version of exactly this: a copy of the data (`graph.json`
bundled into the app) that's a snapshot of the source and goes stale until the
next build+ship. Reasoning about *that* staleness is the on-ramp to reasoning
about replica staleness.

## The structure pass

**Layers** (by copy, source → reader):
1. **Source** — pipeline output, the freshest graph.
2. **The shipped copy** — `mobile/assets/graph.json`, frozen at build time.
3. **The runtime patch** — live viewport/corridor tiles fetched on demand
   (`useTileGraph.ts`), which *refresh* parts of the stale copy.

**Axis traced — "how stale can a read be, and does the reader know?"**

```
  axis — "staleness of a read" — across the copies

  ┌─ pipeline output (source) ──────────────┐
  │  staleness = 0 (it IS the truth)         │  freshest
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (build + ship: hours/days/release cycle)
  ┌─ bundled graph.json (the "replica") ────┐
  │  staleness = age since last build/ship   │  could be weeks behind reality
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (runtime tile fetch refreshes a region)
  ┌─ live merged graph (per session) ───────┐
  │  staleness = seconds (just fetched)       │  freshest for the viewed area
  └───────────────────────────────────────────┘
```

The axis-answer is the whole lesson: flattr's bundled graph is a replica with a
*replication lag measured in release cycles*, and the runtime tile fetch is a
"read from primary for the hot region" pattern that papers over the staleness
where the user is actually looking. That's structurally identical to "serve most
reads from a replica, but route the latency-sensitive ones to the primary."

## How it works

### Move 1 — the mental model

You know a CDN: the origin has the truth, edge nodes have copies, and a copy can
serve a stale asset until it's invalidated. Database replication is a CDN for
*rows* — one primary takes writes, replicas take reads, and a replica can serve a
row that's a few milliseconds (or, under load, seconds) out of date. The new
hazard versus a CDN is *read-your-writes*: a user who just saved something and
immediately reads it from a lagging replica sees their own write *missing*.

```
  the pattern — primary takes writes, replicas serve reads (with lag)

  writes ─►┌─ PRIMARY ─┐── stream WAL ──►┌─ REPLICA A ─┐◄─ reads
           │ source of │── stream WAL ──►┌─ REPLICA B ─┐◄─ reads
           │  truth    │                 └─────────────┘
           └───────────┘   lag = how far behind the replica's apply is
   stale read: replica returns a value the primary has already changed
   read-your-writes: user reads their own just-made write → may be MISSING
```

The mechanism is literally `07`'s WAL shipped over the network and replayed on the
replica — replication is "apply the primary's log somewhere else."

### Move 2 — replication mechanics + flattr's analog

**Sync vs async replication — the durability/latency dial.** A write to the
primary can wait for replicas to confirm (*synchronous* — no data loss on primary
failure, but every write pays the slowest replica's latency) or not (*asynchronous*
— fast writes, but a primary crash loses un-shipped writes). It's the same window
idea as durability (`07`), now across machines.

```
  sync vs async replication

  SYNC:  write → primary → WAIT for replica ack → client ack
         ▲ safe (replica has it) but slow (slowest replica gates every write)
  ASYNC: write → primary → client ack ─┄┄► replica catches up later
         ▲ fast but a primary crash loses the un-shipped tail
```

**flattr's analog: the bundled graph as an async replica.** `mobile/assets/
graph.json` is a copy of the pipeline's `data/graph.json`, copied in manually
(the `loadGraph.ts:2-4` comment: "regenerate with `npm run build:graph` then copy
data/graph.json here"). That's *asynchronous replication with a human as the
replication stream* — the replica (the app's bundle) only catches up to the source
when someone rebuilds and re-ships. The "lag" is the time between a real-world
street/grade change and the next app release. A user routing on a months-old
bundle is doing a **stale read** of the world.

```
  flattr's static replication — human as the WAL shipper

  pipeline ──build──► data/graph.json ──HUMAN copies──► mobile/assets/graph.json
   (source)            (fresh)            (manual sync)   (app bundle = replica)
                                                              │ loadGraph()
                                                              ▼
                                                       stale until next release
   lag = release cadence; reader has NO signal that its copy is stale (red-flag #2)
```

**The runtime refresh = "route hot reads to fresher data."** `useTileGraph.ts`
fetches live Overpass tiles for the viewport and route corridor and merges them
over the bundled base. That's flattr serving the *cold* bulk from the stale
replica (the bundle) but refreshing the *hot* region (what the user is looking at
and routing through) from the source-ish (live Overpass). It's the read-routing
strategy: most reads from the replica, latency/freshness-sensitive reads from a
fresher source.

```
  hot/cold read routing (useTileGraph.ts)

  cold (whole city)  ─► bundled graph.json   (stale replica, instant)
  hot (viewport,     ─► live Overpass fetch  (fresh, merged over base)
       route corridor)
   merged graph = stale base + fresh patch where the user actually is
```

**Read consistency models — what a reader is promised.** Across replicas you pick
a guarantee:
- **Eventual consistency** — replicas converge *eventually*; a read may be stale.
  flattr's bundle is eventually consistent with reality (next release).
- **Read-your-writes** — a reader always sees its own prior writes. flattr has no
  user writes to the graph, so this is trivially satisfied (nothing to miss).
- **Monotonic reads** — you never see *time go backwards* (a later read showing
  older data than an earlier one). flattr's merge could *technically* violate a
  monotonic-read-like property if a fresh tile is later evicted back to stale base
  — but since the base is a strict subset-in-time, this is benign.

**The failover flattr doesn't have.** When a primary dies, a replica is promoted.
The hazards — split-brain (two primaries accept writes), losing the async tail,
electing a lagging replica — are all real-engine problems flattr never faces with
one device and one read-only artifact. The trigger is, again, **a live backend
with replicas** (the spec's Postgres target), at which point read-replica scaling
and failover become real and every hazard above activates.

### Move 2.5 — current vs future

```
  Phase A (now)                       Phase B (live backend + replicas)

  copies: bundle = manual async       copies: primary + N read replicas
          replica of pipeline output  stream: WAL shipped continuously
  lag: release cadence (huge)         lag: ms–seconds (load-dependent)
  staleness signal: NONE              staleness: monitor replica lag metric
  failover: n/a (single device)       failover: promote replica; handle split-brain
  read routing: hot=live, cold=bundle read routing: writes→primary, reads→replica
  carries over: the hot/cold tile-merge instinct is ALREADY the read-routing
                pattern — it survives the migration almost unchanged.
```

### Move 3 — the principle

Replication buys read scale and availability at the price of *staleness you must
reason about explicitly* — every replica read is a bet that "a little behind" is
acceptable for this query. The discipline is to name, per read, how stale is too
stale, and route the reads that can't tolerate it to the primary. flattr already
does the static version of this — stale bulk from the bundle, fresh hot region
from the live source — so the instinct is in the codebase even though the
machinery isn't. Reading a system for "which reads can tolerate staleness and
which can't" is the move that tells you where a replica is safe and where it'll
bite.

## Primary diagram

```
  flattr's replication analog vs real DB replication

  ┌─ flattr (now): static, human-shipped replica ─────────────┐
  │ pipeline ─build─► data/graph.json ─human copy─► bundle     │
  │ bundle = async replica; lag = release cadence; no signal   │
  │ hot/cold routing: viewport+corridor ─► LIVE Overpass       │
  │                   rest ─────────────► stale bundle         │
  └────────────────────────────────────────────────────────────┘
  ┌─ real DB (not present; the upgrade) ──────────────────────┐
  │ writes ─► PRIMARY ─stream WAL─► REPLICA(s) ◄─ reads        │
  │ sync→safe+slow / async→fast+lossy tail                     │
  │ consistency: eventual | read-your-writes | monotonic       │
  │ failover: promote replica (split-brain, lagging-replica)   │
  └────────────────────────────────────────────────────────────┘
   trigger to cross: a live backend serving multiple devices at read scale
```

## Elaborate

Replication is where the CAP theorem stops being abstract: when the network
between primary and replica partitions, you must choose — keep serving reads from
the replica (available, but possibly stale/inconsistent) or refuse (consistent,
but unavailable). Most app databases choose availability with async replication
and bounded staleness, and bolt read-your-writes on top by routing a user's reads
to the primary (or to a replica known to have caught up) for a short window after
their write. That "sticky read" trick is the single most common production fix for
the "I saved it and it's gone" bug.

flattr's static-bundle replication is the same family as your `dryrun`
(GitHub-as-backend — clients pull a copy of the repo, which lags the canonical
remote) and `buffr` (SQLite local canonical + Supabase mirror — the mirror is an
async replica of local). Across your portfolio, replication shows up every time
there's a canonical store and a copy that lags it; flattr's copy just happens to
lag by a whole release cycle. The `study-distributed-systems` guide owns the
multi-replica coordination and partition behavior; this file owns the storage-side
consistency the application has to assume.

## Interview defense

**Q: "flattr is one device with no replicas. So what's there to say about
replication?"**

> The bundled `graph.json` is a replica — a copy of the pipeline's output,
> shipped into the app, that lags the source by a full release cycle. So flattr
> has a static replication lag, and a user can do a stale read of the world on an
> old bundle. The interesting part is `useTileGraph`: it serves the cold bulk from
> the stale bundle but refreshes the hot region — viewport and route corridor —
> from live Overpass. That's exactly the read-routing pattern of "replica for most
> reads, fresher source for the ones that matter."

```
  bundle = stale replica (lag = release cadence)
  hot region ─► live fetch (fresh) ; cold ─► bundle (stale)
```

Anchor: *flattr already does hot/cold read routing against a stale replica — the
machinery is manual, the instinct is real.*

**Q: "What's the load-bearing hazard of replication people forget?"**

> Read-your-writes. Async replicas mean a user can save something and immediately
> read it back from a lagging replica and see it *missing* — which reads as a data-
> loss bug even though the write is safe on the primary. The fix is sticky reads:
> route that user's reads to the primary for a short window after their write.
> flattr dodges it entirely today because the graph is read-only — there are no
> user writes to fail to see.

Anchor: *the replication bug that looks like data loss is read-your-writes under
async lag; flattr is immune only because it has no writes to the replicated data.*

## See also

- `07-wal-durability-and-recovery.md` — replication IS WAL shipping
- `05-transactions-isolation-and-anomalies.md` — anomalies across replicas
- `01-database-systems-map.md` — the bundle as a copy of pipeline output
- `09-database-systems-red-flags-audit.md` — the stale-bundle / no-version risk
- `../study-distributed-systems/` — multi-replica coordination, CAP, partitions
- `../study-system-design/` — read-replica scaling and failover architecture
