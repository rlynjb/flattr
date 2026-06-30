# audit.md — the 8-lens APOSD audit

Pass 1. Every lens from *A Philosophy of Software Design* walked against
flattr's real files, with `file:line` grounding. Lenses that don't bite
say `not yet exercised` honestly. The capstone `red-flags-audit` at the
bottom is the actionable index — read it last, act on it first.

Source for the primitives: *A Philosophy of Software Design*, John
Ousterhout. Concepts taught in original words; the product here is the
findings about your code.

---

## 1. complexity-in-this-codebase

The diagnostic zoom-out. APOSD names three symptoms of complexity:
**change amplification** (one decision forces edits in many places),
**cognitive load** (how much you must hold in your head to touch a
module), and **unknown-unknowns** (you can't tell what a change will
break). Here's where each lives in flattr.

**Change amplification — the DEM cell-key formula (highest).**
`pipeline/elevation.ts:42` and `mobile/src/useTileGraph.ts:36` both
encode the same fact — "how to quantize a lat/lng into a ~90 m elevation
cell":

```
  elevation.ts:42   `${Math.round(lat / prec)},${Math.round(lng / prec)}`
  useTileGraph.ts:36 `${Math.round(lat / DEDUPE)},${Math.round(lng / DEDUPE)}`
```

Change the quantization in one and forget the other and the runtime
elevation cache silently stops hitting the build-time cells — no error,
just a quota-burning re-fetch of data you already had. One decision,
two edit sites. → lens 3 walks this as leakage.

**Cognitive load — `useTileGraph.ts` (highest).** 290 lines, eleven
`useRef`s, a hand-rolled single-flight queue (`pump`), a debounce, a
self-heal retry loop, two derived `useMemo` graphs, and three nested
elevation wrappers (`bestEffortElevation(cachedElevation(openMeteo…))`).
It's the one module in the repo you'd want a diagram open for before
editing — and `06-single-flight-graph-pump.md` is that diagram. The load
is real but mostly *essential*: it's coordinating live network builds
under rate limits. The one piece of *accidental* load is the duplicated
cell-key above.

**Unknown-unknowns — lowest, and that's the praise.** The routing core
is built so a change *can't* surprise you: `search()` never mentions
grade, so editing the penalty curve in `cost.ts` cannot break the search
loop. That's information hiding doing its job (lens 3). The whole point
of the seams in `00-overview.md` is to shrink this symptom to near zero
in the core.

**Hotspots ranked:**
1. `mobile/src/useTileGraph.ts` — highest cognitive load (essential).
2. The cell-key duplication (`elevation.ts:42` + `useTileGraph.ts:36`)
   — highest change amplification (accidental, fixable).
3. `edgeById` O(E) callers (`summary.ts:14`, `geojson.ts:53`) — a
   performance smell that's also a design one (lens 4 / lens 8).

---

## 2. deep-vs-shallow-modules

Depth = functionality hidden ÷ interface size. Deep is good: big
behaviour, tiny surface. Shallow is the smell: the interface costs
nearly as much as just writing the body inline (classitis).

**Deepest module — `search()` in `features/routing/astar.ts:22`.** The
interface is six parameters and it returns a path plus metrics. Behind
that surface: a binary-heap frontier, a closed set, lazy-deletion
stale-skipping, g-score relaxation, came-from reconstruction that
preserves parallel edges, and path summarization. One function, ~55
lines, hides the entire shortest-path machine. And because the cost and
heuristic are *arguments*, the same body is Dijkstra, A*, grade-A*, and
directed-A* — four algorithms behind one interface (`01`). That's about
as deep as a module gets in this repo.

**Runner-up — `penalty()` in `features/routing/cost.ts:16`.** Five
lines, two parameters. Hides the entire grade model: free downhill,
linear moderate band, quadratic steep band, large-finite block, and
C⁰ continuity at the `0.5*max` boundary. The search loop never sees any
of it (`02`).

**Shallowest module — `bboxToCameraBounds` in `features/map/geojson.ts:42`.**

```ts
export function bboxToCameraBounds(bbox: [number, number, number, number]): LngLatBounds {
  return [bbox[0], bbox[1], bbox[2], bbox[3]];          // returns its input, retyped
}
```

The body does nothing — it returns the argument unchanged, only the
type label differs. This is a textbook shallow module: interface as
complex as the (non-existent) behaviour. **But this is the rare case
where shallow is the right call.** The function's whole job is to
*document and type-check* the claim that flattr's `bbox`
(`[minLng,minLat,maxLng,maxLat]`) is byte-identical to MapLibre v11's
`LngLatBounds` — the comment at `geojson.ts:36-38` is the payload. Folding
it inline would delete a load-bearing assertion. Leave it; it earns its
shallowness as an executable comment. If you wanted it deeper you'd have
nowhere to go — there's no behaviour to hide.

**Honest note:** flattr has very few shallow modules to complain about.
The peripheral helpers (`edgeById`, `otherEnd`, `directedGrade`,
`nearestNode`) are all small but each hides a real decision (which
endpoint, sign convention, nearest-by-haversine). Small ≠ shallow.

---

## 3. information-hiding-and-leakage

A leak is a single fact that two modules both know, so they must change
together. The book's sharpest red flag: *the same knowledge edited in
two places*.

**The one real leak — the DEM cell-key formula.** Named in lens 1; here's
the seam diagram. The fact "lat/lng → ~90 m cell id" lives in two
modules that don't import each other:

```
  Information leak — one fact, two homes

  ┌─ BUILD-TIME ─────────────┐      ┌─ RUNTIME (mobile) ───────────┐
  │ pipeline/elevation.ts:42 │      │ mobile/src/useTileGraph.ts:36│
  │ keyOf(lat,lng) =         │ ═══  │ cellKey(lat,lng) =           │
  │  round(lat/prec),        │ must │  round(lat/DEDUPE),          │
  │  round(lng/prec)         │ agree│  round(lng/DEDUPE)           │
  └──────────────────────────┘      └──────────────────────────────┘
        prec passed as              DEDUPE = 0.0008 (local const)
        dedupePrecision: DEDUPE          ▲
              └────────── same number, different name ──────┘
```

They even pass the *same value* (`useTileGraph.ts:197` calls `buildGraph`
with `{ dedupePrecision: DEDUPE }`), so the build and the cache currently
agree — by coincidence of one shared constant, not by shared code. **The
fix:** export one `cellKey(lat, lng, prec)` (or a `(prec) => key`
factory) from a single module — `pipeline/elevation.ts` is the natural
home since it owns the dedup concept — and have `useTileGraph` import it.
Then "how to quantize" lives once. → `07-provider-interface.md` discusses
where this belongs relative to the provider seam.

**No temporal decomposition found.** A common leak is splitting code by
*when* it runs (a "read phase" module and a "write phase" module that
share a format). flattr's pipeline is staged (`osm → split → elevation →
grade → build-graph`) but each stage owns a distinct *transformation*,
not a shared mutable format — the `Graph`/`Node`/`Edge` types in
`features/routing/types.ts:1-28` are the one shared contract and they're
defined in a single place. That's decomposition by knowledge, done right.

**Praise — the sign convention is hidden in one function.**
`directedGrade` (`graph.ts:17`) is the *only* place that knows
"forward = +gradePct, reverse = −gradePct". `cost.ts`, `astar.ts`,
`summary.ts`, and `geojson.ts` all defer to it rather than re-deriving
the sign. One fact, one home. → `03-directed-traversal-over-undirected-storage.md`.

---

## 4. layers-and-abstractions

The smell: a **pass-through method** (forwards a call adding nothing) or
a **pass-through variable** (threaded through layers that don't use it),
or two adjacent layers offering the *same* abstraction so one isn't
earning its place.

**Pass-through variable — `userMax` threaded through `routeSummary`.**
`features/routing/summary.ts:11` takes `_userMax` and never uses it (the
underscore admits it):

```ts
export function routeSummary(graph: Graph, path: Path, _userMax: number): RouteSummary {
```

`steepCount` is read straight off `path.steepEdges.length` (already
computed by `summarizePath`), so the summary doesn't need `userMax`. It's
in the signature for caller-side uniformity. Minor — but it's a real
pass-through variable: drop it, or keep it and document why the
parameter list mirrors the other route functions. Low severity.

**Adjacent-layer abstraction collision — the stage wrappers.**
`astar.ts:136-163` defines `dijkstra`, `astar`, `gradeAstar`,
`directedAstar` — four one-line functions that each call `search` with a
fixed `(costFn, heuristicFn)` pair. Are these pass-through methods? **No —
and the distinction is the lesson.** A pass-through method forwards
*without adding information*. These add the one thing that defines the
algorithm: the cost/heuristic choice. `dijkstra` isn't "search with
extra steps," it *is* the binding of search to `(distanceCost,
zeroHeuristic)`. The wrappers are the named, tested vocabulary the bench
harness and tests reach for. Keep them. → `01-parametric-search-over-cost-fns.md`.

**No needless forwarding layer found** in the core. The mobile layer
does forward (`MapScreen` → `useTileGraph` → `pipeline`), but each hop
transforms (UI event → coverage decision → graph build), so each earns
its place.

---

## 5. pull-complexity-downward

A module should handle hard cases itself rather than exposing a knob and
making every caller deal with it. The red flag: avoidable config pushed
up to callers.

**Done well — `userMax` is the one knob, and it's pulled as low as it
can go.** The entire grade model collapses to a single user-facing number
(max comfortable uphill grade). Everything downstream — penalty curve,
color bands (`classify.ts:41` `bandsForUserMax`), steep-edge flagging —
*derives* from `userMax` rather than exposing its own knob. The presets
(`classify.ts:46-50`) are three values of that one knob, not three
separate dials. That's complexity pulled all the way down to one number.

**Mild over-exposure — `k1`/`k2` in `penalty()`.** `cost.ts:16` exposes
the curve tuning constants as optional parameters:

```ts
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
```

No caller in the repo ever passes them — `gradeCostAbs`/`gradeCostDirected`
(`cost.ts:28-33`) use the defaults. So the knob is exposed but unused.
**This is the right call, narrowly:** the defaults mean callers ignore
it, and having `k1`/`k2` as parameters keeps `penalty` a pure function
that's trivially property-tested (the test can sweep the constants
without touching globals). The cost is two parameters most readers will
never need. Acceptable; if it bothers you, move them into a single
`Tuning` object so the signature reads `penalty(g, max, tuning?)`.

**No leaked internals via config found.** There's no config file
exposing graph internals, no flags that let a caller reach past an
interface.

---

## 6. errors-and-special-cases

The book's strongest move: **define errors out of existence** so there's
no special case to handle. Watch for try/except scattered across call
sites and special cases a better definition would erase.

**Defined out of existence — `BLOCKED` as a large finite number.**
`cost.ts:5` `BLOCKED = 1e9`. The naive design would special-case
"edge too steep" as an exception or an `Infinity` that the search must
check for. flattr instead makes an over-grade edge *cost a billion* — so
the search loop has zero special-case code for steepness. A steep-only
route still gets returned (just expensive) and flagged in `steepEdges`,
while a genuinely disconnected graph returns `null`. The two "failures"
stay distinguishable *because* `BLOCKED` is finite. One constant erases
an entire branch of error handling. → `05-blocked-as-large-finite.md`.

**Masked low — elevation failure becomes flat ground.**
`useTileGraph.ts:20-31` `bestEffortElevation` catches a throttled
elevation API and returns all-zeros rather than failing the build. The
error is handled at the *lowest* level (inside the provider wrapper), so
the build, the routing, and the UI above it have no error path to thread
— they just get a graph with flat grades and a `degraded` flag. The flag
drives a quiet self-heal retry (`useTileGraph.ts:209-218`). This is
masking done right: the exception dies where it occurs and the rest of
the system stays linear.

**Aggregated — NaN guard at one chokepoint.** `pqueue.ts:24` throws on a
`NaN` priority *once*, at push. Rather than every cost function checking
its own output, the one place all priorities funnel through validates
them. A `NaN` from a bad grade calc surfaces immediately with a clear
message instead of silently corrupting heap order. One guard, whole-system
coverage.

**Honest note:** the `find()` in `edgeById` (`graph.ts:3`) throws if the
id is missing — a real exception, but it's a programmer-error guard
(an unknown edge id is a bug, not a runtime condition), so it's fine as
a throw. No scattered try/except in the core.

---

## 7. readability — names · comments · consistency · obviousness

**Names — strong, precise, sign-aware.** flattr's names carry the *sign
convention* that's the trickiest thing in the codebase: `gradePct`
(signed, from→to), `absGradePct` (steepness only), `directedGrade`
(signed by travel direction), `riseM` (signed). A reader never has to
guess whether a grade is signed — the name says so. `userMax`,
`steepEdges`, `degraded`, `corridor`, `pump` all carry their meaning.
No `data`, no `obj`, no `manager`, no `tmp` in the core. One nit:
`prec` (`elevation.ts:29`) vs `DEDUPE` (`useTileGraph.ts:68`) name the
*same concept* differently — which is exactly the leak from lens 3
showing up as a naming inconsistency.

**Comments — interface-level, explaining why not what.** The comments
that earn their place are the ones carrying what code can't:
`cost.ts:4` ("Large but FINITE, so an only-steep path is still returned"),
`astar.ts:80-84` (why reconstruct uses relaxed edges, not node pairs —
parallel-edge correctness), `geojson.ts:36-38` (why `bboxToCameraBounds`
exists at all). These are the load-bearing comments. None merely restate
the code. The file headers (`// features/routing/summary.ts — …`) orient
fast. This is the comment discipline the book asks for.

**Consistency — one convention per job, mostly.** Cost functions are all
`CostFn`-typed (`types.ts:40`), all penalties route through `penalty()`,
all sign decisions through `directedGrade`. The one inconsistency is the
cell-key (two formulas, lens 3) and its `prec`/`DEDUPE` naming.

**Obviousness — one "huh?" worth flagging.** `bidirectional.ts:99`:

```ts
const tentative = gr.get(u)! + costFn(edge, v, userMax); // forward dir: from = v
```

In the *reverse* search the cost is computed with `v` (the forward
predecessor) as the `from` node, not `u`. That's correct — directed cost
must always be evaluated in the forward travel direction even when
walking backward — but it's the subtlest line in the repo, and the
inline comment is doing real work. Good that it's there; it's still the
spot a new reader trips on. The `_userMax` underscore (lens 4) is a small
obviousness win — it signals "intentionally unused" rather than leaving
a reader wondering.

**Ranked readability fixes:** (1) unify `prec`/`DEDUPE` naming + formula
(also fixes lens 3); (2) consider a one-line note on `summary.ts`'s
unused `_userMax` so it doesn't read as an oversight. Everything else is
above bar.

---

## 8. red-flags-audit (capstone)

Ousterhout's red-flag checklist, marked against flattr. Sorted by
severity for this repo. This is the index — fix top-down.

```
  RED FLAG                        STATUS   WHERE / FIX
  ──────────────────────────────  ───────  ─────────────────────────────
  Information leakage              FIRES    elevation.ts:42 + useTileGraph
   (same fact, two edit sites)              .ts:36 — DEM cell-key formula
                                            twice. Fix: export one
                                            cellKey(lat,lng,prec).  → lens 3
  ──────────────────────────────  ───────  ─────────────────────────────
  Avoidable complexity / O(E)      FIRES    graph.ts:3 edgeById uses
   linear scan in a loop                    .find() (O(E)); called per-edge
   (a performance red flag with             in summary.ts:14 & geojson.ts:53
    a design root)                          → O(path·E). Fix: id→edge Map,
                                            the one astar.ts already has
                                            (indexEdges, astar.ts:12). → lens 1
  ──────────────────────────────  ───────  ─────────────────────────────
  Pass-through variable            FIRES    summary.ts:11 _userMax unused.
   (minor)                                  Drop it or document the mirror.
                                            → lens 4
  ──────────────────────────────  ───────  ─────────────────────────────
  Avoidable config exposed         WEAK     cost.ts:16 k1/k2 params never
                                            passed. Acceptable (keeps
                                            penalty pure-testable). → lens 5
  ──────────────────────────────  ───────  ─────────────────────────────
  Shallow module                   N/A      Only bboxToCameraBounds is
                                            shallow, and it's a deliberate
                                            typed-comment. → lens 2
  ──────────────────────────────  ───────  ─────────────────────────────
  Temporal decomposition           DOESN'T  Pipeline staged by transform,
                                            not by phase. → lens 3
  ──────────────────────────────  ───────  ─────────────────────────────
  Special-case sprawl              DOESN'T  BLOCKED + degraded-flag define
                                            the cases out. → lens 6
  ──────────────────────────────  ───────  ─────────────────────────────
  Try/except everywhere            DOESN'T  Errors masked low (best-effort
                                            elevation) or guarded at one
                                            chokepoint (pqueue NaN). → lens 6
  ──────────────────────────────  ───────  ─────────────────────────────
  Vague names                      DOESN'T  Names carry the sign convention.
                                            prec/DEDUPE is the only nit.
                                            → lens 7
  ──────────────────────────────  ───────  ─────────────────────────────
  Comment restates code            DOESN'T  Comments carry why, not what.
                                            → lens 7
  ──────────────────────────────  ───────  ─────────────────────────────
  Non-obvious / hidden control     WEAK     bidirectional.ts:99 reverse-
   flow                                     direction cost. Correct + well-
                                            commented; inherently subtle. → lens 7
```

**Top 3 fixes, ranked across the whole repo:**

1. **Dedup the DEM cell-key** (`elevation.ts:42` + `useTileGraph.ts:36`).
   Highest leverage: it's an active information leak that can silently
   break the elevation cache under a future edit. Export one
   `cellKey(lat, lng, prec)`.
2. **Map-back `edgeById`** (`graph.ts:3` → used in `summary.ts:14`,
   `geojson.ts:53`). Replace the O(E) `.find()` with the id→edge `Map`
   that `astar.ts` already proves out. Removes O(path·E) from the render
   and summary paths.
3. **Drop or document `_userMax`** in `routeSummary` (`summary.ts:11`).
   Smallest, cosmetic — clears the one pass-through variable.

Everything else is the codebase being good. The pattern files (Pass 2)
walk the design moves worth learning from.
