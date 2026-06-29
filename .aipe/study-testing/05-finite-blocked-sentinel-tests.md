# 05 — Finite-BLOCKED Sentinel Tests

**Industry names:** sentinel value testing · semantic-distinction testing ·
guarding a domain invariant in tests. **Type:** Project-specific (the
`BLOCKED = 1e9 ≠ Infinity` decision is flattr's own, from `docs/flattr-spec.md`
§14.4).

---

## Zoom out — where this lives

flattr has two failure modes that *look* identical to a naive router but mean
opposite things to a user: "there's a route, but it's too steep for you" vs
"there's no route at all." The whole design hinges on keeping them distinct, and
a cluster of tests exists to pin that distinction.

```
  Zoom out — the sentinel keeps two failures distinct

  ┌─ cost layer ────────────────────────────────────────────────┐
  │  penalty(g > max) → ★ BLOCKED = 1e9 (large FINITE) ★         │ ← we are here
  │                     NOT Infinity                            │
  └───────────────────────────┬─────────────────────────────────┘
                              │ router still relaxes BLOCKED edges
  ┌─ router layer ────────────▼─────────────────────────────────┐
  │  too steep → RETURNS the path + flags steepEdges            │
  │  disconnected → returns null                                │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ user ────────────────────▼─────────────────────────────────┐
  │  "steep but possible" ≠ "nowhere to go" — different UX       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: if "too steep" cost were `Infinity`, the router's `cost < best`
comparison would treat a steep edge as *unusable* and return `null` — collapsing
"steep route exists" into "no route." Making BLOCKED a large *finite* number
means the router still traverses it (reluctantly), returns the path, and flags
the steep edges. The tests are the guardrail that keeps anyone from "tidying"
`1e9` into `Infinity`.

---

## Structure pass

**Layers:** the sentinel constant (`cost.ts`) → the router that honors it
(`astar.ts`) → the user-visible outcome. One value, traced up three layers.

**Axis — "what does this failure mean to the user?"** Held constant down the
stack:

```
  axis = "is there a usable answer here?"  — traced downward

  ┌─ cost.ts ───────────────┐
  │ steep edge → 1e9 finite  │  → "expensive, but a number"
  └────────────┬─────────────┘
  ┌────────────▼─────────────┐
  │ router relaxes it anyway  │  → "path found, edges flagged"
  └────────────┬─────────────┘
  ┌────────────▼─────────────┐
  │ user sees a steep route   │  → "possible, here's the warning"
  └───────────────────────────┘

  vs. disconnected → no edge at all → router returns null → "no route"
```

The axis-answer is "yes, but costly" for steep and "no" for disconnected. The
sentinel is what keeps those two answers from collapsing into one.

**Seam:** `penalty(g > max) === BLOCKED` *and* `Number.isFinite(cost) === true`.

---

## How it works

### Move 1 — the mental model

You've used a sentinel before — `-1` from `indexOf` to mean "not found,"
`null` vs `undefined` to mean different absences. The trap is overloading *one*
sentinel for *two* meanings. flattr deliberately uses two distinct signals:
a large finite number for "too steep" and genuine absence (`null`) for "no
route." The tests exist to prove they never merge.

```
  one value, two failure semantics — kept distinct

   penalty result        router output       meaning
   ─────────────────     ──────────────      ──────────────────
   1e9 (BLOCKED)    ──►  path + steepEdges ──► "steep, possible"
   no edge exists   ──►  null              ──► "no route at all"

   (if BLOCKED were Infinity, the top row collapses into the bottom)
```

### Move 2 — the walkthrough

**The constant declares the intent.** `cost.ts:5` makes the choice explicit and
the threshold test pins it:

```ts
// cost.ts:5
export const BLOCKED = 1e9;   // large FINITE, deliberately not Infinity

// cost.test.ts:55-58 — over-max returns the sentinel
it("returns BLOCKED above max", () => {
  expect(penalty(5.01, max)).toBe(BLOCKED);
  expect(penalty(20, max)).toBe(BLOCKED);
});
```

**The finiteness itself is asserted — this is the load-bearing test.** A steep
climb costs *more than* BLOCKED (length added on top) but must stay finite, or
the router's arithmetic breaks:

```ts
// cost.test.ts:81-86 — the distinction, pinned
it("gradeCostDirected blocks a too-steep climb but stays finite", () => {
  const e = edgeAt(9);
  const c = gradeCostDirected(e, "A", max);
  expect(c).toBeGreaterThan(BLOCKED);     // it IS blocked-tier
  expect(Number.isFinite(c)).toBe(true);  // ← but FINITE — the whole point
});
```

`Number.isFinite(c)` is the assertion that would fail the instant someone
changed `1e9` to `Infinity`. It's small, but it's guarding the project's most
subtle correctness rule.

**The router honors the distinction — three tests, three outcomes.** The payoff
is at the routing layer (`astar.test.ts:73-97`), where the same fixture produces
all three behaviors:

```ts
// astar.test.ts:82-89 — steep-only path is RETURNED and FLAGGED, not dropped
g.edges = g.edges.filter((e) => e.id === "xy");   // leave only the steep edge
const r = directedAstar(g, "X", "Y", 5);
expect(r.path).not.toBeNull();             // ← NOT null: the route exists
expect(r.path!.steepEdges).toEqual(["xy"]); // ← flagged as steep

// astar.test.ts:91-96 — genuinely disconnected → null
g.nodes["ISO"] = ...; g.adjacency["ISO"] = [];
expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();   // ← null: no route
```

```
  the three-way truth table the tests pin

  scenario                router result        assertion
  ──────────────────────  ──────────────────   ────────────────────
  flat route available    direct path          nodes == [...]
  only-steep route        path + steepEdges     not null, steepEdges
  disconnected            null                  toBeNull()
```

**The heap also respects it.** Because BLOCKED is finite, it sorts correctly in
the priority queue — a steep edge goes to the *back*, not into undefined-ordering
territory:

```ts
// pqueue.test.ts:101-106 — BLOCKED-priority item orders to the back
pq.push("blocked", 1e9);
pq.push("ok", 10);
expect(pq.peek()).toBe("ok");   // finite BLOCKED still compares cleanly
```

That's the cross-cutting consequence: a finite sentinel participates in normal
comparisons (sorting, `<`, arithmetic), where `Infinity` would poison
`Infinity - Infinity = NaN` and break the relaxation step.

### Move 2 variant — the load-bearing skeleton

```
  a sentinel that is a NORMAL value (finite, comparable)
  +  a test that the sentinel is returned at the threshold
  +  a test that the result stays finite (the anti-Infinity guard)
  +  router tests proving steep≠disconnected (path+flag vs null)
```

What breaks without each:

- **Sentinel as Infinity** → `cost < best` treats steep as unusable; "steep
  route" returns `null`; the product's core feature (show the flat-ish way *and*
  fall back to flagged-steep) silently dies.
- **No finiteness assertion** → nothing stops a refactor from "simplifying"
  `1e9` to `Infinity`; the test is the only documentation of *why* it's finite.
- **No three-way router test** → you can't tell whether `null` means "steep" or
  "disconnected" — the two failures are indistinguishable in the test suite, so
  a regression that collapses them passes.

### Move 3 — the principle

**When two failures mean different things to the user, they must be two distinct
signals in the code — and a test must pin the distinction so a refactor can't
merge them.** The general lesson: a sentinel that participates in normal
operations (finite, comparable) is safer than one that doesn't (`Infinity`,
`NaN`, `null` overloaded for two meanings), and the *test that asserts the
sentinel's type* (`Number.isFinite`) is what protects a non-obvious design choice
from a well-meaning cleanup. This is testing as executable documentation of
intent.

---

## Primary diagram

```
  BLOCKED traced from constant to UX, with its tests

  cost.ts:5  BLOCKED = 1e9 (finite)
      │  cost.test.ts:55  → returned at threshold
      │  cost.test.ts:81  → result stays FINITE (anti-Infinity guard)
      ▼
  astar.ts  router relaxes BLOCKED edges (finite → still comparable)
      │  astar.test.ts:82  → steep-only path RETURNED + steepEdges flagged
      │  astar.test.ts:91  → disconnected → null
      ▼
  pqueue.ts  BLOCKED sorts to the back (finite → clean comparison)
      │  pqueue.test.ts:101  → "ok" peeked before "blocked"
      ▼
  user:  "steep but possible" (warned)  ≠  "no route" (null)
```

---

## Elaborate

The finite-sentinel choice is a known numerical-computing pattern: avoid
`Infinity`/`NaN` in arithmetic that feeds comparisons, because they propagate
(`Inf - Inf = NaN`, and any comparison with `NaN` is false, which silently breaks
the `cost < best` relaxation that Dijkstra/A* depend on). flattr's spec calls
this out explicitly (§14.4), and the test suite enforces it at three layers. The
honest limit: `1e9` is a *magic threshold* — if a legitimate route ever
accumulated cost near `1e9` (a path with thousands of steep edges), a real route
could be mistaken for blocked-tier. The current fixtures don't probe that
boundary; a worthwhile addition is a test that a long flat route never crosses
`BLOCKED` by accumulation alone. That's the one untested corner of an otherwise
well-guarded invariant.

---

## Interview defense

**Q: Why is "too steep" a large finite number instead of Infinity?**

> Because "too steep" and "no route" are different answers to the user, and
> Infinity collapses them. With Infinity, the router's `cost < best` check treats
> a steep edge as unusable and returns null — so a steep-but-walkable route
> disappears. A large *finite* BLOCKED keeps the edge comparable: the router
> still traverses it, returns the path, and flags the steep edges.
> `cost.test.ts:81` asserts `Number.isFinite` precisely to stop a refactor from
> "tidying" it to Infinity.

```
  steep edge → 1e9 finite → router returns path + steepEdges flag
  (Infinity → router returns null → feature dies)
```

**Q: How do you test that two different failures stay distinct?**

> Drive the same fixture to both outcomes and assert they differ. flattr's
> `astar.test.ts` filters to a steep-only graph and asserts `path` is *not* null
> with `steepEdges` populated; then adds a disconnected node and asserts `null`.
> Two failures, two distinct assertions. Anchor: "if two failures mean different
> things to the user, the test suite has to be able to tell them apart — or a
> regression that merges them passes silently."

---

## See also

- `01-optimality-oracle.md` — the cost guard the oracle's blind spot relies on.
- `02-property-invariant-tests.md` — the heap's BLOCKED-orders-to-back case.
- `04-fixture-driven-graph-tests.md` — `directionalGraph()` drives these tests.
- `audit.md` lens 5 (edge/error paths), lens 7 (red-flag checklist).
- sibling `study-software-design` — sentinel-vs-overload as a design decision.
