# Search instrumentation counters

**Industry names:** in-band instrumentation · work counters · algorithm
self-measurement. **Type:** Project-specific (the *pattern* — threading counters
through a hot loop — is industry-standard).

## Zoom out, then zoom in

You know how a `fetch()` carries loading/success/error state alongside the data?
The search loop here does the same thing for *itself* — every result carries the
data (`path`) plus three integers describing how hard the search worked to find
it. That second half is the observability.

Here's where it sits. The counters live inside the routing engine, but their
whole purpose is to be read one layer up, at the bench/test boundary.

```
  Zoom out — where the counters live

  ┌─ Test / Bench layer (Node) ─────────────────────────────────┐
  │  bench/run.ts  →  formatTable()  →  expanded/pushes/pops/ms  │ ← reads them
  └─────────────────────────────┬───────────────────────────────┘
                                │  SearchResult { path, nodesExpanded, … }
  ┌─ Routing engine layer ──────▼───────────────────────────────┐
  │  search() in astar.ts                                        │
  │    while (!open.isEmpty()) { … ★ pops++, nodesExpanded++ ★ } │ ← we are here
  └─────────────────────────────┬───────────────────────────────┘
                                │  uses
  ┌─ Data-structure layer ──────▼───────────────────────────────┐
  │  PQueue (binary heap) · Graph (adjacency)                   │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **count the work as you do it, return the counts beside
the answer.** Three numbers — `nodesExpanded`, `pushes`, `pops` — turn the
claim "A* prunes the search" into a measured fact: 32 expansions vs Dijkstra's
203 on the same problem. Without them, "A* is faster" is a belief. With them,
it's a number you can regression-test.

## Structure pass

**Layers.** Three, already drawn above: the data structures (heap, graph), the
search loop that drives them, and the bench/test that reads the result.

**Axis — trace "where does evidence about the search's cost come from?"** across
those layers:

```
  One axis: who produces the cost evidence? — traced down the stack

  ┌─ bench/test ──────────────┐   → CONSUMES the counts (prints/asserts)
  └───────────────────────────┘
  ┌─ search() loop ───────────┐   → PRODUCES the counts (++ at each event)
  └───────────────────────────┘
  ┌─ PQueue / Graph ──────────┐   → does the work, counts NOTHING itself
  └───────────────────────────┘

  the evidence is born in the loop, not in the data structures
```

**Seam.** The load-bearing boundary is `SearchResult` (`types.ts:46-51`). The
counters are produced inside `search()` and the only thing that crosses the seam
out to the bench is that struct. The axis flips there: below the seam, work
happens but isn't named; at the seam, work becomes a number; above it, the
number becomes a verdict. That seam is why you can swap the cost function (the
five bench stages) and still read comparable counters — the contract is the
struct, not the algorithm.

## How it works

### Move 1 — the mental model

The shape is a loop with a tally beside it. Picture the A* frontier expanding
outward from the start; every time the loop finalizes a node, you make a tick
mark. At the end you don't just have the path — you have the tick count, which
*is* the search's cost.

```
  Pattern — the loop with a tally

         start
           │  push start          pushes = 1
           ▼
     ┌───────────┐  pop()         pops++ every iteration
     │  frontier │ ───────────────────────────────┐
     │  (heap)   │                                 │
     └─────┬─────┘  finalize a node                ▼
           │        (add to closed)         nodesExpanded++
           │  relax neighbors → push        pushes++ per improved neighbor
           └──────────────────────────────────────┘
                          loop until goal popped or heap empty
                                   │
                                   ▼
              SearchResult { path, nodesExpanded, pushes, pops }
```

The strategy in one sentence: **every state-changing event in the loop has a
counter increment right next to it**, so the cost of the search falls out for
free as a by-product of running it.

### Move 2 — the walkthrough

**The three counters and what each measures.** They're declared as plain locals
at the top of `search()` and described precisely in the type.

```ts
// features/routing/types.ts:46-51
export type SearchResult = {
  path: Path | null;
  nodesExpanded: number; // nodes finalized (added to closed set)
  pushes: number;        // total heap pushes
  pops: number;          // total heap pops (incl. stale)
};
```

Each one answers a different diagnostic question. `nodesExpanded` = how much of
the graph did the search actually finalize (the real "work" of A*). `pushes` =
how many tentative states entered the frontier. `pops` = how many came out
*including stale duplicates* — and the gap `pops - nodesExpanded` is exactly the
lazy-deletion overhead, the duplicates the heap had to skip.

**Where each increment lives — one event, one tick.** This is the whole
mechanism; it's three lines threaded through the loop.

```ts
// features/routing/astar.ts:35-77 (abridged to the increments)
let pushes = 0;
let pops = 0;
let nodesExpanded = 0;

g.set(startId, 0);
open.push(startId, heuristicFn(graph.nodes[startId], goal));
pushes++;                                    // ← every push counted

while (!open.isEmpty()) {
  const current = open.pop()!;
  pops++;                                     // ← every pop, even stale
  if (closed.has(current)) continue;          // stale duplicate, skipped
  if (current === goalId) { /* return with counts */ }
  closed.add(current);
  nodesExpanded++;                            // ← only FINALIZED nodes

  for (const edgeId of graph.adjacency[current] ?? []) {
    // …relax…
    if (tentative < (g.get(next) ?? Infinity)) {
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
      pushes++;                               // ← push on improvement
    }
  }
}
```

Read the placement carefully — it's deliberate. `pops++` sits *before* the stale
check (`closed.has(current)`), so it counts every pop including duplicates;
`nodesExpanded++` sits *after* `closed.add`, so it counts only genuine
finalizations. That ordering is the difference between "how busy was the heap"
and "how much graph did we actually search." Move either increment to the wrong
side of those guards and the diagnostic meaning silently changes.

**The same counters in the second engine.** `bidirectional.ts` repeats the exact
pattern (`pushes += 2` for the two starts at `:44`, `pops++`/`nodesExpanded++` in
both frontiers) — same three names, same struct. That self-similarity is the
payoff: one counter vocabulary spans every search variant, so the bench can line
them up in one table.

**Crossing the seam to the bench.** The bench is the consumer. It runs each
stage, reads the struct, and lays the counts side by side.

```ts
// bench/run.ts:45-55
for (const { algorithm, run } of algos) {
  const { result, ms } = time(run);          // wall-clock added here
  rows.push({
    algorithm,
    nodesExpanded: result.nodesExpanded,      // ← the in-band counts,
    pushes: result.pushes,                    //   now comparable across
    pops: result.pops,                        //   algorithms
    ms,
    cost: result.path ? result.path.cost : NaN,
  });
}
```

Here's the layers-and-hops view of that crossing — the counts are born deep and
read shallow:

```
  Layers-and-hops — a counter's journey

  ┌─ Routing engine ─┐  hop 1: nodesExpanded++  ┌─ SearchResult ─┐
  │  search() loop   │ ───────────────────────► │  { …, counts } │
  └──────────────────┘  (in-band, per event)    └───────┬────────┘
                                            hop 2 │ return value
                                                  ▼
                                       ┌─ bench/run.ts ──────┐
                                       │  BenchRow + time()  │
                                       └─────────┬───────────┘
                                          hop 3  │ formatTable()
                                                 ▼
                                       ┌─ stdout (you read) ─┐
                                       │  expanded  pushes … │
                                       └─────────────────────┘
```

**The measured payoff.** Run `npm run bench` and the counters make A*'s pruning
visible and reproducible:

```
  grid30 12,12->17,17        expanded   pushes   pops      cost
  dijkstra                        203      255    204    800.00
  astar                            32       54     33    800.00   ← 6.3× fewer, SAME cost

  grid40 10,10->30,20            1079     1141   1080   2400.00   (dijkstra)
  astar                           276      341    277   2400.00   ← 3.9× fewer, same cost
```

`expanded` drops ~4–6× from Dijkstra to A* while `cost` stays identical — that
column pairing *is* the proof: the heuristic pruned the work without changing the
answer. (The cost-equality half is the optimality oracle; see `02-`.)

### Move 2 variant — the load-bearing skeleton

The kernel is tiny: **a counter local + an increment co-located with the event +
the counter returned in the result struct.** Three parts.

- Drop the **return in the struct** and the counts die inside the function —
  the search still works, but every measurement and the entire bench table
  vanishes. The counts must escape the loop's scope.
- Drop the **co-location** (e.g. count pops in the wrong place, or estimate
  expansions afterward) and the number stops meaning what its comment says —
  the `pops` vs `nodesExpanded` distinction (stale-skip overhead) is *only* real
  because each `++` sits at the exact event.
- Drop the **separate counters** (collapse to one "work" number) and you lose
  the ability to tell *why* a search was expensive — was it expanding too much
  graph, or thrashing the heap with stale duplicates?

Optional hardening layered on top: the bench's `time()` wrapper (wall-clock is
*not* part of the algorithm — it's measured by the consumer), and `formatTable`'s
padding. The skeleton is just the three integers and the struct.

### Move 3 — the principle

**Make the work count itself.** The cheapest observability is the kind produced
as a by-product of doing the thing — three integer increments cost nothing and
turn an invisible internal property (search efficiency) into a measured,
regression-testable number. The discipline that generalizes: when you build
something whose *cost* is a correctness concern, count the cost in-band and
return it beside the result. You did this exact move in your reincodes sorting
visualizers — counting swaps and comparisons as the bars animate. Same pattern:
the count is the evidence.

## Primary diagram

The full picture — counters born in the loop, escaping via the struct, read by
the bench, producing the measured table.

```
  Search instrumentation — end to end

  ┌─ Routing engine (features/routing/astar.ts) ───────────────────┐
  │  search():                                                      │
  │    pushes=0  pops=0  nodesExpanded=0                            │
  │    while heap not empty:                                        │
  │       pop  → pops++           (incl. stale, before closed-check)│
  │       skip if stale                                             │
  │       finalize → nodesExpanded++   (after closed.add)           │
  │       relax → push → pushes++                                   │
  └────────────────────────────┬───────────────────────────────────┘
                               │ SearchResult { path, nodesExpanded,
                               │                pushes, pops }   ← the seam
  ┌─ Bench (bench/run.ts) ─────▼───────────────────────────────────┐
  │  time(run) → BenchRow{ …counts, ms, cost }                      │
  │  formatTable(title, rows) → stdout                              │
  └────────────────────────────┬───────────────────────────────────┘
                               ▼
        algorithm     expanded  pushes  pops   cost
        dijkstra           203     255   204  800.00
        astar               32      54    33  800.00   ← pruning, MEASURED
```

## Elaborate

This is the oldest trick in algorithm engineering: instrument the inner loop
with operation counts so you can reason about cost independent of the machine.
`nodesExpanded` is the classic "node expansions" metric from the A* literature —
the standard way to compare informed-search heuristics without a stopwatch
(wall-clock varies by hardware; expansions don't). The `pops - nodesExpanded`
gap is a lazy-deletion-specific signal: this heap pushes duplicates and skips
stale pops (`astar.ts:51`) rather than doing decrease-key, so the overhead shows
up as extra pops. That's the in-band evidence that would tell you *if* upgrading
to decrease-key was worth it (spec §14.3 explicitly defers that decision to
"only if profiling says" — and these counters *are* that profiler).

Where to go next: `02-` shows the `cost` column as a correctness oracle, not
just a workload number. For the performance framing of the same counters
(latency budgets, the algorithm progression as optimization), cross over to
`study-performance-engineering`.

## Interview defense

**Q: Your bench says A* expands 32 nodes and Dijkstra 203 on the same problem.
How do you know A* didn't just cut a corner and return a worse path?**

Because the `cost` column is identical — 800.00 for both. The counters prove the
*work* dropped; the cost equality proves the *answer* didn't. I assert that
equality as a test (`astar.test.ts:38`), so it's a regression guard, not a
one-off observation.

```
  expanded  ▼ dropped 6×     cost  ▼ unchanged
  dijkstra:  203             800.00
  astar:      32             800.00
            ─────            ──────
            efficiency        correctness
            (counters)        (oracle)
```

Anchor: *the counters and the cost column are orthogonal evidence — one for
speed, one for correctness; you need both to claim A* is a strict improvement.*

**Q: Why count `pops` and `nodesExpanded` separately — isn't that redundant?**

No — the gap between them is the lazy-deletion overhead. This heap pushes
duplicate entries and skips stale pops instead of doing decrease-key, so `pops`
counts the skips and `nodesExpanded` doesn't. If that gap blows up, the heap is
thrashing on stale entries and decrease-key might be worth it. Collapse them into
one number and you lose the signal that tells you *which* part is expensive.

Anchor: *`pops - nodesExpanded` is the stale-skip count — the in-band profiler
for whether the lazy-deletion heap is the bottleneck.*

## See also

- `02-optimality-oracle.md` — the `cost` column as a correctness probe.
- `04-finite-blocked-as-diagnostic.md` — the other thing the counters and cost
  reveal: steep-but-routable vs disconnected.
- `audit.md` lens 4 (metrics) and lens 1 (observability-map).
- Neighbor guide `study-performance-engineering` — same counters, measurement framing.
