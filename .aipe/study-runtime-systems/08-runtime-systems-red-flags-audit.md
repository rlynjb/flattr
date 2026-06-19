# Runtime systems red-flags audit

*Ranked execution-model risks, grounded in the repo.*
**Type:** Project-specific (audit).

## Zoom out, then zoom in

Every concept file in this guide taught one part of flattr's execution
model. This file ranks the *risks* in that model by consequence and names
the evidence for each. The verdict from `00-`: flattr's runtime is clean
and simple, and its risks cluster in one spot — **synchronous CPU on the
interactive thread, plus the absence of cancellation.** Nothing here is a
correctness bug today; they're all "becomes a problem when X grows" risks,
and X is the same thing every time: the graph size.

```
  Zoom out — where the risks live, by severity

  ┌─ RUN process · JS thread ────────────────────────────────┐
  │  ★ R1 sync A* freezes UI (HIGH)        ★                  │
  │  ★ R2 no cancellation (MEDIUM)         ★                  │
  │  ★ R3 unbounded merged graph (MEDIUM)  ★                  │
  │  ★ R4 O(N) nearestNode in render (LOW) ★                  │
  └──────────────────────────────────────────────────────────┘
  ┌─ BUILD process ──────────────────────────────────────────┐
  │  ★ R5 no deadlines/shutdown (LOW, latent) ★               │
  └──────────────────────────────────────────────────────────┘

   all five share one trigger: the graph getting bigger
```

Zoom in: the question is *what breaks first, and what's the evidence?*
Read top to bottom — R1 is the one to fix first.

## Structure pass

**Axis — consequence under load.** The single axis that ranks these is
"what happens as the graph grows?" Trace it: the sync search gets slower
(R1, freeze), wasted builds get more expensive (R2), the heap grows more
(R3), the linear scan gets slower (R4). They're not independent — they're
the same pressure hitting four different mechanisms.

**Seam.** The load-bearing boundary for all of this is the **JS thread**
in the run process. Every HIGH/MEDIUM risk is something competing for that
one thread or growing the data it processes. The build process (R5) is a
separate, lower-stakes seam because it's offline and single-use.

```
  Layered decomposition — "what's the blast radius?" per risk

  ┌───────────────────────────────────────────────┐
  │ R1 sync search    → UI freeze (user-visible)   │ HIGH
  ├───────────────────────────────────────────────┤
  │ R2 no cancel      → wasted work, latency        │ MEDIUM
  │ R3 no eviction    → memory growth over session  │ MEDIUM
  ├───────────────────────────────────────────────┤
  │ R4 O(N) scan      → render lag (small constant) │ LOW
  ├───────────────────────────────────────────────┤
  │ R5 no deadline/shutdown → latent, offline       │ LOW
  └───────────────────────────────────────────────┘
```

## How it works — the ranked risks

### Move 1 — the mental model

Read this like a triage list: each risk has a severity, the evidence
(`file:line`), the trigger that makes it bite, and the fix. The severity
is "consequence × likelihood given where flattr is headed." A HIGH is
user-visible and on the likely growth path; a LOW is real but contained or
latent.

```
  Pattern — the triage shape per risk

  [ risk ] ──► severity ──► evidence (file:line) ──► trigger ──► fix
              (consequence    (proof it's real)     (when it     (the move)
               × likelihood)                          bites)
```

### Move 2 — the risks, ranked

#### R1 — Synchronous A* runs on the UI's JS thread · HIGH

The search has no yield points and is called in a render-time `useMemo`,
so a long search freezes React for its full duration.

```
  Evidence + blast radius

  features/routing/astar.ts:48   while (!open.isEmpty()) { ... }  ← no await
  mobile/src/MapScreen.tsx:147   directedAstar(graph, ...) in useMemo
        │
        └─ search runs synchronously during render → JS thread held →
           dropped frames → frozen markers/route/overlays (not base tiles)
```

- **Trigger:** the merged graph grows (via `useTileGraph` panning/routing)
  until one search exceeds a frame budget (~16ms).
- **Why it's HIGH:** user-visible freeze, and the growth path
  (`useTileGraph` exists specifically to grow the graph) makes it likely.
- **Fix:** chunk the `while` loop — run K expansions, `await
  setTimeout(0)`, continue; or gate the `useMemo` behind
  `InteractionManager.runAfterInteractions`; worker only if those aren't
  enough. → `02-`, `03-`.
- **Why it's fine today:** the bbox is deliberately tiny (`config.ts:10`),
  so searches are sub-frame.

#### R2 — No cancellation of in-flight builds · MEDIUM

A superseded build runs to completion — full Overpass + elevation + CPU —
before the next request is serviced.

```
  Evidence

  mobile/src/useTileGraph.ts:108  await fetchOverpass(bbox)   ← no abort signal
  mobile/src/useTileGraph.ts:123-127  finally { busyRef=false; pump(); }
        │
        └─ user pans/re-routes mid-build → stale build still finishes →
           wasted network + CPU → THEN pump() drains the now-current request
```

- **Trigger:** slow builds (big graph or slow network) + users changing
  their mind mid-flight.
- **Why it's MEDIUM:** wasted work and added latency, not a correctness
  bug; the stale result is correctly superseded, just expensive.
- **Fix:** `AbortController` per build, `signal` threaded into
  `fetchOverpass`/elevation `fetchImpl`, `abort()` when superseding;
  `signal.aborted` checks between elevation batches. → `07-`.

#### R3 — Merged graph grows without eviction · MEDIUM

Every build merges a region into the live graph; nothing ever evicts old
coverage, so the heap grows with explored area.

```
  Evidence

  mobile/src/useTileGraph.ts:72-85   mergeGraphs([base, corridor, view])
  features/map/tiles.ts:89-108       Object.assign all nodes/edges, no removal
        │
        └─ bounded to base + 2 LATEST regions (last-write-wins, 04-), but
           each region can be large and base coverage is never trimmed →
           merged graph only grows over a long session
```

- **Trigger:** an extended session panning/routing across a wide area.
- **Why it's MEDIUM:** gradual memory growth + secondary effect of making
  R1/R4 worse (bigger graph → slower search/scan).
- **Fix:** eviction policy — LRU on regions, or drop regions outside the
  current viewport + margin; cap merged node count. → `05-`.

#### R4 — `nearestNode` is an O(N) scan run in render · LOW

A linear scan over every node, called in a `useMemo` on every graph
change, twice (start + end).

```
  Evidence

  features/routing/nearest.ts:8   for (const id of Object.keys(graph.nodes))
  mobile/src/MapScreen.tsx:125-126  nearestNode(graph, startPt/endPt) in useMemo
        │
        └─ O(N) with a haversine (trig) per node, ×2, re-run whenever the
           merged graph changes (i.e. every tile load)
```

- **Trigger:** large merged graph + frequent re-snaps as tiles load.
- **Why it's LOW:** small constant factor, and it only runs on graph
  change, not per frame; dominated by R1 if the graph is large enough to
  matter.
- **Fix:** a spatial index (grid bucket or k-d tree) built once per graph
  version; or memoize harder so it doesn't re-run on unrelated state
  changes. → `02-`, `05-`.

#### R5 — No deadlines or graceful shutdown (build process) · LOW (latent)

The build CLI has no `SIGTERM` handler, no drain, and no per-fetch
deadline beyond Overpass's server-side `timeout:60`.

```
  Evidence

  pipeline/run-build.ts:54-57   main().catch(err => { process.exitCode = 1; })
  pipeline/overpass.ts:11       [out:json][timeout:60];   ← server-side only
        │
        └─ no client deadline on fetch; no shutdown drain — fine for a manual,
           single-shot CLI, but no protection if it ran unattended/long
```

- **Trigger:** running the pipeline unattended, on a schedule, or as a
  service serving concurrent users — none of which exist today.
- **Why it's LOW:** the build is a manual, single-user, offline CLI; the
  failure mode (hang, no clean exit) costs nothing in the current usage.
- **Fix:** `AbortSignal.timeout()` on fetches; a `SIGTERM` handler that
  finishes the current write and exits — only worth it if the build
  becomes a service. → `07-`.

### Move 3 — the principle

flattr's runtime risks aren't scattered bugs — they're **one design choice
(do live work on the interactive thread over a growing in-memory graph)
viewed through four lenses.** Fix the root (keep the graph small *or*
move/chunk the work off the render thread) and three of the five risks
shrink at once. That's the payoff of a runtime audit: the ranking reveals
that R1, R3, and R4 share a cause, so you fix a cause, not four symptoms.

## Primary diagram

The full audit — five risks, their shared trigger, and the one root fix.

```
  flattr runtime risk map — shared root, ranked

  ROOT CHOICE: live work on the JS thread over a GROWING in-memory graph
        │
        ├──► R1 sync A* in render        HIGH    astar.ts:48 / MapScreen:147
        │      → UI freeze                        fix: chunk/yield/worker
        ├──► R3 no graph eviction         MEDIUM  useTileGraph:72 / tiles:89
        │      → heap growth (feeds R1/R4)        fix: LRU eviction
        ├──► R4 O(N) nearestNode          LOW     nearest.ts:8 / MapScreen:125
        │      → render lag                        fix: spatial index
        │
        ├──► R2 no cancellation           MEDIUM  useTileGraph:108,123
        │      → wasted builds                     fix: AbortController
        └──► R5 no deadline/shutdown      LOW      run-build.ts:54 (latent)
               → build hang (offline)             fix: AbortSignal.timeout

  one trigger (graph grows) lights up R1/R3/R4 together → fix the root first
```

## Implementation in codebase — the evidence index

**Use cases.** Open this audit before any perf work on flattr: it tells
you R1 is where a "the app freezes when I route" report comes from, and R3
is where "it gets slow after I've been panning a while" comes from.

Quick evidence index for each verdict:

```
  risk  file:line                        the smoking gun
  ────  ───────────────────────────────  ──────────────────────────────
  R1    features/routing/astar.ts:48     `while` loop, zero `await`
        mobile/src/MapScreen.tsx:143-147 directedAstar inside useMemo
  R2    mobile/src/useTileGraph.ts:108   await fetchOverpass — no signal
        mobile/src/useTileGraph.ts:123   finally drains AFTER full run
  R3    mobile/src/useTileGraph.ts:72-85 mergeGraphs, no eviction
        features/map/tiles.ts:89-108     Object.assign, no removal
  R4    features/routing/nearest.ts:8    for-over-all-nodes + haversine
        mobile/src/MapScreen.tsx:125-126 nearestNode ×2 in useMemo
  R5    pipeline/run-build.ts:54-57      catch → exitCode, no drain
        pipeline/overpass.ts:11          server-side timeout only
```

## Elaborate

A runtime red-flags audit is most useful when it refuses to list symptoms
as if they were independent. The professional move here is the grouping in
the Primary diagram: R1, R3, and R4 are *the same root* (growing graph +
work on the render thread) and R2/R5 are the *cancellation/lifecycle* family
(work that can't be stopped). That maps to two fixes, not five: (1) keep
the interactive-thread work bounded — small graph, or chunked/off-thread
search, plus eviction; (2) make in-flight work cancellable and
deadline-bounded. Sequence them by severity: R1 first (user-visible),
then R2/R3 together (they compound), R4/R5 last. Read `02-` and `07-` for
the fixes, and
[`.aipe/study-performance-engineering/`](../study-performance-engineering/)
for how the bench harness can *measure* R1 before you fix it.

## Interview defense

**Q: "What's the biggest runtime risk in this codebase?"**

The synchronous A* search on the UI thread. It's a `while` loop with no
yield (`astar.ts:48`) called in a render-time `useMemo`
(`MapScreen.tsx:147`), so a long search freezes React. It's safe today
only because the bbox is tiny (`config.ts:10`), but `useTileGraph` exists
to grow the graph — so it's on the likely path to biting. Fix is to chunk
the loop with `setTimeout(0)` yields or gate it behind
`InteractionManager`.

```
  big graph ──► long sync search ──► JS thread held ──► UI freeze
```

Anchor: *"Synchronous CPU on the render thread spends the UI's frame
budget — the search and the repaint can't both have it."*

**Q: "Three of your five risks share a root cause — what is it, and why
does that matter?"**

R1 (freeze), R3 (heap growth), R4 (O(N) scan) all worsen as the merged
graph grows (`useTileGraph.ts:72-85`). That matters because it means one
fix — bound the graph (eviction) and/or move the work off the render
thread — addresses all three. The audit's job is to surface that the
symptoms aren't independent, so you fix a cause, not a list.

```
  graph grows ──► R1 slower, R3 bigger, R4 slower (all at once)
                  ──► one root fix shrinks all three
```

Anchor: *"Audit by root cause, not by symptom — R1/R3/R4 are one choice
seen three ways."*

## Validate

**Reconstruct.** From memory, list the five risks with severity and the
shared trigger. Group them into the two fix-families (interactive-thread
work; cancellation/lifecycle). Check against the Primary diagram.

**Explain.** Why is R5 (no shutdown/deadline) LOW while R2 (no
cancellation) is MEDIUM, when both are "can't stop work"? (R5 is in the
offline, single-shot build process where a hang costs nothing —
`run-build.ts:54`; R2 is in the interactive app where wasted builds add
user-facing latency — `useTileGraph.ts:108`.)

**Apply.** You can fix exactly one risk this sprint. Which, and why? (R1 —
it's the only HIGH, user-visible, and fixing it via chunking/yielding also
makes the path toward cancelling the search (`07-`) easier;
`astar.ts:48`.)

**Defend.** Argue that none of these are bugs to fix *right now* if the
bbox stays small. (All five trigger on graph growth or unattended/concurrent
use, neither of which the current single-user, tiny-bbox app exercises —
`config.ts:10`. They're correctly deferred until `useTileGraph` coverage
actually grows.)

## See also

- `00-overview.md` — the same findings in narrative form
- `02-processes-threads-and-tasks.md` — R1, R4 mechanism + fixes
- `05-memory-stack-heap-gc-and-lifetimes.md` — R3 eviction
- `07-backpressure-bounded-work-and-cancellation.md` — R2, R5 fixes
- [`.aipe/study-performance-engineering/`](../study-performance-engineering/) — measuring R1
