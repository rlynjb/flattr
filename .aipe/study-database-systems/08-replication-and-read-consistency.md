# Replication and read consistency

**Industry name(s):** replication / read replicas / replication lag / stale reads
/ failover · **Type:** Industry standard — **`not yet exercised`.** There is one
bundled copy of the data per app install; no replicas, no lag, no failover.

## Zoom out, then zoom in

Verdict first: **flattr has no replication and no read-consistency problem,
because there's exactly one copy of the data that each app reads locally.**
Replication exists to keep multiple copies of data in sync across machines so
reads can scale and survive a node loss — and it introduces lag, stale reads, and
failover as the price. flattr ships one immutable copy *inside each app bundle*,
so there's no primary/replica relationship, nothing to sync, and no lag window.

```
  Zoom out — where replication WOULD live (it doesn't)

  ┌─ Many app installs (each a "replica"?) ──────────────────────────┐
  │  phone A: graph.json   phone B: graph.json   phone C: graph.json │
  │     each is a full, independent, immutable copy                   │
  │     NOT replicas: no primary, no sync, no lag between them        │
  └───────────────────────────┬──────────────────────────────────────┘
        ┌─────────────────────▼─────────────────────┐
        │  ✗ NO PRIMARY/REPLICA · NO LAG · NO        │  ← the absent topology
        │     FAILOVER · NO STALE-READ WINDOW ✗      │
        └─────────────────────┬──────────────────────┘
  ┌─ Source of truth ─────────▼──────────────────────────────────────┐
  │  the build pipeline + OSM/elevation (regenerates the artifact)   │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"if there are multiple copies of the data, how do reads
stay consistent across them?"* flattr's answer is that the copies are
*independent immutable snapshots*, not synced replicas — so consistency *across*
copies isn't maintained at all, and it doesn't need to be, because the data is
read-only and changes only on the deploy cadence.

## The structure pass

**Layers.** Source of truth (the build), and N independent copies (one per app
install). There's no replica tier in between — the "copies" are deploy artifacts,
not database replicas.

**The axis: consistency — do all copies agree, and how fresh is each read?** This
is the axis that exposes the (benign) truth:

```
  Axis = "do the copies agree / how stale can a read be?"

  ┌─ Source (build) ──────────────────────────────┐
  │  produces a versioned artifact per deploy      │  → the canonical version
  └───────────────────────────┬─────────────────────┘
        seam: ship into app bundle  ═════════════╪═══
  ┌─ App copies (N installs) ─▼─────────────────────┐
  │  each holds whatever version it last installed  │  → can differ ACROSS
  │                                                 │    installs, but each is
  │                                                 │    internally consistent
  └───────────────────────────────────────────────────┘
```

**Seams.** The would-be replication seam — "primary → replica sync with lag" —
doesn't exist. The *real* consistency seam is the **deploy**: an old app install
runs an old `graph.json` until the user updates. That's the only "stale read"
flattr has, and it's measured in app-update cadence (days/weeks), not replication
lag (milliseconds). It's a versioning concern, not a replication one.

## How it works

### Move 1 — the mental model

You know how a deployed frontend can be stale — a user has an old bundle cached
until they hard-refresh. flattr's "replication" is exactly that: each install has
a bundled `graph.json`, and an install is "stale" only relative to the latest
deploy, not relative to a live primary. There's no replica catching up to a
primary in real time, because there's no live primary at all.

```
  The pattern — replication keeps copies in sync; flattr has no sync

  replicated DB:  primary ──(stream writes, lag)──► replica ──► reads
                                  ↳ stale read = read replica before lag closes
  flattr:         build ──(deploy)──► app copy ──► reads
                                  ↳ "stale" = old app version, not live lag
```

### Move 2 — what's here, what's absent

#### Each app install is an independent immutable copy

When the app ships, `graph.json` is in the bundle. Every install reads its own
local copy. These copies don't talk to each other and don't sync to a primary —
they're frozen at whatever version shipped with that app build. So "are the
replicas consistent?" is the wrong question; the right one is "are all installs on
the same app version?" — a release-management question, not a database one.

```
  N installs = N independent snapshots (not replicas)

  install A (v1.2 graph) ──┐
  install B (v1.3 graph) ──┼── never sync · no primary · each internally
  install C (v1.2 graph) ──┘   consistent · differ only by app version
```

#### The only "stale read": an old app version

The single consistency gap is version skew across installs: a user who hasn't
updated runs an older graph. For a street network this is nearly harmless — roads
and grades change on the scale of months, and the app degrades gracefully
(routing still works on the old graph). Contrast a replicated DB's stale read,
where a millisecond of lag can show a user their own write hasn't landed. flattr
has no writes, so it can't have *that* anomaly at all.

#### The runtime tile builds are caching, not replication

`useTileGraph` builds extra graph regions at runtime and merges them onto the base
graph. It's tempting to call the merged result a "replica," but it isn't — it's a
**read-through cache**: fetch-on-demand, hold in memory, discard on reload. There's
no second authoritative copy being kept in sync; there's a base artifact plus
transient cached extensions. (This is a real pattern worth knowing — see the
system-design guide — just not replication.)

```
  Tile builds = read-through cache, NOT replication

  base graph.json (authoritative) + on-demand tile builds (cached, transient)
       │                                    │
       └─ merged in memory for this session ┘  → discarded on reload; no sync,
                                                 no second source of truth
```

#### Failover: nothing to fail over to (or from)

Failover promotes a replica when the primary dies. flattr's data read is a local
file access — it can't "go down" the way a network DB can, and there's no replica
to promote. The data layer has no availability failure mode at all. (The
*network* build path in `useTileGraph` *can* fail — Overpass/Open-Meteo down — and
it degrades to flat-elevation or keeps the last region; that's graceful
degradation of an enrichment step, not data-layer failover.)

#### Move 2.5 — current vs future state

```
  Phase A (now): independent copies        Phase B (a shared live store)

  one bundled copy per install             central DB + read replicas
  no primary, no sync, no lag              primary → replicas with lag
  "stale" = old app version (days)         "stale" = replication lag (ms)
  no failover (local file can't fail)      failover promotes a replica
  no read-your-writes problem (no writes)  read-your-writes becomes a real concern
```

The trigger is the same as files `05`–`07`: a live, writable, shared store. The
moment edits are central and reads scale across replicas, you inherit replication
lag, stale reads, read-your-writes consistency, and failover — none of which
flattr has today.

### Move 3 — the principle

**Independent immutable copies aren't replicas — they're versions.** flattr
distributes its data by *baking it into the deploy*, so consistency across copies
is a release-cadence question, not a sync-and-lag question. The general lesson:
replication's costs (lag, stale reads, failover complexity) are the price of a
*live shared* store; if your data is read-only and changes on a deploy cadence,
shipping independent copies sidesteps all of it — at the cost of version skew,
which is usually the cheaper problem.

## Primary diagram

The full picture: independent copies, the deploy seam, the absent replica tier.

```
  flattr replication & consistency — full picture

  ┌─ SOURCE OF TRUTH ────────────────────────────────────────────────┐
  │  build pipeline + OSM/elevation → versioned graph.json per deploy │
  └───────────────────────────┬──────────────────────────────────────┘
            ═══ DEPLOY SEAM ═══┼═══ (the only "consistency" boundary)
  ┌─ APP INSTALLS (N independent immutable copies) ──▼────────────────┐
  │  phone A: graph v1.3   phone B: graph v1.2   phone C: graph v1.3  │
  │    each internally consistent · differ only by app version        │
  │    + runtime tile builds = read-through CACHE (not a replica)      │
  │                                                                   │
  │  ✗ no primary/replica  ✗ no lag  ✗ no failover  ✗ no stale-read   │
  │    window  ✗ no read-your-writes problem (no writes)              │
  │  [Phase B] central writable store → replication topics land here  │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Replication: never exercised. The closest real pattern is the
read-through tile cache in `useTileGraph`, which people might mistake for
replication and isn't.

**The single bundled copy — `mobile/src/loadGraph.ts` (lines 7-11):**

```
  import graph from "../assets/graph.json";   ← THE copy: one per app bundle,
                                                immutable, no sync to anything
  export function loadGraph(): Graph {
    return graph as unknown as Graph;
  }
       │
       └─ this import is the entire "data distribution" mechanism. Each install
          has its own graph.json frozen at install time. No primary to replicate
          from, no replica to lag behind — just N independent frozen copies.
```

**The read-through cache (NOT replication) — `mobile/src/useTileGraph.ts` (lines 72-85):**

```
  const graph = useMemo(
    () => baseGraph
      ? stitchGraph(mergeGraphs([
          baseGraph,                              ← authoritative bundled copy
          ...(corridor ? [corridor.graph] : []),  ← cached, transient extensions
          ...(view ? [view.graph] : []),          ← built on-demand this session
        ]))
      : null,
    [baseGraph, corridor, view]
  );
       │
       └─ corridor/view graphs are a read-through CACHE: fetched on demand, held
          in memory, gone on reload. They are NOT a synced second copy of the
          data — there's no primary keeping them consistent. Mislabeling this as
          replication is the trap; it's caching layered on the one authoritative
          artifact.
```

**Graceful degradation of the enrichment step (not failover) — `mobile/src/useTileGraph.ts` (lines 18-28):**

```
  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return { async sample(points) {
      try { return await p.sample(points); }
      catch { return points.map(() => 0); }   ← API down → fall back to flat (0m)
    }};
  }
       │
       └─ this degrades the ELEVATION enrichment when the API fails — streets
          still render, grades fill in later. It's graceful degradation of a
          network step, NOT data-layer failover. The data layer (the bundled
          graph) has no failure mode to fail over from.
```

## Elaborate

Replication is the backbone of how databases scale reads and survive node loss,
and it's genuinely absent here — correctly, for a read-only artifact shipped in an
app bundle. The disciplined move is to refuse the easy mislabeling: independent
deploy copies are *not* replicas, and the runtime tile cache is *not* a replica
either. Calling them out by their real names (versions; read-through cache) is
more useful than pretending flattr has a replication topology it doesn't.

The transferable insight: replication's entire cost structure — lag, stale reads,
read-your-writes, failover — is downstream of having a *live shared mutable*
store. flattr avoids the cost by avoiding the cause. The same reasoning shows up
across your portfolio's local-first apps (dryrun, buffr in the system-design
portfolio): when each client holds its own copy and the canonical store is local
or build-time, the distributed-consistency problems shrink to a sync/versioning
problem, which is usually far cheaper. flattr is the extreme version — no sync at
all, just versioned redeploys.

This is the last `not yet exercised` topic. The audit (`09`) ranks all of them
together with the read-side findings.

## Interview defense

**Q: "What's the replication and read-consistency story here?"**

> There isn't one, by design. The data is a read-only artifact bundled into each
> app install, so every install has its own independent immutable copy — not a
> replica syncing to a primary. There's no replication lag, no failover, and no
> read-your-writes problem because there are no writes. The only "stale read" is
> an old app version running an older `graph.json`, which is a release-cadence
> issue, not a millisecond-lag one — and harmless for a street graph that changes
> monthly. The runtime tile builds look like replication but are a read-through
> cache on top of the one authoritative copy.

```
  N installs = N versioned copies (no sync)   tile builds = read-through cache
  "stale" = old app version (days)            no primary/replica, no lag, no failover
```

Anchor: *independent immutable copies are versions, not replicas — no sync, no lag.*

**Q: "Aren't the runtime tile builds a form of replication?"**

> No — they're a read-through cache. They fetch graph regions on demand, hold them
> in memory for the session, and discard them on reload. There's no second
> authoritative copy being kept in sync with a primary; it's transient caching
> layered on the one bundled artifact. The tell: nothing keeps them consistent
> over time, because they're thrown away, not synced.

```
  bundled graph (authoritative) + on-demand tiles (cached, discarded) ≠ replica
```

Anchor: *cached-and-discarded is a cache; synced-and-authoritative is a replica.*

## Validate

1. **Reconstruct:** explain why N app installs are "versions, not replicas" using
   the no-primary/no-sync argument.
2. **Explain:** why does the read-through tile cache in `useTileGraph.ts:72-85`
   *not* count as replication? Name the distinguishing property (no sync to an
   authoritative second copy).
3. **Apply:** flattr moves to a central writable store so users can edit edges and
   see each other's edits. Which replication concerns suddenly appear?
   (Lag, stale reads, read-your-writes, failover.)
4. **Defend:** someone says "no replication means no availability." Counter it for
   the data layer using `loadGraph.ts:7` (a local file can't go down) and
   distinguish the network enrichment path's degradation (`useTileGraph.ts:18-28`).

## See also

- `07-wal-durability-and-recovery.md` — the reproducible-artifact strategy this extends
- `01-database-systems-map.md` — the single bundled copy as the whole store
- `09-database-systems-red-flags-audit.md` — all `not yet exercised` topics ranked together
- `.aipe/study-system-design/` — the read-through tile cache as a system-design pattern
- `.aipe/study-distributed-systems/` — replication and consistency in the live-store case
