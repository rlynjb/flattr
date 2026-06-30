# Overview — Debugging & Observability in flattr

One page to orient before the audit. Where can you *see* what flattr is doing,
where can't you, and what's worth studying first.

## The evidence map — where behavior surfaces

flattr has three live runtimes and they observe themselves very differently.
Here's the whole thing in one frame, with each boundary labelled by what
evidence crosses it.

```
  flattr — what can be observed at each boundary

  ┌─ BUILD-TIME (Node CLI) ────────────────────────────────────────┐
  │  pipeline/run-build.ts                                          │
  │   console.log "Fetching OSM…", "Wrote N nodes, M edges"         │ ← stdout only,
  │   console.warn "Elevation: FLAT (0m)"   console.error(err)      │   not persisted
  └───────────────────────────┬────────────────────────────────────┘
                              │ writes static artifact: graph.json
                              ▼
  ┌─ TEST / BENCH (Node) ──────────────────────────────────────────┐
  │  bench/run.ts → prints expanded/pushes/pops/ms/cost table       │ ← MEASURED
  │  astar.test.ts → A*.cost == Dijkstra.cost (optimality oracle)   │   evidence,
  │  search() counts nodesExpanded / pushes / pops as it runs       │   on demand
  └───────────────────────────┬────────────────────────────────────┘
                              │ same engine, synced into mobile/
                              ▼
  ┌─ RUNTIME (Expo / React Native app) ────────────────────────────┐
  │  useTileGraph.ts: degraded flag on flat-fallback regions        │ ← IN-BAND only
  │  RouteSummaryCard.tsx: "Flat all the way" / "⚠ Flattest         │   (rendered to
  │   available" / "No route between those points"                  │   the screen),
  │  MapScreen.tsx: "Grades approximate — elevation unavailable"    │   nothing logged
  └────────────────────────────────────────────────────────────────┘
        ▲                                              ▲
        │  catch {} swallows Overpass/elevation errors │  no console, no
        │  (useTileGraph.ts:219, MapScreen.tsx:86)     │  Sentry, no crash report
```

The pattern jumps out: **evidence is richest exactly where it's cheapest to
produce in-band, and absent everywhere it would need to be persisted.** The
search counts its own work for free (three integer increments). The UI paints
honesty signals for free (it's rendering anyway). But nothing is written to a
log, a metric, or an error tracker — so the moment the app is on a real phone
and a route is wrong, the only evidence is what the user can see on screen.

## Ranked findings — what to study first

1. **Search instrumentation counters** (`01-`) — the most load-bearing
   observability mechanism in the repo. `nodesExpanded / pushes / pops` are
   threaded straight through the A* loop (`astar.ts:35-77`) and read by the
   bench (`bench/run.ts`). This is how "is A* actually pruning?" becomes a
   measured number instead of a belief. **Measured:** A* expands 32 nodes where
   Dijkstra expands 203 on grid30 — 6.3× fewer, same cost.

2. **The optimality oracle** (`02-`) — `astar.test.ts:38` asserts A*'s cost
   *equals* Dijkstra's. A differential probe: the simple-but-slow algorithm is
   the reference oracle for the fast-but-subtle one. The single highest-value
   correctness signal in the codebase.

3. **Degrade-and-surface at the network seam** (`03-`) — elevation 429 → flat
   fallback → `degraded` flag → user-visible "Grades approximate" note
   (`useTileGraph.ts:20-30, 75, 209-218` → `MapScreen.tsx:375`). The repo's one
   end-to-end "a failure became visible" chain.

4. **Finite `BLOCKED` as a diagnostic** (`04-`) — `BLOCKED = 1e9`, not
   `Infinity` (`cost.ts:5`). This single choice keeps two failure states
   distinguishable: "no flat route" (returns a path, flags steep edges) vs "no
   route at all" (returns `null`). Conflate them and you can't tell a user
   anything true.

5. **Curl-the-API-first** (`05-`) — a documented operational discipline
   (`.aipe/project/context.md`, user memory): probe Open-Meteo with `curl`
   before debugging your own pipeline, because a 429 masquerades as a grade bug.
   Instruments the *human* process, not the code.

## What's `not yet exercised` (honest gaps)

These are real observability capabilities the repo does not have. The audit's
red-flags lens ranks them by consequence; here's the short list with triggers.

| Capability | State | Becomes relevant when… |
|---|---|---|
| Structured logging (levels, fields, JSON) | `not yet exercised` — only raw `console.log` in two build scripts | the app ships and you need to know what happened on a user's device |
| Metrics / SLIs / SLOs / alerts | `not yet exercised` — counters exist but are printed, never aggregated | route latency or fallback rate needs a threshold that pages someone |
| Distributed traces / spans | `not yet exercised` — no request lifecycle crosses a service | a backend is added and one request fans out across services |
| Error tracking / crash reporting | `not yet exercised` — runtime errors are `catch {}`-swallowed | a crash on a real phone has to reach you, not just disappear |
| Correlation IDs | `not yet exercised` — no request to correlate | concurrent route requests need to be told apart in evidence |

None of these are *bugs*. flattr is a pre-backend, single-artifact app — most of
this infrastructure has nothing to instrument yet. The honest framing: the
in-band signals are well-designed for what exists; the persistence layer of
observability simply hasn't been reached.

## How to read the rest

`audit.md` walks all eight lenses and is the systematic record. The pattern
files go deep on the five mechanisms above. If you only read two things, read
`01-search-instrumentation-counters.md` and `03-degrade-and-surface.md` — they
are the two ends of the spectrum: free in-band measurement, and a failure made
visible end-to-end.
