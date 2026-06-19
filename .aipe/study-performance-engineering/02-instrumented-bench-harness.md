# Instrumented bench harness — proving the win in nodes expanded

**Industry name:** algorithm microbenchmark with in-loop instrumentation /
counter-based profiling.
**Type:** Project-specific (the harness) over an industry-standard idea
(counting logical work, not wall-clock).

---

## Zoom out, then zoom in

A claim like "A* is faster than Dijkstra" is worth nothing without a number that's
*reproducible* and *machine-independent*. Wall-clock ms isn't it — on a graph this
small, ms is dominated by JIT warmup and noise. The metric that actually measures
search work is **nodes expanded**: how many nodes the algorithm finalized. It's
deterministic, it reproduces exactly, and it's the honest proxy for latency at any
scale.

Here's where the harness sits — it's a thin measurement shell wrapped around the
real engine.

```
  Zoom out — the measurement layer

  ┌─ bench/ (measurement shell) ──────────────────────────────────┐
  │  run.ts:  fixtures → run 5 stages → collect SearchResult        │
  │  report.ts: ★ formatTable → aligned comparison table ★          │ ← here
  │  report.test.ts: asserts the table renders                     │
  └───────────────────────────────┬───────────────────────────────┘
                                   │  reads counters off
  ┌─ features/routing/ (instrumented engine) ▼────────────────────┐
  │  search(): nodesExpanded++ / pushes++ / pops++                  │
  │  returns SearchResult { path, nodesExpanded, pushes, pops }     │
  └─────────────────────────────────────────────────────────────────┘
```

The pattern: **count the logical operation inside the hot loop, return the count
as data, and diff the counts across implementations.** No sampling profiler
needed — the algorithm tells you exactly how much work it did.

## Structure pass

Trace the **cost axis** — "what unit of work is being counted, and where does the
count come from?" — down three layers.

```
  One question down the layers: "where does the work-count live?"

  ┌─ bench/run.ts ─────────────────────────────────┐
  │ picks fair workloads, times wall-clock          │  → ms (noisy)
  └───────────────────────┬─────────────────────────┘
                          │  the trustworthy number flips IN here
  ┌─ features/routing/search() ▼────────────────────┐
  │ nodesExpanded++ at the moment a node finalizes   │  → expanded (exact)
  └───────────────────────┬──────────────────────────┘
  ┌─ SearchResult (the data) ▼───────────────────────┐
  │ carries the counts out to whoever wants them      │  → the seam to the bench
  └────────────────────────────────────────────────────┘
```

**Axis = cost (work counted).** The bench layer can only *time* — it has no
visibility into how many nodes were touched. The trustworthy number is born one
layer down, inside `search()`, at the exact line a node is finalized. The
`SearchResult` type is the **seam**: it's the contract that carries `nodesExpanded
/ pushes / pops` out of the engine and into the table. The cost-axis answer flips
at the engine boundary — above it you have wall-clock noise, below it you have the
deterministic count.

This is also the seam shared with `.aipe/study-debugging-observability/` — same
counters, different lens. Here they're an **optimization** signal (did the change
reduce work?); there they're an **evidence** signal (what is the search doing?).

## How it works

### Move 1 — the mental model

You've added a `console.count()` inside a loop to see how many times it ran. This
is that, but principled: instead of logging, the count is *returned as part of the
result*, so a harness can collect it across runs and tabulate. The mental shift is
"the metric is data, not a side effect."

The shape — instrument the hot loop, return counts, diff across implementations:

```
  Counter-based benchmarking

  ┌─ run each algorithm ─────────────────────────────┐
  │  result = algorithm(graph, start, goal)           │
  │  result carries { nodesExpanded, pushes, pops }   │
  └───────────────────────┬───────────────────────────┘
                          │  collect into a row
  ┌─ rows[] ──────────────▼───────────────────────────┐
  │  { algorithm, expanded, pushes, pops, ms, cost }   │
  └───────────────────────┬───────────────────────────┘
                          │  formatTable
  ┌─ aligned comparison table ▼───────────────────────┐
  │  dijkstra  1079  ...  cost 2400                    │
  │  astar      276  ...  cost 2400  ← diff is visible │
  └─────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

#### Part 1 — the counter lives inside the loop

`nodesExpanded` increments at the exact moment a node is finalized — popped, not
stale, added to the closed set. Not before (you'd count nodes you never
processed), not on push (you'd count the open set, a different quantity).
**Increment it in the wrong place and the comparison silently lies** — e.g.
counting pushes as "expanded" would make A* look worse than it is.

```
  Where each counter ticks (one tick per event)

  pop a node ─────────────► pops++          (every pop, incl. duplicates)
     │
     ├─ stale (already closed)? skip, do NOT count as expanded
     │
     └─ fresh ─────────────► nodesExpanded++ (finalized work)
            │
            └─ relax neighbors ─► pushes++   (per improved neighbor)
```

#### Part 2 — `SearchResult` is the carry-out contract

The counts ride out on the return value, alongside the path. This is what lets the
bench stay a *thin shell*: it never reaches inside the algorithm, it just reads
the result. **Drop the counts from the return type and the bench has nothing to
tabulate but ms** — and ms on a small graph is noise.

```
  The seam — counts leave the engine as data

  ┌─ search() ──────┐   returns   ┌─ bench/run.ts ──────┐
  │ ...counts work  │ ──────────► │ rows.push({         │
  │ return {path,   │ SearchResult│   nodesExpanded,    │
  │  nodesExpanded, │             │   pushes, pops, ... })│
  │  pushes, pops}  │             └──────────────────────┘
  └─────────────────┘
```

#### Part 3 — fair workload selection (the part that makes it honest)

A benchmark that picks an unfair workload proves nothing. The harness picks
**interior** start/goal pairs and documents why: corner-to-corner is degenerate —
the goal is the farthest node, so Dijkstra has to expand the whole graph and the
heuristic has nothing to prune. **Pick the degenerate workload and A* looks no
better than Dijkstra** — not because A* is bad, but because the test was rigged
against the optimization. This choice is the difference between a benchmark and a
demo.

```
  Fair vs degenerate workload

  interior pair (fair)            corner-to-corner (degenerate)
  goal is reachable early         goal is the farthest node
  → A* cone prunes the sides      → must flood the whole grid anyway
  → expanded drops 1079 → 276     → A* ≈ Dijkstra (nothing to prune)
```

#### Part 4 — the comparison table

`formatTable` lays the rows out in fixed-width columns so the eye catches the
diff: the `expanded` column drops down the rows while the `cost` column stays
flat. That visual — falling expansions, constant cost — *is* the lesson. The two
sub-stories share one table: distance problem (dijkstra/astar/bidirectional, equal
cost) and grade problem (gradeAstar/directedAstar, higher cost by design).

#### Execution trace — one bench row being built

```
  Trace — building the astar row (grid40 mid-interior, MEASURED)

  t0 = performance.now()
  result = astar(g, "10,10", "30,20")
     └─ inside search(): loop runs, nodesExpanded → 276, pushes → 341, pops → 277
  ms = now() - t0  = 0.32
  cost = result.path.cost = 2400.00
  rows.push({ algorithm:"astar", expanded:276, pushes:341, pops:277, ms:0.32, cost:2400 })
```

### Move 2.5 — current state vs a stronger version

**Now:** the harness *prints* a table. **What's missing:** it *asserts* nothing
about the numbers. `report.test.ts` only checks that `formatTable` renders the
right strings — it never checks that A* expands fewer nodes than Dijkstra.

```
  Phase A (now)                    Phase B (regression-proof)
  ──────────────                   ──────────────────────────
  bench prints a table             bench prints a table AND
  report.test.ts asserts           a test asserts:
    "table contains 'astar'"         expect(astar.expanded)
  → a regression that doubled          .toBeLessThan(dijkstra.expanded)
    A*'s expansions is INVISIBLE     expect(astar.cost)
                                       .toEqual(dijkstra.cost)
                                     → regression FAILS the build
```

The migration cost is small (a few assertions over a fixed fixture), and it's the
single highest-leverage change for keeping the optimization honest over time.

### Move 3 — the principle

The general lesson: **measure the logical operation, not the clock, when you want
a result you can trust and reproduce.** Wall-clock answers "how long did it take on
this machine right now"; a counter answers "how much work did the algorithm do" —
and the second question is the one that survives a faster laptop, a JIT warmup, or
a noisy CI box. Any time you're comparing two implementations of the same
algorithm, find the unit of work and count it.

## Primary diagram

The harness end to end — fair workload in, instrumented engine in the middle,
comparison table out.

```
  Instrumented bench harness, end to end

  ┌─ bench/run.ts ─────────────────────────────────────────────────┐
  │  makeGridGraph(40)                                              │
  │  INTERIOR pairs only (fair) ── for each stage ──┐               │
  └──────────────────────────────────────────────────┼─────────────┘
                                                     ▼
  ┌─ features/routing/search() (instrumented) ────────────────────┐
  │  loop: pop → pops++ → (fresh?) nodesExpanded++ → relax pushes++ │
  │  return SearchResult { path, nodesExpanded, pushes, pops }      │
  └──────────────────────────────────┬─────────────────────────────┘
                                     ▼  rows.push({...result, ms, cost})
  ┌─ bench/report.ts formatTable ──────────────────────────────────┐
  │  algorithm   expanded  pushes  pops    ms      cost             │
  │  dijkstra        1079    1141  1080   1.47   2400.00            │
  │  astar           276      341   277   0.32   2400.00  ← the win │
  │  (expanded falls; cost stays flat — that's the whole story)     │
  └─────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases in this repo.** One primary: it's the **portfolio artifact** that
demonstrates the algorithm progression (`docs/flattr-spec.md` §15.2/§15.3). You
run `npm run bench` and it prints three tables (one per pair) showing the
Dijkstra→A*→bidirectional efficiency story and the grade-cost story side by side.

**The metrics ride out on the result type** (`features/routing/types.ts`):

```
  features/routing/types.ts  (lines 45-51)

  export type SearchResult = {
    path: Path | null;
    nodesExpanded: number;  // nodes finalized (added to closed set)  ← THE metric
    pushes: number;         // total heap pushes
    pops: number;           // total heap pops (incl. stale)
  };
       │
       └─ the comment "incl. stale" on pops is the tell: the author knows pops >
          expanded because of lazy deletion (see 03). Without these three fields
          the bench could only time wall-clock — noise on a graph this size.
```

**The harness times each stage and collects the row** (`bench/run.ts`):

```
  bench/run.ts  (lines 16-27, 44-56)

  // INTERIOR pairs only. Corner-to-corner is degenerate: the goal is the
  // farthest node, so Dijkstra expands the whole graph and NOTHING can be pruned.
  const pairs = [ { name: "...", start: "12,12", goal: "17,17", size: 30 }, ... ];

  function time(fn) {
    const t0 = performance.now();
    const result = fn();
    return { result, ms: performance.now() - t0 };   ← wall-clock (noisy, secondary)
  }
  ...
  for (const { algorithm, run } of algos) {
    const { result, ms } = time(run);
    rows.push({
      algorithm,
      nodesExpanded: result.nodesExpanded,            ← the trustworthy number
      pushes: result.pushes,
      pops: result.pops,
      ms,
      cost: result.path ? result.path.cost : NaN,     ← proves the answer is unchanged
    });
  }
       │
       └─ the `cost` column is doing the load-bearing work of the FAIRNESS claim:
          it stays 2400.00 across dijkstra/astar/bidirectional, which is how you
          know A* didn't "cheat" by finding a worse path. The interior-pair comment
          is the author proving they know what makes the benchmark honest.
```

**The table formatter** (`bench/report.ts`):

```
  bench/report.ts  (lines 19-37)

  export function formatTable(title, rows): string {
    const header = pad("algorithm",16) + padLeft("expanded",10)
                 + padLeft("pushes",9) + padLeft("pops",9)
                 + padLeft("ms",9) + padLeft("cost",12);
    const lines = rows.map(r =>
      pad(r.algorithm,16) + padLeft(String(r.nodesExpanded),10) + ...);
    return [title, header, ...lines].join("\n");
       │
       └─ fixed-width columns so the `expanded` column reads as a falling sequence
          down the rows while `cost` stays flat. The alignment IS the visualization
          — no chart library, just padding. report.test.ts asserts this renders,
          but asserts NOTHING about the numbers (see Move 2.5).
  }
```

## Elaborate

Counting logical operations instead of wall-clock is the oldest honest benchmark
technique — it's how algorithms textbooks compare sorts by *comparisons and swaps*
rather than seconds, and exactly the move behind the visualizers in your DSA
portfolio (bar swaps = the counted operation). The reason it matters *here* is
that the graphs are small enough that ms is pure noise: 0.32 ms vs 1.47 ms tells
you almost nothing reliable, but 276 vs 1079 expanded reproduces to the integer on
any machine. The natural next step is what Move 2.5 names — turn the table into
*assertions* so the win is regression-protected — and beyond that, a property test
that A*'s cost always equals Dijkstra's on random graphs (the optimality
invariant), which is a stronger guarantee than any single benchmark pair.

Read next: `01-heuristic-pruning.md` (the thing being measured) and
`03-lazy-deletion-heap.md` (why `pops` exceeds `expanded`). The sibling
`.aipe/study-debugging-observability/` reads these same counters as evidence
rather than as an optimization signal.

## Interview defense

**Q: "How do you know A* is actually faster and not just faster on your laptop?"**

Because I don't measure it in milliseconds — I count nodes expanded inside the
search loop and return that as data. ms is noise on a graph this small; nodes
expanded is deterministic and reproduces to the integer. Measured: Dijkstra 1079,
A* 276, **same cost 2400**. The cost column staying flat is how I know A* didn't
cheat by finding a worse path.

```
  count the logical op, not the clock

  expanded:  1079 → 276   (deterministic, reproduces)
  cost:      2400 = 2400  (proves same answer)
  ms:        1.47 → 0.32  (noisy, secondary)
```

Anchor: *the metric is data returned from the loop, not a side effect of the
clock.*

**Q: "What's the trap in benchmarking A* vs Dijkstra that people miss?"**

The workload. If you route corner-to-corner, the goal is the farthest node, so
Dijkstra has to flood the whole graph and the heuristic has nothing to prune — A*
looks no better, and you'd wrongly conclude the optimization doesn't work. I use
interior pairs and documented exactly that reasoning in the harness. The benchmark
is only as honest as the workload.

```
  interior pair → A* prunes → win visible
  corner-to-corner → must flood anyway → win hidden (rigged)
```

Anchor: *a benchmark is only honest if the workload lets the optimization matter.*

## Validate

1. **Reconstruct.** Name the three counters on `SearchResult` and the exact event
   each ticks on. (Check `types.ts:45-51` and `astar.ts:50,57,62,73`.) Why is
   `pops` always ≥ `nodesExpanded`?
2. **Explain.** Why does the harness time with `performance.now()` *and* return
   `nodesExpanded`, instead of just one? Which would you trust to compare two
   algorithms, and why? (`bench/run.ts:23-27`.)
3. **Apply.** You change the cost function and want to confirm A* still returns
   the optimal path. Which column in the table proves it, and what must stay true
   across dijkstra/astar/bidirectional? (`bench/run.ts:53`.)
4. **Defend.** `report.test.ts` asserts the table renders but not that A* beats
   Dijkstra. Argue whether that's an acceptable gap, and write the one assertion
   you'd add (`report.test.ts`, see Move 2.5).

## See also

- `01-heuristic-pruning.md` — the optimization this harness measures.
- `03-lazy-deletion-heap.md` — why `pops` exceeds `nodesExpanded`.
- `.aipe/study-debugging-observability/` — the same counters as evidence.
