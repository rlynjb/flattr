# Finite-Sentinel Tests — proving "too steep" stays distinct from "no route"

*Industry name: **sentinel-value testing** (asserting a domain-specific
not-Infinity sentinel behaves as both a number and a flag). Type:
project-specific technique built on a language-agnostic idea.*

---

## Zoom out — where this sits

flattr makes a deliberate, load-bearing choice: a too-steep edge costs
`BLOCKED = 1e9` (a large *finite* number), not `Infinity`. That single decision
ripples through the cost function, the priority queue, the search, and the
route coloring — and a cluster of tests across those layers all defend the same
property: **steep-but-routable must never collapse into disconnected.**

```
  Zoom out — BLOCKED threads through every routing layer

  ┌─ Engine ─────────────────────────────────────────────────┐
  │  cost.ts     penalty(g>max) → BLOCKED (1e9, FINITE)       │ ← origin
  │      │                                                    │
  │  pqueue.ts   1e9 orders LAST but doesn't break compare    │ ← ordering
  │      │                                                    │
  │  astar.ts    returns a path THROUGH blocked edges +       │ ← reachability
  │      │       flags them steepEdges (not null)             │
  │  geojson.ts  colors over-max edges GREY (visible warning) │ ← surfacing
  └──────────────────────────────────────────────────────────┘
   the tests at EACH layer assert: steep ≠ disconnected
```

The question it answers: **how do you tell a user "there's a route, but it's
too steep" differently from "there's no route at all"?** If steep edges cost
`Infinity`, both cases produce the same dead end — `null`, no path. By making
the cost large-but-finite, the router *still returns the steep path* and flags
it, and only genuine disconnection yields `null`. The tests are how that
distinction is kept alive across refactors.

---

## The structure pass

**Layers.** The same property — "finite, not infinite" — is asserted at four
altitudes:

- cost layer: `penalty` returns `BLOCKED` (finite) for over-max grades.
- queue layer: a `1e9` priority *orders* behind normal priorities without
  breaking the comparison.
- search layer: a graph where the only path is steep returns that path (not
  `null`) and flags the steep edges.
- presentation layer: an over-max edge renders grey, distinct from green/red.

**The axis: reachability — "can the user get there?"** Trace it across the two
cases this technique separates, at every layer:

- *steep but connected:* reachability = **yes, with a warning.** Cost is huge
  but finite; path exists; edges flagged; colored grey.
- *genuinely disconnected:* reachability = **no.** No path; result is `null`.

**The seam:** the `BLOCKED = 1e9` constant itself (`cost.ts:5`). It's the
single point where the "steep ≠ disconnected" contract is encoded. Change it to
`Infinity` and the axis-answer for "steep but connected" silently flips from
"yes, with warning" to "no" — the two cases merge, and the user can no longer
tell them apart. The tests are positioned on *both sides* of that seam to pin
the flip from happening.

---

## How it works

### Move 1 — the mental model

You know how in a form you distinguish "field is empty" from "field is invalid"
— `null` vs `{error}` — because collapsing them loses information the user
needs? Same problem here. "No route" and "only a steep route" are different
answers, and the system has to keep them different all the way to the screen.

```
  Two failure-ish cases that must NOT merge

   start ──steep edge (12%)── goal      start ──×── goal
   ┌────────────────────────────┐       ┌──────────────────┐
   │ cost = BIG but FINITE       │       │ no edge at all    │
   │ → path returned + flagged   │       │ → path is null    │
   │ → "steep route, here it is" │       │ → "no route"      │
   └────────────────────────────┘       └──────────────────┘
        reachable, warned                  unreachable
              │                                  │
              └──── must stay distinct ──────────┘
        (Infinity would merge them into one dead end)
```

The strategy in one sentence: **use a large finite sentinel instead of
infinity so the unwanted-but-possible case stays computable and
distinguishable from the truly-impossible case — and test the distinction at
every layer it could leak.**

### Move 2 — the walkthrough

**Step 1 — the sentinel is finite at the origin (cost layer).** `penalty`
returns `BLOCKED` for an over-max grade, and the test asserts the resulting
*cost* is still a finite number — bigger than BLOCKED (because it's multiplied
by length and added to base) but `Number.isFinite(c) === true`.

```
  Pseudocode — the finite-sentinel cost

  penalty(g, max):
    if g <= 0:    return 0
    if g > max:   return BLOCKED          // 1e9, FINITE — not Infinity
    ...

  gradeCostDirected(edge, from, max):
    return edge.lengthM * (1 + penalty(grade, max))
    // over-max → lengthM * (1 + 1e9) → HUGE but finite & comparable

  // test: gradeCostDirected(steepEdge) > BLOCKED  AND  isFinite() → true
```

The boundary condition: if `penalty` returned `Infinity`, this cost would be
`Infinity`, and every downstream comparison (`tentative < best`) would treat
all infinite-cost paths as equally impossible — you couldn't pick the
*least-bad* steep route. Finite keeps them ranked.

**Step 2 — the sentinel orders correctly (queue layer).** The priority queue
must put a `1e9`-priority entry *behind* a normal one — but only because `1e9 <
Infinity` and the comparison is plain `<`. The test pins this.

```
  Execution trace — BLOCKED orders last, doesn't break compare

  push("blocked", 1e9)   push("ok", 10)
  ───────────────────────────────────────
  heap compare: 10 < 1e9  → "ok" is the min
  peek() → "ok"                            ✓

  // with Infinity: 10 < Infinity also holds, BUT Infinity arithmetic
  // (Infinity - Infinity = NaN) elsewhere would poison the heap — and
  // PQueue.push explicitly throws on NaN (pqueue.ts:24). Finite avoids
  // ever generating the NaN.
```

**Step 3 — the search returns the steep path, not null (search layer).** This
is the heart of it. Take a graph whose *only* connection is a too-steep edge.
The directed engine must return that path and list the steep edge in
`steepEdges` — not give up with `null`.

```
  Pattern — steep-only graph still routes

  graph:  X ──xy (8%, over userMax 5)── Y     (no other path)

  directedAstar(X, Y, 5)
     │
     ▼
  path = { nodes: [X, Y], edges: [xy], steepEdges: [xy] }   ← NOT null
                                        └─ the flag that lets the UI warn
```

Then the contrast test, same engine, same call shape, but a *disconnected*
node: `directedAstar(X, ISO, 5)` → `null`. Two tests, side by side, asserting
the two cases produce *different* results. That pairing is the technique — a
property is only "distinct" if you test both sides.

**Step 4 — the sentinel surfaces as a distinct color (presentation layer).**
The over-max edge colors **grey** — visually distinct from green (flat) and red
(steep-but-allowed). And because grade is *directed*, the same physical edge is
grey climbing and green descending.

```
  Execution trace — directed coloring of one steep edge

  edge A→B: +10% grade, userMax = 8
  ─────────────────────────────────────────────
  route A→B (climbing): 10 > 8  → GREY (#9aa0a6)  "over your max"
  route B→A (descending): -10   → GREEN (#2e9e3f) "free downhill"
  ─────────────────────────────────────────────
  same edge, opposite directions, opposite colors — the directed
  sentinel survives all the way to the rendered route.
```

### Move 2 variant — the load-bearing skeleton

The kernel of this technique is three parts:

1. **A finite sentinel, not Infinity.** Drop it (use Infinity) → steep merges
   with disconnected, and Infinity arithmetic risks NaN downstream. This is the
   one decision everything else defends.
2. **Paired tests: the wanted case AND its near-miss.** Drop the pairing (test
   only "steep returns a path") → you've shown steep works but not that it's
   *distinct* from disconnected; a regression that makes both return `null`
   passes. The contrast test (`returns null only when genuinely disconnected,
   not when merely steep`) is the load-bearing pair.
3. **The flag the sentinel sets (`steepEdges`).** Drop it → the route is
   returned but the UI can't tell it's steep, so the warning never reaches the
   user.

Optional hardening: the multi-layer coverage (cost + queue + color all
asserting the same idea). The skeleton is "finite sentinel + paired distinct
tests + the warning flag."

### Move 3 — the principle

**When a value means "very bad but still possible," make it a large finite
sentinel and test that it stays distinct from "impossible."** Reaching for
`Infinity` or `null` to mean "bad" is lossy — it collapses degrees of badness
and risks poisoning arithmetic. A finite sentinel keeps the bad case rankable,
computable, and distinguishable; the paired tests (wanted case vs near-miss)
are what prove the distinction holds.

---

## Primary diagram

The full recap: the finite sentinel threading through four layers, with the
test at each layer pinning "steep ≠ disconnected."

```
  flattr's finite-sentinel tests — full recap

  BLOCKED = 1e9 (finite)   ← cost.ts:5, the seam
        │
  ┌─────┼─────────────────────────────────────────────────────┐
  │     ▼                                                       │
  │  COST    penalty(g>max)=BLOCKED; cost>BLOCKED & isFinite    │ cost.test.ts:81-86
  │     │                                                       │
  │  QUEUE   1e9 orders behind 10; compare stays valid          │ pqueue.test.ts:101-106
  │     │                                                       │
  │  SEARCH  steep-only → path + steepEdges  ≠  disconnected→null│ astar.test.ts:82-96
  │     │    └──────── the PAIRED distinct tests ───────────────┤
  │     ▼                                                       │
  │  COLOR   over-max → GREY; same edge GREEN descending         │ geojson.test.ts (routeToGeoJSON)
  └─────────────────────────────────────────────────────────────┘
   every layer asserts the same contract: steep-but-reachable ≠ no-route
```

---

## Implementation in codebase

**Use cases.** Reached for wherever a route might be undesirable but possible.
The spec names this an explicit must-not-change constraint: *"BLOCKED is
large-finite, not Infinity — so 'no flat route' (steep flagged) stays distinct
from 'no route' (disconnected)."* The tests are the enforcement of that
constraint across the cost, queue, search, and coloring layers.

The finite sentinel at its origin, `features/routing/cost.ts:4-5` and its test
`features/routing/cost.test.ts:81-86`:

```
  features/routing/cost.ts  (lines 4-5)

  /** Large but FINITE, so an only-steep path is still returned and flagged. */
  export const BLOCKED = 1e9;        ← the entire technique hinges on this line

  features/routing/cost.test.ts  (lines 81-86)

  it("gradeCostDirected blocks a too-steep climb but stays finite", () => {
    const e = edgeAt(9);                      ← 9% grade, max is 5
    const c = gradeCostDirected(e, "A", max);
    expect(c).toBeGreaterThan(BLOCKED);       ← cost is huge…
    expect(Number.isFinite(c)).toBe(true);    ← …but FINITE. This is the assert
  });                            │               that fails the instant someone
                                 └─              "simplifies" BLOCKED to Infinity.
```

The paired distinct tests in the search layer,
`features/routing/astar.test.ts:82-96`:

```
  features/routing/astar.test.ts  (lines 82-96)

  it("still returns an only-steep path and flags the steep edge", () => {
    const g = directionalGraph();
    g.edges = g.edges.filter((e) => e.id === "xy");   ← strip to ONLY the steep edge
    g.adjacency = { X: ["xy"], Y: ["xy"], F: [] };
    const r = directedAstar(g, "X", "Y", 5);          ← 8% edge, userMax 5
    expect(r.path).not.toBeNull();                    ← STEEP STILL ROUTES
    expect(r.path!.steepEdges).toEqual(["xy"]);       ← and is FLAGGED
  });

  it("returns null only when genuinely disconnected, not when merely steep", () => {
    const g = directionalGraph();
    g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };
    g.adjacency["ISO"] = [];                           ← truly disconnected
    expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();  ← THIS is null
  });                            │
                                 └─ the two tests TOGETHER are the technique:
                                    steep → path (flagged); disconnected → null.
                                    Either alone proves nothing about the
                                    DISTINCTION. The pair is load-bearing.
```

The queue-ordering pin, `features/routing/pqueue.test.ts:101-106`:

```
  features/routing/pqueue.test.ts  (lines 101-106)

  it("orders a large-finite BLOCKED priority to the back", () => {
    const pq = new PQueue<string>();
    pq.push("blocked", 1e9);     ← the steep-edge priority
    pq.push("ok", 10);
    expect(pq.peek()).toBe("ok"); ← normal priority wins; 1e9 waits, doesn't crash
  });
```

The presentation pin, `features/map/geojson.test.ts` (`routeToGeoJSON`
block): an over-max climb colors grey (`#9aa0a6`), the *same edge* descending
colors green (`#2e9e3f`) — the directed sentinel surviving to the rendered
route.

---

## Elaborate

This is **sentinel-value** design — using an in-band special value to mean a
special condition — with a twist: the sentinel is chosen *finite* precisely so
it keeps participating in arithmetic and ordering. It's the same instinct
behind using `-1` for "not found" instead of throwing, or `Number.MAX_SAFE_INTEGER`
as a "effectively unbounded" cap — but here the design reason is sharper:
graph search relaxation (`tentative < best`) and the heap comparison both need
a *total order*, and `Infinity` breaks down the moment two infinite costs would
be subtracted or compared for "which steep route is less bad."

The testing lesson generalizes past flattr: **a distinction is only real if you
test both sides of it.** It's easy to test "steep returns a path" and feel
covered — but the regression you actually fear (steep silently becoming `null`)
only gets caught by the *paired* test that also asserts disconnected returns
`null`. Whenever your system has two adjacent states that must not merge
(empty vs invalid, expired vs missing, throttled vs failed), the test is the
pair, not the single case.

This ties back to `02-property-and-invariant-tests.md`: the reason `1e9` is
safe in the heap is that the heap explicitly forbids `NaN`
(`pqueue.ts:24`) — a finite sentinel never generates one, while `Infinity`
arithmetic could. The fixture used here (`directionalGraph`, mutated to
steep-only) comes from `04-fixture-driven-graph-tests.md`. And the *meaning* of
the grade bands the color test asserts (green/yellow/red/grey) is the grade
classification in `features/grade/classify.ts`.

---

## Interview defense

**Q: A user asks for a route where the only path is too steep. What should the
router return, and how do you test it?** Not `null` — that's "no route," a
different answer. It should return the steep path *and flag the steep edges*, so
the UI can say "here's a route, but it climbs 12%." The implementation choice
that enables this: too-steep edges cost a large *finite* sentinel (`BLOCKED =
1e9`), not `Infinity`. Test it with a *pair*: a steep-only graph returns a
flagged path, a disconnected graph returns `null`. Either test alone doesn't
prove they're distinct.

```
  steep-only graph  → path + steepEdges (not null)
  disconnected node → null
  ── the PAIR is the test ──
```

**Q: Why finite and not `Infinity`?** Two reasons. First, ranking: with
`Infinity`, all steep routes are equally impossible — you can't pick the
least-bad one. Finite keeps them ordered, so the router returns the *best*
steep path. Second, safety: `Infinity` arithmetic produces `NaN`, and the heap
explicitly throws on `NaN` priorities (`pqueue.ts:24`). A finite sentinel never
generates one. Anchor: `cost.test.ts:81-86` asserts the steep cost is
`> BLOCKED` *and* `isFinite`.

**Q: How do you know the sentinel doesn't break the priority queue?** A direct
test: push `1e9` and `10`, assert `peek()` returns the `10`-priority item
(`pqueue.test.ts:101-106`). `1e9 < Infinity`, so it orders to the back via the
plain `<` comparison without poisoning anything. The steep edge waits its turn;
it doesn't crash the heap.

---

## Validate

**Reconstruct.** Write the three kernel parts (finite sentinel, paired
distinct tests, warning flag) and what each prevents if removed.

**Explain.** Why is `expect(c).toBeGreaterThan(BLOCKED)` *and*
`expect(Number.isFinite(c)).toBe(true)` both needed in `cost.test.ts:84-85`?
What does each one independently catch?

**Apply.** A teammate refactors `penalty` to `return Infinity` for over-max
grades, "to simplify." List every test that fails and which layer each is
defending. (Hint: at least `cost.test.ts:81-86`, and indirectly the
search-layer pair if the search then returns `null` for steep-only.)

**Defend.** A reviewer says "just return `null` for too-steep, it's simpler."
Argue against it with the user-facing consequence. (Hint: the user can no
longer tell "too steep" from "no road there" — the product's whole "show me the
flattest route, even if it's steep" premise breaks.)

References: `features/routing/cost.ts:4-22`,
`features/routing/cost.test.ts:55-86`, `features/routing/astar.test.ts:82-96`,
`features/routing/pqueue.test.ts:101-106`,
`features/map/geojson.test.ts` (routeToGeoJSON block).

---

## See also

- `02-property-and-invariant-tests.md` — the heap forbids NaN
  (`pqueue.ts:24`), which is *why* a finite sentinel is safe and Infinity isn't.
- `04-fixture-driven-graph-tests.md` — the `directionalGraph` mutation
  (`astar.test.ts:84`) that builds the steep-only case.
- `01-optimality-oracle.md` — the oracle tests run on graphs where nothing is
  BLOCKED, isolating the "clean optimum" case from this "least-bad steep" one.
- `audit.md` §5 (edge-case coverage).
- `.aipe/study-dsa-foundations/` — relaxation and ordering in shortest-path
  search, which require a total order (why not Infinity).
