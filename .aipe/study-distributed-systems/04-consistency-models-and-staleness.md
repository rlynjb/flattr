# Consistency models and staleness
### stale snapshots, best-effort degradation, and the availability-over-consistency choice
**Industry name:** eventual consistency, staleness, CAP availability-vs-consistency, graceful degradation · **Type:** Industry standard

## Zoom out, then zoom in

flattr makes one genuine consistency *decision*, and it's the most quotable distributed-systems moment in the repo: when the elevation API is down, **render the streets with flat (0m) grades rather than fail the build.** That's availability chosen over consistency, made concrete in eight lines. The rest of the consistency story is `barely exercised` — the bundled `graph.json` is a stale snapshot nobody reads back from a live source. Both are worth seeing clearly.

```
  Zoom out — where consistency choices live

  ┌─ UI layer (the phone) ──────────────────────────────────────┐
  │  map renders whatever graph state exists — flat or graded    │
  └───────────────────────────┬─────────────────────────────────┘
  ┌─ Coordination layer ──────▼─────────────────────────────────┐
  │  ★ bestEffortElevation: degrade to 0m on failure ★          │ ← we are here
  │    merged Graph = base(stale) + corridor + view             │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK ═══
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  Open-Meteo (source of truth for elevation; may be 429/down) │
  │  bundled graph.json (a frozen COPY, possibly months stale)   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"when I can't get fresh, correct data, what do I show?"* Two flavors here. Live: Open-Meteo is throttled mid-build — show flat grades now, fill them in later (eventual consistency via re-fetch). Snapshot: the app ships a `graph.json` built weeks ago — every read is a stale read, and that's fine because streets don't move much. Both are deliberate trades of *freshness/correctness* for *availability*.

## Structure pass

**Layers.** UI (renders any graph) → coordination (`bestEffortElevation`, the merged-graph `useMemo`) → providers (Open-Meteo as truth; `graph.json` as frozen copy).

**The axis: guarantees — "how fresh / correct is what the user sees, and what's promised?"** Trace it:

```
  One question — "how fresh is this data, and what's guaranteed?" — traced

  ┌──────────────────────────────────────┐
  │ base graph.json (bundled)             │  → STALE snapshot. guarantee:
  └──────────────────────────────────────┘    "streets as of build day"
      ▼  merged with
  ┌──────────────────────────────────────┐
  │ live tile fetch (Overpass+elev)       │  → FRESHER, but elevation may be
  └──────────────────────────────────────┘    DEGRADED to flat (best-effort)
      ▼  rendered as
  ┌──────────────────────────────────────┐
  │ what the user sees                    │  → EVENTUALLY consistent: grades
  └──────────────────────────────────────┘    converge on a later successful load
```

**The seam.** The seam is inside `bestEffortElevation`: above it, the caller is *promised* a number for every point (the call never throws); below it, that number may be real or a degraded `0`. The contract flips from "correct elevation" to "an elevation, possibly flat." That single `try/catch` is where flattr chooses A over C in CAP.

## How it works

#### Move 1 — the mental model

You know this from optimistic UI: render *something* immediately, reconcile when the real data arrives. flattr's version is "render the streets even if the grades aren't ready, and let grades converge later."

```
  The degradation shape — never block on the weakest dependency

   elevation OK ──► graded graph ──► colored route   (full fidelity)
        │
   elevation 429 ──► flat graph ──► gray route        (degraded, still usable)
        │                              │
        └──────────── later pan ───────┘
                  re-fetch ──► grades fill in (converge)
```

The key move: a *non-critical* dependency (elevation) failing must not take down a *critical* capability (showing streets, finding a path). You sever the weak dependency and keep the strong one.

#### Move 2 — the load-bearing skeleton

The kernel here is the degradation wrapper. Isolate it and name each part by what breaks without it.

**Part 1 — the wrap (it catches at the dependency boundary).** Bridge from a `try/catch` around a `fetch`. `bestEffortElevation` wraps *any* `ElevationProvider` and turns a thrown failure into a vector of zeros. *What breaks if removed:* the elevation failure propagates up through `buildGraph` and the whole tile build throws — caught at `pump`'s catch (`useTileGraph.ts:121`), which keeps the *last* region and shows nothing new. So without the wrap, a throttled elevation API means a frozen screen on pan; with it, you get the streets immediately, just gray.

```
  bestEffortElevation — sever the weak dependency, keep the strong one

   provider.sample(points)
        │
     try├──── success ──► [real elevations]  ──► graded
        │
     catch──── failure ──► points.map(()=>0) ──► FLAT (degraded)
                              │
                              └─ the build PROCEEDS either way.
                                 streets + routing survive; only color is lost.
```

**Part 2 — convergence (a later read repairs it).** Bridge from SWR's revalidation. The flat region isn't permanent — the next pan or route that isn't already `covers()`-ed triggers a fresh build, and if Open-Meteo has recovered, grades fill in. *What breaks if removed (i.e. if flat were cached forever):* the degradation becomes permanent corruption instead of a temporary blur. Convergence is what makes "eventual consistency" the right label rather than "data loss."

**Part 3 — the stale snapshot (the always-on baseline).** Bridge from a static asset import. The bundled `graph.json` is a frozen copy of the streets+grades as of build day, loaded with zero network (`loadGraph.ts`). *What breaks if removed:* a cold-start with no connectivity shows an empty map. The snapshot is the floor of availability — it guarantees *something* renders even fully offline, at the cost of being stale. Streets rarely change, so the staleness window can be huge without harm; this is a deliberate freshness-for-availability trade.

#### Move 2.5 — current vs future consistency story

Today consistency is trivial because there's one reader and one (frozen or best-effort) copy. The spec's §11 D2/E2 server-side served graph changes that:

```
  Phase A (now) vs Phase B (§11 D2/E2 served graph)

  NOW                              SERVED GRAPH
  ───                              ────────────
  one bundled snapshot per app     graph rebuilt server-side, many readers
  staleness = "since build day"    staleness = "since last rebuild" + cache TTL
  no read-your-writes question      read-your-writes appears: did my route
  (you can't write anything)        use the graph I just triggered a rebuild of?
  degrade-to-flat is the only       cache invalidation, ETags, versioned graph
  consistency mechanism             artifacts become real concerns
```

The takeaway is *what doesn't change*: `bestEffortElevation` and the merge-and-stitch model survive untouched. Only the *source* of the base graph moves from a bundled file to a served, versioned artifact — and that's where staleness stops being free.

#### Move 3 — the principle

Consistency is a *choice you spend availability on*. flattr spends almost none on it and gets a system that's always usable: a stale-but-present snapshot floor, plus live fidelity when the network cooperates and graceful blur when it doesn't. The general rule: **rank your dependencies by criticality, and never let a non-critical one (grades) take down a critical one (streets).** The `try/catch` that returns zeros is that ranking, executed.

## Primary diagram

Everything in one frame — snapshot floor, live merge, degradation, convergence.

```
  flattr consistency model — recap

  ┌─ always available (offline floor) ──────────────────────────┐
  │  loadGraph() → bundled graph.json   (STALE snapshot)        │
  └───────────────────────────┬─────────────────────────────────┘
                              │ merged + stitched with ▼
  ┌─ live, best-effort ───────▼─────────────────────────────────┐
  │  pump(): fetchOverpass(bbox)  ──► streets (fail ⇒ skip)     │
  │          bestEffortElevation  ──► grades  (fail ⇒ FLAT 0m)  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ render ▼              ┌── later pan ──┐
  ┌─ what the user sees ──────▼─────────────────────┐ │  re-fetch     │
  │  streets always; grades real OR temporarily gray│◄┘  converge ────┘
  └──────────────────────────────────────────────────┘
   CAP: Availability chosen over Consistency at the elevation boundary.
```

## Implementation in codebase

**Use cases.** `bestEffortElevation` is reached on *every* runtime tile build (`useTileGraph.ts:111`) — it's the default runtime posture, not an exception path. The stale snapshot is read on every cold start (`loadGraph.ts:9`). Build-time has its own floor: `FLAT_ELEVATION=1` (`run-build.ts:28-31`) for fully-offline synthetic builds.

The degradation wrapper — the single most important consistency decision:

```
  mobile/src/useTileGraph.ts  (lines 18–28, bestEffortElevation)

  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return {
      async sample(points) {
        try {
          return await p.sample(points);     ← happy path: real elevations
        } catch {
          return points.map(() => 0);         ← degrade: flat for every point
        }
      },
    };
  }
       │
       └─ the catch is the CAP choice. without it, an elevation 429 throws up
          through buildGraph and the screen shows no new streets on pan.
          with it, streets render immediately; grades are temporarily 0.
```

Wired with deliberate impatience so degradation happens *fast*:

```
  mobile/src/useTileGraph.ts  (line 111)

  const elev = bestEffortElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 }));
       │                                                                   └─ only 1 retry
       └─ retries:1 (vs build-time default 3) so a doomed 429 backoff gives up in
          ~1 attempt and degrades to flat quickly, instead of stalling the screen
          on multi-second backoffs. impatience IS the runtime availability tuning.
```

The stale-snapshot floor:

```
  mobile/src/loadGraph.ts  (lines 7–11)

  import graph from "../assets/graph.json";   ← frozen copy, bundled in the binary
  export function loadGraph(): Graph { return graph as unknown as Graph; }
       │
       └─ zero network. every read is stale-by-construction. correct because
          streets don't move; the staleness window can be weeks without harm.
```

## Elaborate

This is the CAP theorem at its most concrete. CAP says under a partition (here: the elevation API is unreachable) you pick Consistency or Availability. flattr picks A every time: a degraded-but-present graph beats a correct-but-absent one, because a routing app that shows nothing is useless while one that shows gray streets is fine. The `bestEffortElevation` catch is the partition-handling branch.

The deeper pattern is **dependency criticality ranking** — the discipline of asking, per dependency, "if this is down, do I fail or degrade?" Streets (Overpass) are critical: no streets, no map, so that path *fails* (skip + retry). Grades (elevation) are enhancement: degrade to flat. Getting that ranking right is the whole art; flattr's is correct because the product still works flat (you can route, just not grade-optimally).

Where staleness gets teeth: the served-graph future (§11 D2/E2). Once the base graph is fetched from a server rather than bundled, you inherit cache-invalidation and versioning — "is the graph I'm routing on the latest rebuild?" — and read-your-writes if a user can trigger a rebuild. That's the boundary where flattr's currently-free consistency story starts costing something. Read next: `05` (replication, which is what makes a served graph stay available) and `08` (the rebuild-as-workflow).

## Interview defense

**Q: "What happens when your elevation API is rate-limited mid-use?"**
I degrade, I don't fail. `bestEffortElevation` wraps the provider in a try/catch that returns flat 0m elevations on any failure — so the streets still render and routing still connects, just without grade coloring. Grades converge on a later pan once the API recovers. That's a deliberate CAP choice: availability over consistency, because a routing app showing gray streets is useful and one showing nothing is not. And I tune it for *fast* degradation at runtime — `retries: 1` so a doomed backoff gives up quickly instead of freezing the screen.

```
   elevation 429 ──► catch ──► flat grades ──► usable (gray) map
                                   │
                          later pan ──► converge to real grades
   streets (critical) FAIL on error; grades (enhancement) DEGRADE.
```
*Anchor: rank dependencies by criticality; never let an enhancement take down the core.*

**Q: "Your app ships a months-old graph snapshot. Isn't that a consistency bug?"**
It's a deliberate freshness-for-availability trade, and it's correct for this data. Streets and elevation barely change over months, so a stale snapshot is functionally identical to a fresh one — and it buys a fully-offline floor: the map renders with zero network on cold start. The staleness only becomes a real concern if the base graph moves server-side (spec §11 D2), at which point I'd add versioned artifacts and cache TTLs. *Anchor: staleness is free when the underlying data is near-static.*

## Validate

1. **Reconstruct:** draw flattr's three consistency layers (snapshot floor, live best-effort, convergence). Which one guarantees the map renders offline?
2. **Explain:** why does `useTileGraph.ts:111` use `retries: 1` while build-time elevation uses 3? Frame it as an availability tuning.
3. **Apply:** Open-Meteo is hard-down for an hour. Trace `bestEffortElevation` (`:18-28`) → what does the user see, can they still route, and what happens when the API recovers and they pan?
4. **Defend:** the spec moves the base graph to a server (§11 D2). Argue exactly which consistency concerns appear that don't exist today, and which existing mechanisms (`bestEffortElevation`, merge/stitch) survive unchanged.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the exhausted retries that trigger degradation.
- `03-idempotency-deduplication-and-delivery-semantics.md` — the idempotent reads that make convergence safe.
- `05-replication-partitioning-and-quorums.md` — what keeps a *served* graph available (mostly `not yet exercised`).
- `.aipe/study-database-systems/` — the `graph.json` snapshot as a read-only store and its consistency story.
