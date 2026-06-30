# Replication and read consistency

**Industry names:** replication · primary/replica · replication lag · stale
read · failover · read-your-writes consistency — *type label: Industry
standard.*

**Status in flattr: not yet exercised.** flattr is a single device with a
single copy of every datum. There is no replica, no lag, no failover. This
file teaches replication and the consistency model it forces on you, then
names the exact trigger — a second copy of the data anywhere — that would
make it real.

## Zoom out, then zoom in

Replication is **keeping more than one copy of the data and deciding what a
reader sees when the copies disagree.** flattr keeps exactly one copy of
everything: the graph is one bundled file, the cache is one device-local
blob. With one copy there's nothing to disagree, so consistency is trivially
perfect — every read sees the latest write.

```
  Zoom out — the (single) copy of each datum

  ┌─ Device (the only node) ────────────────────────────────────┐
  │                                                             │
  │  graph.json     → ONE copy, in the app binary               │
  │  elevCache blob → ONE copy, in device AsyncStorage          │
  │                                                             │
  │  no second device · no server copy · no replica            │ ← nothing
  │  → no lag · no stale read · no failover · no quorum        │   to replicate
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. The instant a second copy exists — a cloud backup of the cache, a
shared graph served from a CDN, the *same user on a second device* — you
inherit the central question of distributed data: when copy A has a write
copy B hasn't seen yet, what does a reader get? flattr answers this by never
having a copy B. Knowing the consistency models *now* means that when Rein's
local-first instincts (from `buffr`/`dryrun`) pull a sync layer into flattr,
the staleness decision is a choice, not an accident.

## The structure pass

**Layers.** One logical node (the device) holding two single-copy stores.
The pipeline that produces `graph.json` is upstream but offline — it's a
build step, not a replica.

**Axis — how many copies, and can they diverge?** Trace it:

```
  Axis: "how many copies, and can a reader see a stale one?"

  ┌─ graph.json ────────────────┐  → 1 copy (binary) → no divergence
  └─────────────────────────────┘     every device ships the SAME file
  ┌─ elevCache blob ────────────┐  → 1 copy (this device) → no divergence
  └─────────────────────────────┘     read-your-writes is automatic
  ┌─ (hypothetical) cloud sync ─┐  → 2+ copies → CAN diverge → stale reads,
  │  device + server            │     lag, conflict resolution required
  └─────────────────────────────┘

  one copy → consistency is free; two copies → it's a design problem
```

**Seam.** The load-bearing boundary is **single-copy vs. multi-copy**. Below
it (flattr today), consistency is a non-question. Above it (any sync), you
must pick: strong consistency (reads wait for replication, slower) or
eventual (reads can be stale, faster). flattr lives entirely below the seam.
The trigger is the first datum that exists in two places.

## How it works

### Move 1 — the mental model

You've shipped local-first sync in `buffr` (SQLite primary, Supabase mirror)
and `dryrun` (GitHub-as-backend). You already know the shape: a local copy
the user reads instantly, and a remote copy that catches up later. That gap
between "written locally" and "visible remotely" *is* replication lag, and
what a reader sees during the gap *is* the consistency model. flattr just
hasn't grown the remote copy yet.

```
  The replication kernel — copy + lag + read choice

  ┌─ PRIMARY ─┐   replicate    ┌─ REPLICA ─┐
  │ write X   │ ─────────────► │  …lag…    │
  └─────┬─────┘   (async/sync) └─────┬─────┘
        │ read here = always X       │ read here during lag = STALE (old X)
        ▼                            ▼
   read-your-writes              eventual consistency
   (strong)                      (fast, may be behind)

  flattr has ONE box → no second box to be stale → consistency free
```

### Move 2 — the parts, and flattr's stance on each

**The copies — exactly one each.** `graph.json` ships inside the app binary
(`loadGraph.ts:7`), so every install has a byte-identical copy — but it's not
*replication*, it's *distribution* of read-only data. No device ever writes
the graph, so no two graphs can diverge. The cache blob
(`elevCache.ts:7`, one AsyncStorage key) is device-local and written only by
that device. One writer, one copy, read by the same device — the textbook
single-node setup where consistency is free.

**Read-your-writes — automatic here.** The strongest practical consistency
guarantee ("after I write X, I read X") is free when there's one copy:
`putElev` mutates `mem`, and the very next `getElev` sees it
(`elevCache.ts:31-40`) — synchronously, same thread, same Map. There's no
replica to be behind. What would break it: a read served from a not-yet-
synced replica, which flattr has no path to.

```
  Read-your-writes in flattr — same Map, same thread

  putElev("c", 53)  →  mem: {…, "c":53}
  getElev("c")      →  53          ← instant, no lag, no replica
```

**Replication lag, stale reads, failover — none exist.** Lag is the delay
for a write to reach a replica; flattr has no replica, so lag is undefined.
Stale reads happen when you read a replica behind the primary; no replica, no
staleness. Failover is promoting a replica when the primary dies; with one
node there's nothing to promote — if the device's storage is gone, the data
is gone (the graph re-installs, the cache rebuilds from the API). Naming all
three as absent is correct, not a gap: a single-device app *shouldn't* carry
replication machinery.

**The pipeline is not a replica.** `pipeline/` produces `graph.json` from OSM
+ elevation at build time. It might look like an upstream primary, but it's a
*build process*, not a live replica — it runs offline, on a schedule, and the
app never reads from it. The relationship is "compiler → artifact," not
"primary → replica." Calling it replication would be the wrong mental model.

### Move 2.5 — current vs. future (the trigger and the model you'd pick)

```
  Phase A (now) — one copy           Phase B — cloud sync arrives
  ┌──────────────────────────────┐   ┌──────────────────────────────┐
  │ graph: 1 binary copy          │   │ shared elev cache on a server │
  │ cache: 1 device copy          │   │   (so devices share fetches)  │
  │ read-your-writes free         │   │ → replication lag appears     │
  │ no lag/stale/failover         │   │ → pick: strong or eventual    │
  │ VERDICT: nothing to add       │   │ VERDICT: eventual + LWW fits  │
  └──────────────────────────────┘   └──────────────────────────────┘
```

**The trigger:** the first time a datum lives in two places that can each be
read. The most likely one for flattr is a *shared elevation cache* — the same
DEM cells are identical for every user, so a server-side cache would let
devices share fetches and crush the rate-limit problem entirely. That's the
moment replication lag appears.

**The model you'd pick:** eventual consistency with last-write-wins, and it's
an easy call here. Elevation values are *immutable facts about the world* —
two devices fetching the same DEM cell get the same number (the
`elevCache.ts:2-3` comment says exactly this: "DEM samples never change").
So conflicts are impossible by construction; a stale read just returns a
correct-but-older number that's *identical* to the fresh one. This is the
rare case where eventual consistency has zero downside, because the data is
write-once-correct. What *doesn't* change: the graph stays distributed-not-
replicated; only the cache gains a second copy.

### Move 3 — the principle

Replication forces a choice — **strong consistency (correct but slow reads)
or eventual (fast but possibly stale reads)** — and the right answer depends
entirely on whether stale data is *wrong* or just *old*. flattr's would-be
replicated data (elevation) is immutable, so stale = old-but-identical =
harmless, making eventual consistency free of its usual cost. The skill that
transfers: before agonizing over a consistency model, ask whether your data
can even conflict. Immutable, write-once data (events, facts, content-
addressed blobs) makes the whole question disappear — which is why flattr's
eventual-consistency future is trivial and a mutable-counter sync would be
hard.

## Primary diagram

```
  flattr's replication story — one copy, free consistency

  ┌─ THE ONLY NODE (the device) ────────────────────────────────┐
  │                                                             │
  │  graph.json ── distributed (read-only), NOT replicated      │
  │     every install = identical copy, no divergence possible  │
  │                                                             │
  │  elevCache ── single device-local copy                      │
  │     putElev → mem → getElev sees it instantly               │
  │     = read-your-writes, free (no replica to lag behind)     │
  │                                                             │
  │  lag: undefined · stale reads: none · failover: N/A         │
  └─────────────────────────────────────────────────────────────┘
       TRIGGER → shared cloud elevation cache (devices share fetches)
       → eventual consistency + LWW (FREE: elevation is immutable)
```

## Elaborate

Replication exists to buy two things: **availability** (a replica answers if
the primary is down) and **read scaling** (spread reads across replicas).
flattr needs neither — one user, one device, a 544 KB dataset that reads
instantly from RAM. The interesting wrinkle is that flattr's data is the
*ideal* shape for the easy end of the CAP tradeoff: the graph and the
elevation values are immutable, and immutable data sidesteps the partition-
consistency conflict entirely (there's no write to lose, no last-writer to
pick). This is the same reason content-addressed stores (Git, IPFS) and
event logs replicate so cleanly — append-only/immutable data turns
replication from a correctness problem into a plumbing problem. flattr's
local-first siblings (`buffr`, `dryrun`) hit the *hard* version because they
sync *mutable* user state; flattr, if it ever syncs, only syncs immutable
facts.

## Interview defense

**Q: flattr has no replication. If you added cloud sync, what consistency
model?**
Eventual consistency with last-write-wins, and it's an easy call because the
data is immutable. The thing worth sharing is the elevation cache — DEM
samples are fixed facts about the world (the code comment says "DEM samples
never change"), so two devices fetching the same cell get the *same* number.
Conflicts are impossible; a stale read returns a correct-but-older value
identical to the fresh one. Eventual consistency's usual downside —
serving wrong data — can't occur.

```
  immutable data → stale read = old-but-identical → eventual is free
```
*Anchor: eventual + LWW, free of its usual cost because elevation is
write-once-correct.*

**Q: Is the pipeline a replica of the graph?**
No — it's a build process, not a live replica. `pipeline/` compiles OSM +
elevation into `graph.json` offline; the app reads the artifact, never the
pipeline. That's a compiler→artifact relationship, not primary→replica.
Today's graph is *distributed* (every install ships the same read-only file)
but not *replicated* (no device writes it, so no copies can diverge).
*Anchor: distribution of read-only data, not replication — nothing writes the
graph, so nothing can diverge.*

## See also

- `05-transactions-isolation-and-anomalies.md` — consistency's single-node
  sibling.
- `07-wal-durability-and-recovery.md` — durability, the other "survive
  failure" axis.
- `study-system-design` — the local-first sync shapes (`buffr`, `dryrun`)
  Rein has shipped.
- `study-distributed-systems` — partial failure and coordination if sync
  arrives.
