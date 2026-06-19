# audit.md — the 8-lens APOSD audit of flattr
## Pass 1: every lens walked against the real files

Eight lenses from *A Philosophy of Software Design*, each grounded in real
paths and line ranges. Where a primitive has little to bite on, the lens says
so honestly rather than manufacturing a finding. Significant findings
cross-link to the Pass 2 pattern file that walks them deeply.

---

## 1. complexity-in-this-codebase

The diagnostic overview. APOSD names three symptoms of complexity: **change
amplification** (one decision forces edits in many places), **cognitive load**
(how much you must hold in your head to work on a module), and **unknown
unknowns** (you can't tell what you'd have to touch to make a change safely).
Here's where each lives in flattr.

**Hotspot #1 — `mobile/src/useTileGraph.ts` (all three symptoms).** This is
the module nobody should want to touch. Cognitive load: the `pump()` function
(lines 89–129) juggles a `busyRef` mutex, two pending refs with priority
ordering (`pendingCorridorRef` before `pendingViewRef`), state/ref duplication
(`view`/`viewRef`, `corridor`/`corridorRef`), and a fire-and-forget async IIFE
whose `catch` swallows the error silently (lines 121–122). Unknown unknowns:
if you change how corridor and view interact, there's no single place that
encodes the priority rule — it's split across `pump`, `ensureBbox`, and
`onRegionDidChange`. → deep walk in `06-single-flight-graph-pump.md`.

**Hotspot #2 — `mobile/src/MapScreen.tsx` (cognitive load).** 406 lines, ~15
`useState`/`useMemo`/`useRef` hooks, and the route is recomputed inside a
`useMemo` (lines 143–154) that depends on five values. This is the
god-component smell. It's not *wrong* — there genuinely is one screen with a
lot of state — but it's the second-hardest file to modify safely.

**Hotspot #3 — change amplification across the signed-grade convention.** The
"grade is signed from→to" decision (`features/routing/types.ts:14–18`) is
honored in at least five places: `directedGrade` (`graph.ts:17`), `cost.ts:32`,
`astar.ts:126`, `summary.ts:16`, and `geojson.ts:55`. Each independently
recomputes "is this edge uphill in my direction of travel." That's a known
knowledge that's *almost* leaked — saved only by `directedGrade()` being the
one function they all call. → see Lens 3 and
`03-directed-traversal-over-undirected-storage.md`.

By contrast, the **engine is low-complexity**: `cost.ts` is 33 lines,
`pqueue.ts` is 78, `astar.ts` is 164 and most of that is comments. The
complexity is concentrated at the mobile/pipeline boundary, not in the graph
code that's "the point of the project."

---

## 2. deep-vs-shallow-modules

Depth = functionality ÷ interface size. Best modules: big behaviour, tiny
surface.

**Deepest module (best) — `features/routing/astar.ts`.** The public surface is
five functions, four of which are one-liners:

```
astar.ts — interface vs body

  PUBLIC SURFACE (small)          BODY (large)
  ────────────────────            ─────────────────────────────
  dijkstra(g, s, goal)            search(): lazy-deletion A*,
  astar(g, s, goal)                 closed set, g/f scores,
  gradeAstar(g, s, goal, max)       O(1) edge index,
  directedAstar(g, s, goal, max)    reconstruct(), summarizePath()
  search(g, s, goal, max,
         costFn, heuristicFn)     ← the four wrappers each just
                                    pick a (costFn, heuristicFn) pair
```

The four named algorithms (lines 136–163) are *the same function* with
different arguments. That's the deepest module in the repo. → deep walk in
`01-parametric-search-over-cost-fns.md`.

**Runner-up deep module — `features/routing/cost.ts`.** The entire grade-aware
product — downhill free, moderate uphill linear, steep uphill quadratic, over
max blocked — is one pure function `penalty(g, max, k1, k2)` (lines 16–22), 7
lines of body. The interface is "a number in, a number out." Enormous behaviour
behind a trivial surface. → `02-penalty-as-the-domain-seam.md`.

**Shallowest module (worst) — `mobile/src/loadGraph.ts`.** Eleven lines, and
the function body is a single cast: `return graph as unknown as Graph`
(line 10). The interface (`loadGraph(): Graph`) is *as complex as* the body —
there's nothing hidden. This is the textbook shallow module. **But the verdict
is: leave it.** It exists to give the bundled JSON a typed name and a single
place to document the regeneration command (lines 2–5). Folding it into the
caller would lose that documentation seam and gain nothing. A shallow module
that exists to *name a boundary* is a legitimate exception to the depth rule.

**The shallow module that should bother you more — `mobile/src/Legend.tsx` vs
`features/grade/classify.ts`.** Not shallow in the classic sense, but `Legend`
rebuilds the band labels (lines 13–18) by calling `bandsForUserMax` itself.
The labels and the bands are now decided in two layers. → Lens 3.

There is **no classitis** to report. The repo is overwhelmingly free functions;
the only class is `PQueue`, and it's deep. APOSD's "many small classes" red
flag does not fire here.

---

## 3. information-hiding-and-leakage

Find decisions known in two modules that force them to change together.

**Leak #1 (contained, the good kind) — the signed-grade convention.** "Grade is
stored from→to; flip the sign when you traverse to→from" is a fact that, left
naked, would leak into every consumer. flattr contains it in *one* function,
`directedGrade(edge, fromNodeId)` (`features/routing/graph.ts:17–19`). Every
consumer — `cost.ts:32`, `astar.ts:126`, `geojson.ts:55` — calls it instead of
writing `fromNodeId === edge.fromNode ? edge.gradePct : -edge.gradePct`
themselves. **Verdict: this is information hiding done right**, and it's the
seam worth studying. → `03-directed-traversal-over-undirected-storage.md`.

**Leak #2 (real, small) — `summary.ts` re-derives directed rise by hand.**
`routeSummary` (`features/routing/summary.ts:16`) computes
`fromNode === edge.fromNode ? edge.riseM : -edge.riseM` inline instead of a
`directedRise(edge, fromNode)` helper sitting next to `directedGrade`. The
sign-flip convention now lives in two functions in two files. **Fix:** add
`directedRise` to `graph.ts` beside `directedGrade` and call it. One-line move;
it closes the leak.

**Leak #3 (real) — the band thresholds live in two layers.** `bandsForUserMax`
(`classify.ts:41`) decides where green/yellow/red begin. `Legend.tsx:13–18`
*also* knows that green is "≤greenMax", yellow is "greenMax–yellowMax", red is
">yellowMax". If you change the band semantics in `classify.ts`, the legend
copy silently lies. **Fix:** export a `bandLabels(userMax)` from `classify.ts`
that returns the rows; `Legend` renders them. The label text is band knowledge;
it belongs with the bands.

**Leak #4 (real, build-time→run-time) — `useTileGraph.ts` knows pipeline
internals.** The hook hard-codes `MAX_SEG_M = 90` "match the ~90m free DEM"
(line 32), `DEDUPE = 0.0008` "~90m elevation sample dedup" (line 33),
`OPEN_METEO_BATCH` behaviour via `openMeteoProvider(..., { delayMs: 400,
retries: 1 })` (line 111). These are properties of the *elevation provider and
DEM*, surfaced in a *UI hook*. → `06-single-flight-graph-pump.md` for why this
is the leakiest seam in the repo.

---

## 4. layers-and-abstractions

Find pass-through methods (a method that just forwards to another at a
different layer, adding nothing) and adjacent layers offering the same
abstraction.

**Candidate pass-through — `pipeline/build-graph.ts`.** At a glance it looks
like a pass-through: `buildGraph` (lines 12–30) calls `parseOsm` → `splitWays`
→ `sampleElevations` → `computeGrades` → `buildAdjacency` and returns. But it's
**not** a pass-through — it *sequences* five stages, names the phases for the
progress callback (lines 21–28), and threads the data shape between them. It
adds ordering and a `Graph` assembly that none of the stages own. **Verdict:
the layer earns its place.** It's a clean orchestrator (Sequencer pattern), the
positive counterexample to `useTileGraph`'s pump.

**Real pass-through — `mobile/src/loadGraph.ts`.** `loadGraph()` forwards the
imported JSON with a cast and nothing else (line 10). It's a pass-through by
the letter of the definition. As Lens 2 argued, keep it: it's a *named
boundary* for the bundled artifact, not a forwarding layer in a call chain.

**No "two adjacent layers, same abstraction" smell.** The engine
(`features/`), the pipeline (`pipeline/`), and the UI (`mobile/src/`) each
offer genuinely different abstractions. `graphToGeoJSON`/`routeToGeoJSON`
(`geojson.ts`) translate the engine's `Graph`/`Path` into MapLibre's GeoJSON —
that's a real adapter at a real boundary, not a redundant layer.

---

## 5. pull-complexity-downward

Find knobs pushed up to callers that the module had enough information to
decide itself. APOSD: it's better for a module to absorb complexity than to
expose it.

**Pulled down well — `cost.ts` defaults.** `penalty(g, max, k1 = DEFAULT_K1,
k2 = DEFAULT_K2)` (`cost.ts:16`) exposes the two tuning constants but defaults
them, so 99% of callers never see them. The `gradeCostAbs`/`gradeCostDirected`
wrappers (lines 28–33) don't expose them at all. Complexity pulled down; the
knob exists for tuning but isn't in anyone's face. Good.

**Pulled down well — `buildGraph` defaults `maxSegM` and `sampleOpts`**
(`build-graph.ts:16–19`). Callers can override the segment length and dedup,
but the pipeline picks sane defaults from `config.ts`.

**Pushed up unnecessarily (minor) — `routeSummary(graph, path, _userMax)`**
(`summary.ts:11`). The third parameter is unused (`_userMax`) — the steep count
already lives on `path.steepEdges`. The knob is exposed and then ignored.
**Fix:** drop the parameter; the module has all the information it needs from
`path`.

**Borderline — `GRID_N = 16` in `MapScreen.tsx:23`.** The zone grid resolution
is decided by the screen and passed into `computeZones(graph, GRID_N)`
(line 120). `computeZones` *requires* `gridN` (`zones.ts:23`) — it can't pick a
sensible default because the right resolution depends on the bbox span, which
the screen knows. **Verdict: acceptable** — this is information the caller
genuinely has and the module doesn't. Not every parameter is a leak.

---

## 6. errors-and-special-cases

APOSD's strongest error move: **define errors out of existence** so there's no
special case to handle.

**Best example in the repo — `BLOCKED` as a large finite number**
(`features/routing/cost.ts:5`). "No flat route exists" is *not* an exception
and *not* `Infinity`. By making over-max edges cost `1e9` instead of throwing
or returning `Infinity`, the search still returns a path (the least-bad one),
and the special case "steep-but-only-option" collapses into the normal flow.
The UI then distinguishes "flattest available" (path with `steepEdges`) from
"no route" (`path === null`) — two genuinely different states, kept distinct by
*not* conflating "steep" with "disconnected." → deep walk in
`05-blocked-as-large-finite.md`. This is the cleanest design decision in the
codebase.

**Errors thrown at one obvious place (good).** `otherEnd` throws if a node
isn't an endpoint (`graph.ts:13`); `nearestNode` throws on an empty graph
(`nearest.ts:16`); `percentile` throws on empty input (`zones.ts:6`); `PQueue`
throws on a `NaN` priority (`pqueue.ts:24`). These are programmer-error guards
at the lowest sensible layer — they fail loud and early rather than returning a
silently-wrong number. Correct placement.

**Errors masked low (mixed verdict) — the mobile layer.** `bestEffortElevation`
(`useTileGraph.ts:18–28`) catches an elevation failure and returns flat (0 m)
elevation so the build still produces connected streets. That's a *deliberate*
mask: connectivity over fidelity, named in the comment (lines 16–17). Defensible.
**But** the `pump()` catch (lines 121–122) swallows *all* errors silently with
only a comment — an Overpass failure, a bug in `buildGraph`, and a network
timeout are all indistinguishable to the user and to the next developer.
**Fix:** at minimum log the caught error; better, surface a transient-error
state distinct from the loading state.

**Special-case sprawl — none significant.** The `if (startId === goalId)`
early return in `bidirectional.ts:23` is a real boundary condition, handled
once. Acceptable.

---

## 7. readability (names · comments · consistency · obviousness)

**Names — strong, ranked.** The repo names precisely: `directedGrade`,
`absGradePct`, `steepEdges`, `BLOCKED`, `bestEffortElevation`, `stitchGraph`.
No `data`/`obj`/`tmp`/`manager` smells in the engine. The weakest names are in
the mobile layer: `mu` and `meet` in `bidirectional.ts:46–47` (terse but
standard for the algorithm and commented), and `pump` in `useTileGraph.ts:89`
(evocative but you must read the body to learn it's a single-flight drainer).

**Comments — the standout strength of this repo.** flattr's comments carry the
*why* that code cannot. Examples: `cost.ts:4` explains why `BLOCKED` is finite;
`tiles.ts:2–3` explains that tiles don't share boundary nodes yet;
`astar.ts:80–84` explains why `reconstruct` uses relaxed edges, not node-pair
re-resolution (parallel edges). These are interface/rationale comments, not
restatements. **One smell:** a few comments restate the obvious, e.g.
`elevation.ts:31` "No dedup: one sample per node, in order" sits above code that
says exactly that — minor.

**Consistency — mostly good, one drift.** Adjacency is built once by
`buildAdjacency` (`graph.ts:22`) and reused everywhere. Sign-flip is *almost*
consistent (the `summary.ts` inline copy in Lens 3 is the drift). The `LatLng`
type is **redefined three times** — `lib/geo.ts:1`, `nearest.ts` imports it,
but `pipeline/elevation.ts:5` and `pipeline/split.ts:6` each declare their own
local `type LatLng = { lat: number; lng: number }`. Same shape, three
definitions. **Fix:** import the one in `lib/geo.ts` everywhere.

**Obviousness — one "huh?" spot.** `RouteSummaryCard.tsx:15–22`: the
`if (!found || !summary)` block has an inner `if (found) return null` — you
have to read it twice to see it handles "no endpoints yet" (found, no summary)
vs "no route" (not found). The double-negative-with-nested-positive is the one
genuinely non-obvious control flow in the repo. **Fix:** invert to three
explicit branches: no endpoints → null, not found → bad card, else → summary.

---

## 8. red-flags-audit

The capstone: Ousterhout's red flags as a checklist, marked against this repo,
sorted by severity for flattr.

```
  APOSD red-flag checklist — flattr, by severity

  FIRES (fix soonest)
  ───────────────────
  Information leakage      useTileGraph.ts knows DEM/Overpass        06
                           internals (lines 32–33, 111)
  Information leakage      summary.ts:16 re-derives sign-flip;       Lens 3
                           Legend.tsx:13–18 re-derives band labels
  Repetition               LatLng defined 3× (geo/elevation/split)   Lens 7
  Hard to understand       pump() single-flight + swallowed catch    06
                           (useTileGraph.ts:89–129)
  Non-obvious code         RouteSummaryCard.tsx:15–22 branch logic   Lens 7

  FIRES (minor)
  ─────────────
  Unused / exposed knob    routeSummary _userMax unused              Lens 5
  Comment repeats code     elevation.ts:31                           Lens 7

  DOESN'T FIRE (genuinely clean)
  ──────────────────────────────
  Shallow module           engine modules are deep (astar, cost,     01,02
                           pqueue)
  Classitis                almost no classes; the one (PQueue)       04
                           is deep
  Pass-through method      build-graph orchestrates, doesn't         Lens 4
                           forward
  Special-case sprawl      BLOCKED defines the main one out          05
  Conjoined methods        engine functions are independent          —

  N/A (repo too small/uniform to exercise)
  ────────────────────────────────────────
  Deep inheritance         no class hierarchy exists                 —
  Temporal decomposition   pipeline is data-flow, not time-ordered   —
                           god-objects
```

### Top 3 fixes, ranked across the whole repo

1. **Tame `useTileGraph.ts`.** Extract the build-time knobs (`MAX_SEG_M`,
   `DEDUPE`, provider options) into the pipeline where they belong, and stop
   swallowing the `pump` catch silently. This is the leakiest, hardest-to-touch
   module. → `06`.
2. **Close the two sign/label leaks.** Add `directedRise` to `graph.ts`
   (kills the `summary.ts` copy) and `bandLabels` to `classify.ts` (kills the
   `Legend.tsx` copy). Two small moves, two fewer places to keep in sync.
3. **Collapse the three `LatLng` definitions** into the one in `lib/geo.ts`.
   Pure cleanup, removes a repetition red flag.

The engine itself needs no fixes — it's the model the rest of the repo should
aspire to. That's the real headline of this audit.
