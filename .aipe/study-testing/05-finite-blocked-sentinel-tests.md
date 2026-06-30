# 05 — Finite-BLOCKED Sentinel Tests

**Industry names:** *sentinel value testing* / *testing a saturating cost* / *distinguishing
"degraded" from "impossible"*. **Type:** Project-specific (the testing technique is general;
this exact distinction is flattr's).

---

## Zoom out, then zoom in

flattr's whole product promise is "we'll find you a flat route — and if we can't, we'll be
honest about it." That honesty has two failure shapes that must never be confused: *"the
only route is too steep"* (return it, flag it) versus *"there is no route at all"* (return
null). The design choice that keeps them distinct is `BLOCKED = 1e9` — a large *finite*
number, not `Infinity`. And a whole class of tests exists only to defend that choice.

```
  Zoom out — where the sentinel lives and what it protects

  ┌─ features/routing/cost.ts:5 ── BLOCKED = 1e9 (finite!) ────┐
  │   penalty(g > max) → BLOCKED   (not Infinity)              │
  └────────────────────────────┬───────────────────────────────┘
                               │ flows into every cost function
  ┌─ the two outcomes it keeps distinct ──▼────────────────────┐
  │  steep-but-only path  → returned, steepEdges flagged       │
  │  genuinely disconnected → path is null                     │
  │                                                            │
  │  ★ tests pin BOTH (astar.test.ts:82 / :91) ★ ← THIS CONCEPT│
  └────────────────────────────────────────────────────────────┘
```

Here's the trap: if `BLOCKED` were `Infinity`, a too-steep edge would have infinite cost,
the search would treat it as impassable, and an only-steep route would come back as `null` —
indistinguishable from a disconnected graph. The user would see "no route" when the truth is
"a steep route exists." The finite sentinel keeps the steep path *in the running* (just
expensive), so it's returned and flagged. The tests are what stop someone from "simplifying"
`1e9` to `Infinity` and silently breaking the product.

---

## The structure pass

Layer it, pick the axis — **"can this path still be returned?"** — and watch it flip at the
sentinel boundary.

```
  axis traced: "is this path still returnable?"

  ┌─ flat / moderate edge ──────────────────────────┐
  │  cost = length × small penalty → YES, cheap      │
  └───────────────────────┬──────────────────────────┘
                          │  seam: grade crosses userMax
  ┌─ too-steep edge (BLOCKED finite) ─▼─────────────┐
  │  cost = length × HUGE but finite → YES, but only │  ← still returnable!
  │  if it's the ONLY option; flagged as steep       │
  └───────────────────────┬──────────────────────────┘
                          │  seam: no edge at all
  ┌─ disconnected ────────▼──────────────────────────┐
  │  no path exists → null                           │  ← genuinely impossible
  └──────────────────────────────────────────────────┘
```

The load-bearing seam is the middle one: a too-steep edge is *expensive*, not *impossible*.
That's the finite sentinel's entire job — keep "degraded" on the returnable side of the line
and reserve `null` for "impossible." If `BLOCKED` were `Infinity`, that middle band would
collapse into the bottom one, and "steep" would masquerade as "no route." The tests pin all
three bands so the collapse can't happen unnoticed.

---

## How it works

### Move 1 — the mental model

You've used a sentinel before — `-1` for "not found" in an index search, or `NaN` to mean
"no value." The trick is picking a sentinel that's *in the same number space* as real values
so arithmetic still works on it. `BLOCKED = 1e9` is that: it's enormous (any real route cost
is in the thousands of meters, so `1e9` always loses to a real alternative) but it's a normal
float — you can add to it, compare it, sum a path through it. `Infinity` can't do that
cleanly: `Infinity` makes a path uncomparable, so the search discards it entirely.

```
  the sentinel band — finite keeps "steep" returnable

  cost scale (meters-ish):

   0 ────── real routes ────── ~thousands ┄┄┄ 1e9 (BLOCKED) ┄┄┄ ∞
                                                  ▲
                       a steep edge lands HERE: astronomically
                       expensive, but FINITE → still summable,
                       still comparable, still returnable if it's
                       the only path. Infinity would fall off the
                       right edge → discarded → looks like "no route"
```

Strategy in one sentence: **pick a sentinel big enough to always lose but finite enough to
still be returned, then test both "it loses" and "it's still there."**

### Move 2 — the walkthrough

**Part 1 — the sentinel is finite by deliberate design, and the comment says why.** This is
the one line the whole pattern protects:

```ts
// features/routing/cost.ts:4-5  (annotated)
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

The doc comment is a warning to the next engineer: *don't make this Infinity.* The cost
functions multiply by it but never produce `Infinity`, so a path summing several blocked
edges is still a finite, comparable number.

**Part 2 — the cost test pins that BLOCKED stays finite even when stacked.** The subtle bug
is a path through *multiple* steep edges — does the cost still stay finite and comparable?

```ts
// features/routing/cost.test.ts:81-86  (annotated)
it("gradeCostDirected blocks a too-steep climb but stays finite", () => {
  const e = edgeAt(9);                          // 9% grade, over userMax of 5
  const c = gradeCostDirected(e, "A", max);
  expect(c).toBeGreaterThan(BLOCKED);           // it IS the blocked-tier cost
  expect(Number.isFinite(c)).toBe(true);        // ← but FINITE. the load-bearing assert
});
```

`Number.isFinite(c)` is the assertion that fails the instant someone swaps `1e9` for
`Infinity`. It's a direct guard on the design invariant. (`penalty` over max returns
`BLOCKED` exactly — `cost.test.ts:55` — and the cost function multiplies length in, so the
edge cost is `> BLOCKED` but still finite.)

**Part 3 — the routing test proves a steep-only path is RETURNED and FLAGGED.** Now the
behavior the sentinel buys, end to end:

```ts
// features/routing/astar.test.ts:82-89  (annotated)
it("still returns an only-steep path and flags the steep edge", () => {
  const g = directionalGraph();
  g.edges = g.edges.filter((e) => e.id === "xy");   // delete the flat detour — leave only steep
  g.adjacency = { X: ["xy"], Y: ["xy"], F: [] };
  const r = directedAstar(g, "X", "Y", 5);
  expect(r.path).not.toBeNull();                    // ← NOT null: the steep path is returned
  expect(r.path!.steepEdges).toEqual(["xy"]);       // ← and HONESTLY flagged as steep
});
```

Walk it: remove every flat option so `xy` (8% > userMax 5) is the only way from X to Y. A
naive `Infinity` design would return `null` here ("no route"). flattr returns the path —
because `BLOCKED` is finite, the search still ranks and reconstructs it — *and* tags `xy` in
`steepEdges` so the UI can warn the user. This is the product promise, tested.

**Part 4 — the contrast test proves null is reserved for genuinely disconnected.** The other
half of the distinction — null must still mean *impossible*, not *steep*:

```ts
// features/routing/astar.test.ts:91-96  (annotated)
it("returns null only when genuinely disconnected, not when merely steep", () => {
  const g = directionalGraph();
  g.nodes["ISO"] = { id: "ISO", lat: 9, lng: 9, elevationM: 0 };  // an island node
  g.adjacency["ISO"] = [];                                         // no edges at all
  expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();        // ← null = truly no route
});
```

The two tests together draw the line: `:82` says *steep ≠ null*, `:91` says *disconnected =
null*. Read them as a pair — that pairing IS the pattern:

```
  the two-test pair that defends the distinction

  test               input                        asserts
  ────               ─────                         ───────
  astar.test.ts:82   only-steep edge remains       path NOT null + steepEdges flagged
  astar.test.ts:91   isolated node, no edges       path IS null

  together: "steep" and "impossible" can never collapse into each other
```

**Part 5 — the sentinel even shows up in the priority-queue test.** The finiteness has to
survive the heap ordering too — a `1e9` priority must sort to the back, not get special-cased:

```ts
// features/routing/pqueue.test.ts:101-106  (annotated)
it("orders a large-finite BLOCKED priority to the back", () => {
  const pq = new PQueue<string>();
  pq.push("blocked", 1e9);                  // the BLOCKED-tier priority
  pq.push("ok", 10);
  expect(pq.peek()).toBe("ok");             // ← "ok" comes first; blocked sits at the back
});
```

The heap treats `1e9` as just a large number (because it is one), so a blocked path naturally
sorts last and gets expanded only if nothing better exists. With `Infinity` you'd risk
comparison oddities. The sentinel's finiteness is load-bearing at *every* layer it touches —
cost, search, and queue — and there's a test at each.

### Move 2 variant — the load-bearing skeleton

Strip finite-sentinel testing to its kernel:

1. **A sentinel in the real value space** — `1e9`, a normal float. *Make it `Infinity`* and
   it falls out of the comparable range; the steep path becomes unreturnable and masquerades
   as null.
2. **A "stays finite" assertion** — `Number.isFinite(c)` (`cost.test.ts:84`). *Remove it* and
   nothing stops a future refactor from swapping in `Infinity`; the guard is gone.
3. **The two-outcome contrast pair** — steep-returned (`:82`) AND disconnected-null (`:91`).
   *Drop either one* and the distinction is half-tested: you'd catch a regression on one
   outcome but silently allow the two to collapse.

The part people forget is **#3 — testing the contrast, not just one branch**. It's easy to
test "steep path is returned" and feel done. But the *value* of the finite sentinel is the
*distinction*, and a distinction needs both sides asserted. One test without the other proves
the wrong thing.

**Skeleton vs hardening:** the kernel is finite-sentinel + isFinite-guard + the contrast
pair. The pqueue ordering test (`:101`) is hardening — it confirms the sentinel behaves at a
third layer — but the cost+routing pair is the load-bearing defense.

### Move 3 — the principle

**When your code has two failure modes that look alike but mean different things to the user,
encode the difference in a value the type system and arithmetic preserve — then test both
sides of the line.** "Degraded but possible" and "genuinely impossible" are different
promises; collapsing them is a product bug, not just a code bug. flattr's `1e9` is the
encoding and the `isFinite` + steep-returned + disconnected-null trio is the defense. The
generalization: any saturating quantity (a maxed-out retry budget, a clamped score, a
rate-limit ceiling) wants a finite sentinel and a test that proves it saturates *without*
becoming "impossible."

---

## Primary diagram

```
  FINITE-BLOCKED SENTINEL TESTS — full recap

  ┌─ cost.ts:5 ── BLOCKED = 1e9 (finite, NOT Infinity) ────────┐
  │  penalty(g > userMax) → BLOCKED                            │
  └────────────────────────────┬───────────────────────────────┘
                               │ multiplied into cost; never → Infinity
        ┌──────────────────────┼──────────────────────────┐
        ▼                      ▼                          ▼
  ┌─ cost test ───┐   ┌─ routing tests (the pair) ──┐  ┌─ pqueue test ─┐
  │ isFinite(c)   │   │ :82 steep-only → returned   │  │ :101 1e9 sorts│
  │ == true       │   │     + steepEdges flagged    │  │  to the back  │
  │ (test:84)     │   │ :91 disconnected → null     │  │               │
  └───────────────┘   └─────────────────────────────┘  └───────────────┘
       guards the         defends the DISTINCTION:        confirms finite
       finiteness         steep ≠ impossible              at the queue layer

   if 1e9 → Infinity: steep collapses into null → "no route" lie → tests go RED
```

---

## Elaborate

This is **sentinel value testing** with a domain twist: the sentinel isn't just "absent/
error," it's a *saturating cost* that has to keep participating in arithmetic. The choice of
`1e9` over `Infinity` is the kind of subtle design decision that's invisible until it breaks
in production as a confusing "no route found" — which is precisely why the spec
(`docs/flattr-spec.md` §14.4, per project context) and the project's must-not-change
constraints call it out, and why the tests pin it at three layers.

It's downstream of `04-fixture-driven-graph-tests.md` (the steep `directionalGraph` and the
isolated-`ISO`-node setups are fixtures shaped for exactly this) and it's why the optimality
oracle (`01`) still returns a path on steep graphs rather than null. The three patterns
interlock: shaped fixtures provide the steep/disconnected inputs, the finite sentinel keeps
the steep one returnable, and the oracle confirms the returned path is still optimal among
the steep options.

Where to read next: `04-fixture-driven-graph-tests.md` (the inputs), `01-optimality-oracle.md`
(why steep paths stay optimal), and `audit.md` lens 5 (error/boundary paths).

---

## Interview defense

**Q: "Your router has two 'failure' cases — too steep and no route. How do you keep them
distinct, and how do you test it?"**

> "I encode the difference in the cost: `BLOCKED` is `1e9`, a large *finite* number, not
> `Infinity`. Finite means a too-steep edge is astronomically expensive but still comparable
> and summable — so if it's the only path, the search still returns it, flagged as steep.
> `Infinity` would make it uncomparable and the path would come back null, indistinguishable
> from a disconnected graph — the user sees 'no route' when a steep route exists. I test it as
> a pair: one test deletes every flat option and asserts the steep path is returned *and* its
> edge is in `steepEdges`; the other isolates a node and asserts null. Plus an
> `expect(Number.isFinite(c)).toBe(true)` that fails the moment someone swaps in Infinity.
> `astar.test.ts:82` and `:91`, `cost.test.ts:84`."

```
  sketch while you talk:

  BLOCKED = 1e9 (finite) ──► steep path still RETURNABLE + flagged
       │                                  vs
  reserve null for ──────► genuinely disconnected
       │
  test the CONTRAST (both sides) — not just one branch
```

**Anchor:** *"The value of the finite sentinel is the distinction, so I test the contrast —
steep-returned AND disconnected-null — not just one side."*

---

## See also

- `04-fixture-driven-graph-tests.md` — the steep/disconnected fixtures these tests use
- `01-optimality-oracle.md` — why a returned steep path is still the optimal steep path
- `02-property-invariant-tests.md` — `pqueue.test.ts:101` (the sentinel at the queue layer)
- `audit.md` lens 5 (boundary/error paths), and the project's must-not-change constraints
