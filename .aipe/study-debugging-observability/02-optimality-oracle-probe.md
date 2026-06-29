# The optimality oracle as a correctness probe

**Industry names:** differential testing / metamorphic oracle / "compute it a
second way and demand agreement"; the *reference implementation* check.
**Type:** Industry standard (the technique), applied repo-specifically.

---

## Zoom out, then zoom in

When the answer to "is this route correct?" can't be eyeballed — and a
shortest-path on a grid can't, a wrong path looks just as plausible as the right
one — you need a second opinion you trust more. flattr's second opinion is
Dijkstra: slow, dumb, uninformed, and *provably optimal*. If A* disagrees with
Dijkstra on cost, A* is wrong. That's the oracle.

```
  Zoom out — where the oracle sits

  ┌─ Engine layer (features/routing/) ──────────────────────────┐
  │  astar()        ← fast, heuristic-guided, the thing tested  │
  │  dijkstra()     ← slow, uninformed, the TRUSTED reference   │
  └─────────────────────────────┬───────────────────────────────┘
                                │  both return SearchResult { path }
  ┌─ Test/probe layer ──────────▼───────────────────────────────┐
  │  ★ assert a.path.cost ≈ d.path.cost  (the oracle) ★         │ ← we are here
  │  astar.test.ts:38-46                                        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **differential testing** — run the same input through two
implementations that should agree, and treat disagreement as a bug localized to
the *less-trusted* one. In `study-testing` this lives as a release gate. Here
it's a *debugging probe*: when a route looks wrong in the app, you don't squint
at the map — you run Dijkstra on the same endpoints and compare. Disagreement
proves the bug is in the A* path (heuristic or cost), not in your perception.

---

## The structure pass

**Layers:** two engine implementations (`astar`, `dijkstra`) under one probe.

**Axis traced — "who is trusted to be correct?"** Hold it across the pair:

```
  axis = "who is trusted?"  — trace it across the two impls

  ┌─ dijkstra() ────────────┐   → TRUSTED. uninformed, explores
  │  zero heuristic         │     everything, provably optimal.
  └───────────┬──────────────┘     the reference.
              │  same graph, same start/goal
  ┌─ astar() ─▼─────────────┐   → UNDER TEST. heuristic could be
  │  haversine heuristic    │     inadmissible → wrong answer.
  └───────────┬──────────────┘     the suspect.
  ┌─ probe ───▼─────────────┐   → the seam: cost.toBeCloseTo(d.cost)
  │  demand agreement       │     trust flips here. if they differ,
  └──────────────────────────┘     blame the suspect.
```

**The seam — the `toBeCloseTo` assertion (`astar.test.ts:42-43`).** Trust flips
across it: Dijkstra's answer enters as ground truth, A*'s answer enters as a
claim, and the assertion is the boundary where the claim is checked against the
truth. The reason this seam is load-bearing: it only works because Dijkstra and
A* solve the *same problem* (shortest path, distance cost) — A* just does it
faster. If you changed A*'s cost function without changing Dijkstra's, the oracle
would fire on a non-bug. The contract at this seam is "same problem, two
methods."

---

## How it works

### Move 1 — the mental model

You know how, when a unit test's expected value is itself hard to compute, you
sometimes compute it a second way in the test to avoid hard-coding a number you
might get wrong? This is that, scaled up: the "second way" is an entire
algorithm. A* is the optimized path you ship; Dijkstra is the brute-force you'd
*never* ship but completely trust.

```
  The oracle — two roads to one truth

         graph + start + goal
            │            │
            ▼            ▼
       ┌─────────┐  ┌──────────┐
       │ dijkstra│  │  astar   │
       │ (trust) │  │ (suspect)│
       └────┬────┘  └────┬─────┘
            │            │
         cost_d        cost_a
            └─────┬──────┘
                  ▼
         assert cost_a ≈ cost_d
                  │
          ┌───────┴────────┐
          │ agree → A* OK  │
          │ differ → A* BUG│  ← localized to the suspect
          └────────────────┘
```

The power move: when they *differ*, you don't have to wonder where the bug is.
Dijkstra is trusted, so the bug is in A* — specifically the heuristic
(inadmissible? returning more than the true remaining cost?) or the cost function
A* uses. The oracle doesn't just detect the bug; it *localizes* it.

### Move 2 — the step-by-step walkthrough

**The probe itself — assert the two costs agree.** This is the canonical place
the oracle lives (`features/routing/astar.test.ts:38-46`):

```typescript
// features/routing/astar.test.ts:38-46
it("returns the SAME optimal path as Dijkstra (correctness gate)", () => {
  const g = makeGridGraph(12);
  const d = dijkstra(g, "0,0", "11,11");   // the trusted reference
  const a = astar(g, "0,0", "11,11");      // the implementation under test
  expect(a.path).not.toBeNull();
  expect(a.path!.cost).toBeCloseTo(d.path!.cost, 6);     // ← the oracle
  expect(a.path!.lengthM).toBeCloseTo(d.path!.lengthM, 6);
});
```

Line by line: build a deterministic 12×12 grid (`:39`) — small enough to reason
about, big enough that a broken heuristic produces a measurably wrong cost. Run
both algorithms on the *same* endpoints (`:40-41`). Then the two assertions: cost
agrees to 6 decimal places (`:43`) and real distance agrees (`:44`). Note it
checks **cost AND length** separately — a subtle bug could match cost while
taking a different physical path, so both are pinned. `toBeCloseTo(…, 6)` rather
than `toBe` because both algorithms accumulate floating-point sums in different
orders; demanding bit-exact equality would produce false failures. That tolerance
choice is itself a debugging lesson: the oracle compares *up to float noise*, not
exactly.

**Why Dijkstra is the right oracle — it shares the engine but kills the
heuristic.** `dijkstra` and `astar` are both wrappers over one `search()`
(`astar.ts:135-143`): same loop, same heap, same cost. The *only* difference is
the heuristic — Dijkstra passes a zero heuristic, A* passes haversine. That makes
the oracle a precision instrument: since everything else is identical, a
disagreement can *only* be the heuristic. The oracle's resolution is exactly the
one variable that differs.

```
  Why the oracle localizes — only one variable differs

  ┌──────────────┬─────────────┬─────────────┐
  │              │  dijkstra   │  astar      │
  ├──────────────┼─────────────┼─────────────┤
  │ search loop  │  SAME       │  SAME       │
  │ binary heap  │  SAME       │  SAME       │
  │ cost fn      │  SAME       │  SAME       │
  │ heuristic    │  zero       │  haversine  │ ← ONLY difference
  └──────────────┴─────────────┴─────────────┘
   disagreement ⇒ the heuristic is the bug. nothing else CAN be.
```

**The second probe — the efficiency sanity check.** The oracle has a sibling that
checks the *other* property A* must hold (`astar.test.ts:48-52`):

```typescript
it("expands no more nodes than Dijkstra, usually far fewer", () => {
  const g = makeGridGraph(12);
  const d = dijkstra(g, "0,0", "11,11");
  const a = astar(g, "0,0", "11,11");
  expect(a.nodesExpanded).toBeLessThanOrEqual(d.nodesExpanded);  // admissibility signal
});
```

This is the oracle's complement: the cost probe checks A* is *correct*; this
checks A* is *informed*. If `a.nodesExpanded` ever *exceeds* Dijkstra's, the
heuristic collapsed to zero (or worse) and A* is doing extra work for nothing —
a different bug than a wrong cost, caught by a different probe on the same two
runs. It rides the counters from `01-in-band-search-instrumentation.md`.

**The oracle generalizes to the harder stages.** `bidirectional.test.ts:8-38`
applies the same move to bidirectional search: match Dijkstra's cost on a diamond
graph (`:8-14`), match directional A*'s cost on a grid (`:16-24`), and expand far
fewer nodes than Dijkstra (`:26-38`, "~43 << ~203"). Each new, faster algorithm
is validated against a slower one it must agree with. The reference chain is
`dijkstra → astar → bidirectional`, each link a differential test.

```
  Layers-and-hops — the oracle chain across stages

  ┌─ Test layer ────────────────────────────────────────────────┐
  │  dijkstra  ──agree on cost──►  astar  ──agree on cost──►      │
  │  (trusted)                    (now trusted)                   │
  │                                  └──agree on cost──► bidirectional│
  │  bidirectional.test.ts:8-38                                   │
  └──────────────────────────────────────────────────────────────┘
   each faster impl is checked against a slower one it must match.
```

### Move 2 variant — the load-bearing skeleton

The oracle's irreducible kernel, the smallest thing that's still the pattern:

1. **Isolate the kernel.** Two implementations of the same spec + one trusted +
   one assertion they agree on the same input. That's it. `cost_a ≈ cost_d` on
   the same graph.
2. **Name each part by what breaks without it.**
   - Drop the *trusted* reference (compare A* to A*) → you detect flakiness but
     can't say which side is wrong. The trust asymmetry is what localizes the bug.
   - Drop *same input* (different graphs) → the oracle fires on a non-bug; you
     chase ghosts.
   - Drop the *tolerance* (`toBe` instead of `toBeCloseTo`) → float noise makes
     it fail on correct code; you stop trusting the oracle and disable it.
3. **Skeleton vs hardening.** The kernel is "two ways, demand agreement." The
   efficiency check (`nodesExpanded <=`), the length-vs-cost split, and the
   multi-stage chain are *hardening* — they catch more bug classes, but the
   one-line cost assertion is already the oracle.

The interview payoff: naming that you need the reference to be *trusted and
independent*, not just "a second implementation," is the part people skip. Two
buggy-the-same-way implementations agree perfectly and prove nothing.

### Move 3 — the principle

**When you can't verify an answer directly, verify it by agreement with a
slower, dumber, trusted method.** This is differential testing, and it's the
single most powerful debugging tool in flattr because the domain (shortest path)
has no eyeball-able ground truth. The cost — you maintain a second algorithm you'd
never ship — is exactly what buys the localization: because Dijkstra differs from
A* in *one* variable, the oracle points at the bug, not just at its existence.

---

## Primary diagram

The full oracle: two roads, one trusted, the assertion that localizes any bug to
the suspect.

```
  The optimality oracle — full picture

  ┌─ Engine layer: features/routing/ ───────────────────────────────────┐
  │   one search() engine, two heuristics                              │
  │                                                                     │
  │   dijkstra(g, s, goal)          astar(g, s, goal)                   │
  │   heuristic = 0  (TRUSTED)      heuristic = haversine (SUSPECT)     │
  │        │                              │                             │
  │     SearchResult                  SearchResult                      │
  │     { path: cost_d }              { path: cost_a }                  │
  └────────┼──────────────────────────────┼─────────────────────────────┘
           │                              │
  ┌─ Probe layer: astar.test.ts:38-52 ────▼──────────┐
  │                                                   │
  │   expect(cost_a).toBeCloseTo(cost_d, 6)  ← CORRECT?│
  │   expect(a.nodesExpanded <= d.nodesExpanded) ← FAST?│
  │                                                   │
  │   differ ⇒ bug in SUSPECT (heuristic), localized  │
  └───────────────────────────────────────────────────┘
```

---

## Elaborate

Differential testing comes from compiler and database work — you find bugs in an
optimizing compiler by running optimized and unoptimized builds on the same
program and diffing the output; the unoptimized build is the oracle. CSmith and
SQLancer are the famous tools. flattr applies the same idea at the algorithm
level, and it works for the same reason: the optimization (A*'s heuristic) is
*supposed* to preserve the answer while changing only the work. Any divergence in
the answer is a bug in the optimization.

The adjacent concept is **metamorphic testing** — when you don't even have a
trusted reference, you assert *relationships* the output must satisfy (e.g.,
routing A→B→C costs at least as much as A→C). flattr doesn't do that yet; the
oracle is enough because Dijkstra *is* a trusted reference. What to read next:
`study-testing` for the oracle's life as a release gate, and
`01-in-band-search-instrumentation.md` for the counters the efficiency probe
reads.

---

## Interview defense

**Q: A user reports a route that looks wrong. No logs. How do you debug it?**

I make the machine prove me right or wrong. Run Dijkstra on the same two
endpoints (`dijkstra(g, start, goal)`) and compare its cost to A*'s. Dijkstra is
uninformed and provably optimal, so if A* agrees, the route is correct and the
user's intuition is off; if they differ, the bug is in A*'s heuristic or cost —
and since the two share one `search()` engine and differ only in the heuristic
(`astar.ts:135-143`), I know to look at the heuristic first.

```
  the probe, run live

   user's endpoints
        ├──► dijkstra → cost_d (trusted)
        └──► astar    → cost_a
   cost_a ≈ cost_d ?  yes → route is right, user's wrong
                      no  → heuristic bug, open cost.ts/heuristic
```

Anchor: *Dijkstra is the oracle; A* differing from it localizes the bug to one
variable.*

**Q: Why not just compare A* to a hard-coded expected path?**

Because on a 12×12 grid I'd compute the expected path by hand and get it wrong —
the bug would move into my test. Computing it a second way with a trusted
algorithm removes me from the loop. And the reference must be *independent*: two
implementations that share the bug agree and prove nothing. The tolerance matters
too — `toBeCloseTo(…, 6)` not `toBe`, because the two sum floats in different
orders.

Anchor: *the reference must be trusted AND independent, or it's not an oracle.*

---

## See also

- `01-in-band-search-instrumentation.md` — the `nodesExpanded` counter the
  efficiency probe asserts on.
- `03-route-honesty-signals.md` — the oracle proves the path is *optimal*; honesty
  signals report when even the optimal path is *bad*.
- `study-testing` — the same oracle as a release gate (its home).
- `audit.md` — lens 2 (controlled experiments) and lens 6 (state snapshots).
