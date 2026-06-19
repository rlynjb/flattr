# Derived Render-Time A* (route as derived state)
### industry names: derived state / computed values + render-phase computation — Project-specific (a `useMemo` running a graph search)

---

## Zoom out, then zoom in

The route line on the map is never stored anywhere. There's no `route` state,
no `setRoute`. The route is **computed from source state every render** — and
the computation is a full A* shortest-path search over the street graph. This
is the single most important — and most surprising — frontend decision in the
app.

Here's where it sits.

```
  Zoom out — the route as a derived value

  ┌─ UI layer (MapScreen.tsx) ───────────────────────────────────┐
  │  source state: startPt, endPt, userMax, graph                 │
  │        │ feed                                                  │
  │        ▼                                                       │
  │  ★ routed = useMemo(() => directedAstar(...)) ★  ← we are here │
  │        │ produces                                              │
  │        ▼                                                       │
  │  <GeoJSONSource data={routed.fc}> + <RouteSummaryCard>        │
  └────────────────────────────────────────────────────────────────┘
                            │  routed.fc serialized to native
  ┌─ Native (MapLibre) ─────▼──────────────────────────────────────┐
  │  draws the route line on the GPU                                │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: it's **derived state** — the React pattern where you compute a value
from existing state during render instead of storing it and syncing it. You've
used it for `const fullName = useMemo(() => first + " " + last, [first, last])`.
Same shape — except the "compute" here is `directedAstar`, a priority-queue
graph traversal. The question it answers: *how do I keep the route perfectly in
sync with the endpoints, the user's max grade, AND a graph that's still
loading tiles — with zero chance of drift?*

---

## Structure pass

**Layers** — three altitudes of "the route":

```
  outer:  what renders       (the blue line + the honesty card)
  middle: the derived value  (routed = {fc, summary, found})
  inner:  the search itself   (directedAstar over the merged graph)
```

**Axis traced — "where does the route's truth live?"** (a state-ownership
axis):

```
  axis = "where does the current route live?"  — trace downward

  ┌──────────────────────────────────────────────┐
  │ outer: the screen                              │ → NOWHERE persistent
  │   shows whatever `routed` currently is         │   (re-derived each render)
  └───────────────────┬────────────────────────────┘
      ┌───────────────▼────────────────────────────┐
      │ middle: useMemo cache                        │ → CACHED per dep-set
      │   memoized on [graph,startId,endId,userMax]  │   (recompute on change)
      └───────────────┬────────────────────────────┘
          ┌───────────▼────────────────────────────┐
          │ inner: A* call                           │ → COMPUTED fresh
          │   no memory between calls; pure function │   (deterministic output)
          └──────────────────────────────────────────┘
```

The truth flips from *nowhere stored* (outer) to *cached by inputs* (middle)
to *freshly computed* (inner). The route isn't a thing you own — it's a
function of things you own. That's the whole pattern.

**Seams:**

- **state → derived seam** (`useMemo` boundary): the contract is "given these
  four inputs, here is the route." Any change to an input invalidates the
  cache. This is where drift *can't* happen — there's no second copy.
- **derived → render seam** (the JS thread): the surprising, load-bearing one.
  The A* runs *on the render path, on the single JS thread*. The axis "is this
  work bounded per frame?" flips here — `useMemo` for a string is trivial;
  `useMemo` for a graph search is not. → `.aipe/study-runtime-systems/`.

---

## How it works

### Move 1 — the mental model

You know derived state: don't store what you can compute. If you store both
`items` and `count`, they drift; store `items`, derive `count`. The route is
the same call — don't store the path, derive it from the endpoints.

The kernel is a pure function wrapped in an input-keyed cache:

```
  Derived state — the kernel shape

   source state            derived value (useMemo)
   ┌──────────┐            ┌────────────────────────┐
   │ startId  │──┐         │  cache keyed on inputs  │
   │ endId    │──┼────────►│  hit  → return cached   │
   │ userMax  │──┤         │  miss → run f(inputs)   │──► routed
   │ graph    │──┘         └────────────────────────┘
   └──────────┘
              any input changes ─► cache miss ─► recompute
```

One sentence: **the route is `f(startId, endId, userMax, graph)` recomputed
whenever any of those four change, never held as its own state.**

### Move 2 — the step-by-step walkthrough

#### The endpoints are coordinates; the node ids are *also* derived

Before A* can run, you need node ids, not lat/lng. But `startId`/`endId` aren't
stored either — they're a *prior* derived layer: `nearestNode(graph, startPt)`.
You know the chain `a → derive b → derive c`; this is it. Coordinates in,
nearest-node-id out, and it re-derives when `graph` changes.

```
  the derivation chain (two memos feeding a third)

  startPt ─►[useMemo nearestNode]─► startId ─┐
  endPt   ─►[useMemo nearestNode]─► endId   ─┼─►[useMemo directedAstar]─► routed
  graph   ─────────────────────────────────┘
  userMax ──────────────────────────────────┘
```

Boundary condition: because `nearestNode` re-runs against the *current* graph,
when corridor tiles load and a closer real node appears, `startId` silently
re-snaps — and that cascades into a fresh route. Storing the id instead would
freeze the route to a stale graph. The derive-don't-store choice is what makes
the loading-tiles case *just work*.

#### The route memo runs the search and shapes three outputs at once

The `routed` memo does three things in one pass: run `directedAstar`, and if it
found a path, build the GeoJSON line *and* the summary. If no path, return
`found: false`. One memo, one consistent triple — the line, the card, and the
flag can never disagree.

```
  routed memo — one search, three coherent outputs

  directedAstar(graph, startId, endId, userMax)
        │
        ├─ no path  → { fc: null, summary: null, found: false }  → "No route" card
        └─ path     → { fc: routeToGeoJSON(...),                  → blue line
                         summary: routeSummary(...),               → honesty card
                         found: true }
```

Boundary condition: the guard at the top returns `found: true` with null
outputs when endpoints aren't set yet — so "no endpoints" and "no route" are
*distinct* states. The card uses that to show nothing vs show "No route
between those points." Collapse them and you'd flash "No route" before the user
has even picked a destination.

#### The search runs synchronously, on the JS thread, during render — the hazard

Here's the part everyone trips on. `useMemo` does not move work off the main
thread. It only *caches* — it skips recompute when deps are unchanged. When a
dep *does* change, the function body runs synchronously, inline, in the render
pass. So `directedAstar` — a binary-heap-backed graph search — executes on the
single JS thread that also handles touch, gesture, and the bridge.

```
  where the search actually runs (thread view)

  ┌─ JS thread (single) ──────────────────────────────────────────┐
  │  setUserMax(5) ─► re-render ─► routed memo cache MISS           │
  │       │                                                         │
  │       ▼   ◄── A* RUNS HERE, BLOCKING ──►                        │
  │  directedAstar(...)  (pops heap, relaxes edges, until done)     │
  │       │                                                         │
  │       ▼  only now: commit, serialize props                      │
  └────────────────────────┬───────────────────────────────────────┘
                           │  (during this, no touch handling, no frame)
  ┌─ Native thread ─────────▼───────────────────────────────────────┐
  │  MapLibre would render the next frame — but JS is busy            │
  └────────────────────────────────────────────────────────────────┘
```

Concrete consequence: on a small bundled graph it's imperceptible. On a large
merged graph (base ∪ corridor ∪ several panned views), the search can take
long enough to drop a frame — and because it re-runs on *any* dep change
including `userMax`, tapping a different grade preset re-searches the whole
graph. The map gesture and the loading spinner stutter during the search.

#### What this would look like fixed (current vs future)

**Phase A (now):** A* in a render-time `useMemo`. Correct, drift-free, simple.
Blocks the JS thread proportional to graph size.

**Phase B (if it became a problem):** move the search off the render path —
into a worklet/worker, or behind `useTransition`/`startTransition` so React
keeps the UI responsive and applies the result when ready, or memoize harder
(don't re-search on `userMax` alone if the path topology is unchanged). The
takeaway: *the data-flow doesn't have to change* — `routed` stays derived
state; only *where the computation runs* moves. The `useMemo` is a clean seam
to swap behind.

```
  Phase A vs Phase B — only the execution location moves

  NOW:    setState ─► render ─► [A* inline, blocking] ─► commit
  FUTURE: setState ─► render ─► [queue A* off-thread]   ─► commit (stale ok)
                                       │ later
                                       └─► result ─► render ─► commit fresh
          the derived-state shape is identical; the thread it runs on changes
```

### Move 3 — the principle

**Derive, don't store — but remember that `useMemo` caches, it does not
parallelize.** Deriving the route from its inputs is the right call: it
eliminates an entire class of sync bugs (route disagreeing with endpoints or
grade). The cost you accept is that the derivation runs on the render thread,
so the *size* of a derived computation is a frame-budget decision. The general
lesson: derived state is about *correctness*; where the derivation executes is
about *performance* — they're separate axes, and `useMemo` only addresses the
first.

---

## Primary diagram

The full route data-flow, from source state through the search to pixels,
with the thread boundary marked.

```
  Route as derived state — full flow (single JS thread until the bridge)

  ┌─ source state (useState, MapScreen.tsx:52-56) ────────────────┐
  │  startPt   endPt   userMax        graph (from useTileGraph)    │
  └─────┬────────┬────────┬───────────────┬────────────────────────┘
        │        │        │               │
        ▼        ▼        │               │
   [useMemo nearestNode  :125-126]        │
        │ startId  │ endId│               │
        └────┬─────┴──────┴───────┬───────┘
             ▼                     ▼
   ┌─ routed = useMemo (MapScreen.tsx:143-154) ────────────────────┐
   │   directedAstar(graph, startId, endId, userMax)  ◄── BLOCKS JS │
   │     path?  yes → { fc, summary, found:true }                   │
   │            no  → { fc:null, summary:null, found:false }        │
   └─────────────┬───────────────────────────┬─────────────────────┘
                 ▼                             ▼
        <GeoJSONSource data={routed.fc}>   <RouteSummaryCard
          <Layer route-line>                 found summary userMax/>
        (MapScreen.tsx:276-284)             (MapScreen.tsx:342-344)
                 │
  ═══════════════│══ JS ↔ native bridge ════════════════════════════
                 ▼
        MapLibre draws the blue route line on the GPU
```

---

## Implementation in codebase

**Use cases in this repo:**

1. **Every route the user requests** — Route button, map tap, or suggestion
   pick sets `startPt`/`endPt`; the memo re-derives the line.
2. **Changing the grade preset** — `GradeSlider` calls `setUserMax`; because
   `userMax` is a dep, the route re-searches with the new max (a flatter route
   may exist at a higher tolerance).
3. **Tiles loading mid-route** — corridor build updates `graph`; `nearestNode`
   re-snaps; the route re-derives and connects across the new seam.

**Code, line by line.**

The two prior derivations (node ids) — `mobile/src/MapScreen.tsx:125-126`:

```
  startId / endId — MapScreen.tsx:125-126

  const startId = useMemo(
    () => (graph && startPt ? nearestNode(graph, startPt) : null),
    [graph, startPt]);                ← re-snaps when graph grows (tiles load)
  const endId = useMemo(
    () => (graph && endPt ? nearestNode(graph, endPt) : null),
    [graph, endPt]);
       │
       └─ coordinates → node id, re-derived against the CURRENT graph.
          this is why endpoints are stored as {lat,lng}, not ids (line 53-56).
```

The route memo — `mobile/src/MapScreen.tsx:143-154`:

```
  routed — MapScreen.tsx:143-154

  const routed = useMemo(() => {
    if (!graph || !startId || !endId) {
      return { fc: null, summary: null, found: true };  ← "no endpoints" ≠ "no route"
    }
    const r = directedAstar(graph, startId, endId, userMax); ◄── A* RUNS HERE, on JS thread
    if (!r.path) return { fc: null, summary: null, found: false }; ← genuinely no path
    return {
      fc: routeToGeoJSON(graph, r.path, userMax),   ← the drawable line (color per grade)
      summary: routeSummary(graph, r.path, userMax),← km, climb, steep-block count
      found: true,
    };
  }, [graph, startId, endId, userMax]);             ← recompute on ANY of these
       │
       └─ one memo produces line + summary + flag together, so they can't disagree.
          deps include userMax → tapping a preset re-runs the full search.
```

The consumers — `mobile/src/MapScreen.tsx:276-284` and `:342-344`:

```
  rendering the derived route

  {routed.fc && (                                   ← only mount the source if a line exists
    <GeoJSONSource id="route" data={routed.fc as ...}>
      <Layer id="route-line" type="line"
        style={{ lineColor: ["get","color"], lineWidth: 6, lineCap: "round" }}/>
                              ▲ data-driven color: each segment colored by its grade band
    </GeoJSONSource>
  )}
  ...
  {showCard && (routed.found || !loadingStep) && (
    <RouteSummaryCard found={routed.found} summary={routed.summary} userMax={userMax}/>
  )}                          ▲ the honesty card reads the SAME derived triple
```

`RouteSummaryCard` (`mobile/src/RouteSummaryCard.tsx:15-22`) turns the triple
into the three honest states — "Flat all the way" / "⚠ Flattest available"
(with steep-block count) / "No route between those points" — directly from
`found` + `summary.steepCount`, no extra state.

---

## Elaborate

Derived state is the load-bearing idea behind every reactive UI framework:
Vue's `computed`, Svelte's `$:`, Solid's `createMemo`, React's `useMemo`. The
discipline is always the same — minimize stored state, maximize derived state,
because stored state is the only kind that can go stale.

The interesting wrinkle in this repo is the *weight* of the derivation. Most
`useMemo` calls wrap cheap work (a filter, a sort, a format). Here it wraps a
graph algorithm. That crosses a line the pattern doesn't warn you about:
`useMemo` is a *caching* primitive, not a *concurrency* primitive. It buys you
"don't recompute when inputs are stable"; it does not buy you "don't block the
thread when you do recompute."

The fix space (worker, worklet, `startTransition`, off-thread search) belongs
to runtime systems, not frontend — which is exactly why this guide names the
*pattern* (derived render-time computation) and hands the *cost analysis and
remedy* to `.aipe/study-runtime-systems/`. The A* algorithm itself — heap,
admissible heuristic, `BLOCKED` as large-finite — is `.aipe/study-dsa-foundations/`.

What to read next: React's docs on `useMemo` ("you may rely on useMemo as a
performance optimization, not a semantic guarantee") and `startTransition`,
then the runtime-systems guide for the thread-budget framing.

---

## Interview defense

**Q: Why is the route derived state instead of stored in `useState`?**

To eliminate drift. If I stored the route, I'd have to re-run the search and
`setRoute` in an effect every time the endpoints, the grade, or the graph
changed — and any missed dependency means a stale blue line that disagrees with
the markers. Deriving it makes the route a pure function of its inputs; it's
structurally impossible for it to be out of sync.

```
  stored (drift-prone)         vs   derived (drift-proof)
  setStart → effect → setRoute       start changes → route recomputes
       │ forget a dep?                    │ no second copy to forget
       ▼                                  ▼
   stale route                       always consistent
```

Anchor: *stored state can drift; derived state can't — there's no second copy.*

**Q: Does `useMemo` make the A* run off the main thread?**

No — and that's the trap. `useMemo` only *caches*; on a cache miss the function
runs synchronously, inline, in the render pass, on the single JS thread. So a
large-graph route recompute blocks touch and the next frame. The memo saves me
from re-searching when nothing changed; it does nothing for the cost when
something does.

```
  useMemo = cache, not thread

  deps stable → skip (free)
  deps change → run NOW, on JS thread, blocking
```

Anchor: *`useMemo` is a caching primitive, not a concurrency one.*

**Q: It re-searches when `userMax` changes — is that a bug?**

It's correct but potentially wasteful. A different max can genuinely yield a
different route (a flatter path becomes reachable), so re-searching is right.
But if I profiled it and the preset taps felt janky, I'd move the search behind
`startTransition` so the UI stays responsive and the new route applies when
ready — without changing the fact that `routed` is derived. The data-flow seam
stays; only the execution location moves.

Anchor: *correctness says re-search; performance says move it off the render
path — different axes.*

---

## Validate

**Reconstruct.** Draw the derivation chain from memory: `startPt`/`endPt` →
`nearestNode` → `startId`/`endId` → `directedAstar` → `routed` → line + card.
Name the file and lines: `MapScreen.tsx:125-126` and `:143-154`.

**Explain.** Why does the route memo return `found: true` with null outputs
when endpoints aren't set (`:145`), instead of `found: false`? (To keep "no
endpoints yet" distinct from "genuinely no route" so the card doesn't flash a
false negative.)

**Apply to a scenario.** The user has a route drawn, then taps the "Any" (15%)
grade preset. Trace it: `setUserMax(15)` → re-render → `routed` memo dep
`userMax` changed → cache miss → full A* re-search → new line + summary. Now:
on a 5,000-edge merged graph, what's the user-visible symptom, and which guide
owns the fix? (Frame drop / gesture stutter; `.aipe/study-runtime-systems/`.)

**Defend the decision.** A reviewer says "store the route in state and update
it in a `useEffect` — that's the normal React pattern." Argue why deriving is
better here (drift elimination) and what real problem the effect approach would
introduce (a stale-route window between input change and effect firing, plus
missed-dependency bugs).

---

## See also

- `01-on-demand-tile-graph.md` — the `graph` this search runs over, and why it
  changes underfoot (tiles loading).
- `03-native-maplibre-declarative-layers.md` — how `routed.fc` becomes a drawn
  line.
- `audit.md` lens 1 (rendering-and-reactivity, synchronous scheduling), lens 2
  (state-architecture), lens 8 red flag #1.
- `.aipe/study-runtime-systems/` — the single JS thread and the cost of
  blocking it with a synchronous search (the hazard this file names).
- `.aipe/study-dsa-foundations/` — `directedAstar`, the binary heap, the
  admissible heuristic, `BLOCKED` as large-finite.
- `.aipe/study-performance-engineering/` *(not yet generated)* — measuring the
  search cost against a frame budget.
