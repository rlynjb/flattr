# audit.md — the 8-lens APOSD audit of flattr

Pass 1. Each lens below is walked against real files. Findings are grounded
in `file:line`. Where a lens finds little to bite on, it says so honestly
rather than manufacturing a finding. Significant patterns cross-link to
their Pass 2 deep walk.

The ranked top-3 fixes for the whole repo are at the bottom (Lens 8).

---

## 1. complexity-in-this-codebase

The diagnostic zoom-out. APOSD names three symptoms of complexity: *change
amplification* (one change touches many files), *cognitive load* (the module
nobody wants to open), and *unknown unknowns* (you can't tell what a change
will break). Walk flattr for each.

**Change amplification: low, and deliberately so.** The grade model is the
thing most likely to change (different curve, different bands). It lives in
exactly one file — `cost.ts` (33 lines). Changing the penalty curve touches
`penalty()` at `cost.ts:16-22` and nothing else; the search loop in
`astar.ts` never mentions grade. This is the repo's best property and the
subject of pattern file `02`. Contrast: if grade logic were inlined into the
A\* relaxation step (`astar.ts:68`), every algorithm stage would have to
re-implement it.

**Cognitive load: concentrated in two files, both justified.**

- `mobile/src/useTileGraph.ts` (290 lines) is the densest file in the repo.
  It juggles two pending requests, a busy flag, debounce, retry budget, a
  degraded-region self-heal loop, and two derived graphs (routing vs
  display). It's the one file a new contributor would fear. But the load is
  *inherent* — bounded concurrency against a rate-limited API with graceful
  degradation is genuinely this complex. The comments carry the why
  (`useTileGraph.ts:18`, `:148`, `:206`). See pattern `07`.
- `mobile/src/MapScreen.tsx` (487 lines) is the orchestrator — the biggest
  file. It wires UI state to the engine. This is screen-level glue, not a
  deep module; it's where shallowness is expected and acceptable.

**Unknown unknowns: low in the core, present at the seams.** The pure core
(`features/routing/`) has no hidden control flow — functions take inputs and
return outputs. The non-obvious behavior lives at two seams the comments
flag explicitly: `BLOCKED = 1e9` being finite-not-infinite (`cost.ts:4`,
the unknown-unknown that "no flat route" ≠ "no route" — pattern `05`), and
the degraded/non-degraded split between routing graph and display graph
(`useTileGraph.ts:131-162`).

**The 2 highest-complexity hotspots by path:**
1. `mobile/src/useTileGraph.ts` — inherent concurrency complexity, well
   commented (pattern `07`).
2. `mobile/src/MapScreen.tsx` — orchestration glue; large but shallow,
   which is the right shape for a screen.

---

## 2. deep-vs-shallow-modules

Depth = functionality hidden ÷ interface surface. Inventory the modules.

**The deepest module — `search()` in `astar.ts:22-78`.** Six parameters in,
one `SearchResult` out. Behind that signature: a binary-heap frontier, a
g-score map, a came-from map, a closed set, lazy-deletion of stale entries,
path reconstruction, and path summarization. And because the cost function
and heuristic are *arguments*, the same 57 lines are Dijkstra, A\*,
grade-aware A\*, and directional A\* — four algorithms behind one interface
(`astar.ts:136-163`). This is the textbook deep module. Full walk: pattern
`01`.

**Runner-up depth — `PQueue` (`pqueue.ts:4-78`).** Interface: `push`, `pop`,
`peek`, `isEmpty`, `size`. Hidden: sift-up, sift-down, the array-as-heap
layout, NaN guarding. It knows *nothing* about graphs or grades — a generic
that could lift into any project unchanged. Pattern `04`.

**The shallowest modules — and why they're fine.** `nearest.ts` (`nearestNode`,
one function) and `summary.ts` (`routeSummary`, one function) are nearly
1:1 interface-to-body. That's not classitis — they're leaf utilities with a
single obvious job. APOSD's warning is about classes whose interface is
*nearly as complex as their implementation while pretending to add
abstraction*. These add a name to a clear operation; that's acceptable
shallow.

**No classitis.** The repo uses functions and one class (`PQueue`). There's
no proliferation of tiny classes each requiring boilerplate. Verdict: the
module-depth story is genuinely good. The fix-worthy item isn't a shallow
module — it's two leaf utilities with O(n) bodies that an index would
deepen (see Lens 8).

---

## 3. information-hiding-and-leakage

A leak is a design decision known in two places, forcing them to change
together. Hunt for facts that appear twice.

**The big win — the grade domain does not leak.** The penalty curve, the
`userMax` knob, the "downhill is free" rule, and `BLOCKED` are all sealed in
`cost.ts`. The search loop (`astar.ts`) and the heap (`pqueue.ts`) never see
them. The one fact that crosses the seam is the *type* `CostFn`
(`types.ts:40`) — a contract, not an internal. Pattern `02`.

**One genuine leak — the elevation cell-key formula appears twice.** The
~90m DEM dedup key is computed in two files with the *same shape but
different rounding base*:

- `pipeline/elevation.ts:42` — `keyOf` uses `opts.dedupePrecision`.
- `mobile/src/useTileGraph.ts:36` — `cellKey` uses the local `DEDUPE = 0.0008`.

Both round lat/lng into a grid cell to dedup elevation samples. They're not
*identical* (the pipeline takes precision as a parameter; the mobile cache
hardcodes it), so this is a soft leak: the "elevation is sampled per ~90m
cell" decision lives in two heads. If the DEM resolution assumption changes,
both must change in lockstep. Low severity (the values agree today), but it's
the one place in the repo where the same knowledge is edited twice. Fix:
export the cell-key helper from `elevation.ts` and have the cache import it.

**No temporal decomposition.** Modules are split by *what they know*
(grade, frontier, elevation source), not by *what happens first*. The
pipeline (`build-graph.ts:22-29`) is a temporal sequence, but that's an
orchestrator calling deep modules in order — the correct use of sequence,
not a decomposition smell.

---

## 4. layers-and-abstractions

Hunt for pass-through methods (a method that just forwards to another with
no added value) and adjacent layers offering the same abstraction.

**Mostly clean.** Each layer changes the abstraction:
- `buildGraph` (`build-graph.ts`) → orchestrates parse/split/sample/grade
  into a `Graph`. Adds sequencing; not a pass-through.
- `gradeAstar`/`directedAstar` (`astar.ts:146-163`) → these *look* like
  pass-throughs to `search()`, but they aren't: each binds a specific
  `(costFn, heuristic)` pair. They're partial applications — the name *is*
  the abstraction ("directional A\*" = `search` + `gradeCostDirected` +
  `haversineHeuristic`). Naming a configuration is value-add, not forwarding.

**One thin pass-through — `edgeById`.** `summary.ts` and `astar.ts`'s
`summarizePath` both re-resolve edges. `edgeById` (`graph.ts:3-7`) is a
genuine forward to `Array.find`, and it's O(E). Not a layering smell so much
as a missing index — see Lens 8. The *abstraction* (look up an edge by id)
is right; the *implementation* is a linear scan where a `Map` belongs.

**`bestEffortElevation` / `cachedElevation` are decorators, not
pass-throughs** (`useTileGraph.ts:20-62`). Each wraps an `ElevationProvider`
and *adds* behavior (fallback-to-flat, cache lookup) while preserving the
interface. That's the decorator pattern composing on the provider seam —
the opposite of a pass-through. See pattern `06`.

---

## 5. pull-complexity-downward

A module should handle complexity itself rather than pushing knobs up to
callers, when it has the information to decide.

**Well done — the stage wrappers pull config down.** A caller wanting
directional grade routing calls `directedAstar(graph, start, goal, userMax)`
(`astar.ts:156`). They do *not* pass a cost function, a heuristic, or
tuning constants — the wrapper decided those (`gradeCostDirected`,
`haversineHeuristic`). The full generality of `search()` is available to
power users, but the common case is a four-argument call. That's the
pull-down move: complexity (which cost fn? which heuristic?) handled by the
module, not exposed.

**Well done — penalty constants default down.** `penalty()` exposes `k1`,
`k2` as parameters (`cost.ts:16`) but defaults them (`DEFAULT_K1`,
`DEFAULT_K2`). Callers never pass them; the tuning lives in the module.
Exposing them at all is the right hedge — they're tunable for benchmarking
without being mandatory.

**One knob arguably pushed up — `dedupePrecision`.** `sampleElevations`
takes `opts.dedupePrecision` (`elevation.ts:25`). The module knows the DEM
is ~90m; it could default the precision itself. Today the caller
(`build-graph.ts`, `useTileGraph.ts`) supplies it. Minor — it's legitimately
a build-vs-runtime difference — but it's the one place a default could pull a
decision down.

**Verdict:** this lens is a strength. The repo consistently gives callers a
small call and keeps the decisions inside.

---

## 6. errors-and-special-cases

APOSD's move: *define errors out of existence* where possible; mask them at
a low level; aggregate handling rather than scattering try/catch.

**Errors are mostly defined out of existence — by design.** The core router
doesn't throw on the common failure (no route). `search()` returns
`{ path: null, ... }` (`astar.ts:41`, `:77`). The caller checks one field
instead of catching an exception. This is the pure-function discipline: the
absence of a path is a value, not an exception.

**The special case that was designed away — `BLOCKED`.** The interesting one.
A naive design would special-case "edge too steep" as unroutable (skip the
edge, or throw). flattr instead assigns it a large-but-finite cost
(`cost.ts:5`, `:19`). The result: there's no special branch in the search
loop for steepness at all — a too-steep edge is just an expensive edge, and
the *only* path gets returned and flagged via `steepEdges`
(`astar.ts:126-128`). One number erases a whole class of special cases. This
is the cleanest "define the error out of existence" move in the repo —
pattern `05`.

**Exceptions, where they exist, are localized and low.** The throws are
guard rails in leaf functions: `otherEnd` throws if a node isn't an endpoint
(`graph.ts:13`), `percentile` throws on empty input (`zones.ts:6`), `PQueue`
throws on NaN priority (`pqueue.ts:24`). These are programmer-error asserts,
not control flow — they fire only on bugs, and they fire close to the cause.

**The one place errors are caught and masked — the elevation seam, correctly.**
`bestEffortElevation` (`useTileGraph.ts:20-31`) catches a throttled API and
masks it as flat (0m) elevation, flagging `degraded`. The try/catch sits at
exactly one level — the provider decorator — not scattered across call sites.
Aggregation done right. The pump's outer try/catch (`useTileGraph.ts:185-225`)
similarly contains all build failure in one place.

**Verdict: strong.** No try/catch sprawl. The biggest special case (steepness)
is defined away with a constant.

---

## 7. readability — names · comments · consistency · obviousness

**Names — precise, no smells.** No `data`/`obj`/`tmp`/`manager`. Names carry
the domain: `directedGrade`, `absGradePct`, `steepEdges`, `userMax`,
`degraded`, `corridor`, `pump`. The one terse cluster is single-letter
geo vars (`w, s, e, n` for bbox edges, `useTileGraph.ts:84`) — but bbox
destructuring is idiomatic and the comment names the convention at
`types.ts:23`. The throwaway loop indices (`i`, `j` in `cachedElevation`)
are fine — short scope, conventional.

**Comments — the strongest readability facet.** flattr's comments
consistently explain *why*, not *what* — exactly APOSD's standard:
- `cost.ts:4` — "Large but FINITE, so an only-steep path is still returned
  and flagged." Carries the design decision a reader couldn't infer.
- `useTileGraph.ts:18-19` — explains why one build at a time (rate limits).
- `useTileGraph.ts:148-149` — explains why display graph excludes degraded
  regions (bogus green painting over real grades).
- `pqueue.ts:1` — "Knows nothing about graphs/grades." Names the design
  intent (genericity) a reader should preserve.
- `astar.ts:80-84` — explains *why* reconstruct uses relaxed edges not
  node-pair lookup (parallel edges).

These are interface/rationale comments, the kind only a comment can carry.
This is a genuine strength worth calling out.

**Consistency — one convention per job.** Graphs are always
`Record<string, Node>` + `Edge[]` + adjacency. Grade is always signed
from→to with `directedGrade` for travel direction. Providers always expose
`sample(points)`. No two conventions competing.

**Obviousness — two mild "huh?" spots.**
1. The stage wrappers pass `Infinity` as `userMax` for Dijkstra/A\*
   (`astar.ts:137`). It reads oddly until you see `penalty` short-circuits
   on `g <= 0` and `summarizePath` guards `Number.isFinite(userMax)`
   (`astar.ts:126`). Subtle but correct; a one-line comment at the wrapper
   would erase the "huh?".
2. The bidirectional reverse relaxation passes `costFn(edge, v, userMax)`
   with `v` (the predecessor) not `u` (`bidirectional.ts:99`). Correct —
   the comment explains forward-direction cost — but it's the densest spot
   in the algorithm code.

---

## 8. red-flags-audit — the capstone checklist

APOSD's red flags as a review checklist, marked against flattr. Sorted by
severity for this repo.

| Red flag | Fires? | Where / verdict |
|----------|--------|-----------------|
| **Information leakage** | ⚠️ minor | Elevation cell-key formula duplicated: `elevation.ts:42` vs `useTileGraph.ts:36`. Export one helper. (Lens 3) |
| **Shallow module** | ⚠️ minor | Not true classitis. But `nearestNode` (`nearest.ts:5`) and `edgeById` (`graph.ts:3`) are shallow *and* O(n)/O(E) — index them. (Lens 2, below) |
| **Conjoined methods** | ✗ no | Modules read independently; no method requires reading another to understand. |
| **Pass-through method** | ✗ mostly no | `edgeById` is the only genuine forward, and it's a missing-index issue not a layering one. (Lens 4) |
| **Temporal decomposition** | ✗ no | Split by knowledge, not by time. (Lens 3) |
| **Repetition** | ⚠️ minor | The cell-key formula (above). Otherwise DRY. |
| **Hard to pick a name** | ✗ no | Names are precise and domain-true. (Lens 7) |
| **Hard-to-describe interface** | ✗ no | `search`, `sample`, `penalty` all describe in one sentence. |
| **Non-obvious code** | ⚠️ minor | `Infinity` as userMax (`astar.ts:137`); reverse-cost `v` not `u` (`bidirectional.ts:99`). Both correct, both could use a comment. (Lens 7) |
| **Comment restates code** | ✗ no | Comments explain *why*; a genuine strength. (Lens 7) |
| **Implementation doc in interface** | ✗ no | Interface comments stay at the interface level. |

### The ranked top-3 fixes for the whole repo

1. **Index the edge lookup.** `edgeById` (`graph.ts:3`) is `Array.find` —
   O(E) — and `summarizePath`/`routeSummary` call it inside a loop, making
   route summarization O(path × E). `search()` already builds exactly the
   index needed (`indexEdges`, `astar.ts:12`). Thread that `Map` through to
   `summarizePath` and `routeSummary`, or memoize it on the graph. Biggest
   real perf win, zero interface change for callers. *(This is the highest-
   leverage fix; it's a perf concern more than a design one — cross-link to
   `study-performance-engineering/`.)*

2. **De-duplicate the elevation cell-key.** Export `keyOf` from
   `elevation.ts` and have `useTileGraph.ts:36` import it instead of
   re-deriving the formula. Removes the one place the same knowledge is
   edited twice (Lens 3).

3. **Add two one-line comments for the non-obvious spots.** `astar.ts:137`
   (`Infinity` userMax means "no grade penalty"), and a note at
   `nearest.ts:5` that the O(n) scan is acceptable at current graph sizes
   but is the thing to replace with a spatial index (k-d tree / grid) if
   node counts grow. Cheap obviousness wins.

None of these are structural. flattr's design is sound; these are the polish
items on an already-clean codebase.
