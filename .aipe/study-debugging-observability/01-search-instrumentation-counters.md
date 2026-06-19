# Search instrumentation counters

> **Industry names:** application metrics / instrumentation counters /
> performance counters. **Type:** Industry standard (the in-process
> counter→report pattern), applied to a hand-rolled graph search.

---

## Zoom out, then zoom in

You've shipped a `fetch()` with loading/success/error states. You
*know* the request happened because the states changed — the state is
your evidence. Same idea here, one level down: the A* search increments
three counters as it runs, and those counters are how you know what the
search actually *did* — not what you hoped it did.

Here's where the counters live in the system.

```
  Zoom out — where the counters live

  ┌─ DSA layer (the engine) ───────────────────────────────────┐
  │  features/routing/astar.ts  search()                        │
  │    closed.add → nodesExpanded++   ★ COUNTERS LIVE HERE ★     │ ← we are here
  │    open.push  → pushes++                                    │
  │    open.pop   → pops++                                      │
  │    returns SearchResult { path, nodesExpanded, pushes, pops}│
  └────────────────────────────┬────────────────────────────────┘
                               │  SearchResult
  ┌─ Instrumentation layer ────▼────────────────────────────────┐
  │  bench/run.ts  reads counters → BenchRow[]                  │
  │  bench/report.ts formatTable → aligned comparison table     │
  └────────────────────────────┬────────────────────────────────┘
                               │  string
  ┌─ Output ───────────────────▼────────────────────────────────┐
  │  console.log → your terminal (the "dashboard")              │
  └──────────────────────────────────────────────────────────────┘
```

The counters are the instrumentation; the bench is the collector and
reporter; your terminal is the dashboard. Zoom in: the pattern is
*instrument the hot path with cheap in-process counters, then report
them as a comparison so the numbers mean something against a baseline.*
A raw `nodesExpanded: 1107` tells you nothing; `1107` next to
Dijkstra's `4812` on the same problem tells you A* pruned ~77% of the
flood. The comparison is the signal.

> The DSA theory behind *what* these counters measure — the A*
> frontier, the closed set, heap operations — is
> `../study-dsa-foundations/`'s lens. *Tuning* the numbers down is
> `../study-performance-engineering/`'s. This file's lens is purely:
> how does the search make its own work *visible*?

---

## Structure pass

Three layers, one axis, one seam.

**Layers:** (1) the engine that *emits* counters, (2) the harness that
*collects and shapes* them, (3) the terminal that *displays* them.

**Axis — "who owns the number?"** Trace it down the stack:

```
  One axis: "who owns the number?" — traced down the layers

  ┌──────────────────────────────────────────────┐
  │ engine: search() local vars (pushes, pops…)  │  → engine MUTATES
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ result: SearchResult (frozen snapshot)    │  → engine HANDS OFF
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ bench: BenchRow / formatTable         │  → harness READS ONLY
          └──────────────────────────────────────┘

  the number is mutable inside one function call, then frozen into
  a value object the moment search() returns — that handoff is the seam
```

**The seam:** the `return { path, nodesExpanded, pushes, pops }` at the
end of `search()`. On the engine side the counter is a mutable local
incremented in a tight loop; on the harness side it's an immutable field
on a value object. The axis ("who can change this number?") flips at
exactly that boundary — engine writes, everyone else reads. That's why
the bench can never corrupt a measurement: it physically can't reach the
counter, only the snapshot. Mechanics hang off this seam — let's walk
them.

---

## How it works

### Move 1 — the mental model

The shape is a **side-effect counter threaded through a loop.** You
already do this when you debug with `let calls = 0; calls++` inside a
recursive function to see how deep it went. Formalize that: declare
counters before the loop, bump them at the exact operations you care
about, and return them alongside the real result.

```
  Pattern — instrument the loop, snapshot on exit

        ┌───────────── search loop ─────────────┐
        │  pop a node      ──────► pops++        │
        │  finalize it     ──────► nodesExpanded++│
        │  push neighbors  ──────► pushes++       │
        └───────────────────┬────────────────────┘
                            │ loop ends (found / empty)
                            ▼
            return { path, pops, pushes, nodesExpanded }
                            │
                            ▼
                  one immutable snapshot of the work done
```

The trick that makes it *useful* (not just present) is the next layer:
run the same problem through several algorithms and lay their snapshots
side by side. One number is data; a column of numbers is evidence.

### Move 2 — the step-by-step walkthrough

#### The three counters, named by what they measure

Each counter answers a different question about the search, and you
need all three to read the picture.

```
  The three counters — what each one sees

  pushes        ─ every time a node enters the frontier
                  (incl. re-pushes when a cheaper path is found)
  pops          ─ every time a node leaves the frontier
                  (INCLUDING stale duplicates skipped by lazy deletion)
  nodesExpanded ─ nodes actually FINALIZED (added to the closed set)

  relationship:   nodesExpanded ≤ pops ≤ pushes
                  the gaps tell the story:
                    pushes − pops   = nodes still in the heap at exit
                    pops − expanded = stale duplicates skipped
```

- **`pushes`** counts heap insertions. It rises every time the search
  finds a cheaper route to a node and re-adds it — so a high
  pushes-to-expanded ratio means lots of re-relaxation churn.
- **`pops`** counts heap removals, *including stale ones*. Because this
  search uses lazy deletion (it doesn't remove an outdated entry, it
  just skips it on pop), `pops` is always ≥ `nodesExpanded`. The gap is
  pure overhead — duplicates that got popped and discarded.
- **`nodesExpanded`** is the real work: nodes finalized into the closed
  set. This is the number that compares A* against Dijkstra. **Drop this
  counter and you lose the one metric that proves the heuristic is
  pruning** — you'd see timing differences but not *why*.

#### Bumping the counters at the exact operation

The discipline is: increment at the *operation*, not at a convenient
nearby line. Pseudocode for the instrumented loop:

```
  initialize pushes = 0, pops = 0, nodesExpanded = 0

  push(start);  pushes++              // count the insertion itself

  while frontier not empty:
      current = pop();  pops++         // count every pop, stale or not
      if current is stale:  continue   // skipped — but already counted
      if current == goal:  return snapshot(path, counters)
      mark current closed;  nodesExpanded++   // count finalization only
      for each neighbor:
          if cheaper path found:
              push(neighbor);  pushes++   // count each re-push
  return snapshot(no path, counters)       // counters still returned!
```

Two boundary conditions matter. First, `pops++` happens *before* the
stale check — so `pops` correctly includes the wasted ones; that gap is
the diagnostic. Second, the no-path return *still* carries the counters:
a failed search is exactly when you most want to know it expanded the
whole graph.

#### Collecting snapshots into a comparison

A single snapshot is inert. The harness turns it into evidence by
running N algorithms over the *same* fixed problem and tabulating.

```
  Layers-and-hops — counters to comparison table

  ┌─ engine ─────┐  hop 1: run dijkstra(g,s,goal)   ┌─ harness ────┐
  │  search()    │ ───────────────────────────────► │  bench/run   │
  │              │  hop 2: SearchResult snapshot ◄── │  loops algos │
  └──────────────┘                                   └──────┬───────┘
                                              hop 3 │ push BenchRow
                                                    ▼
                                          ┌─ report layer ─────┐
                                          │  formatTable        │
                                          │  align into columns │
                                          └─────────┬───────────┘
                                       hop 4 │ console.log string
                                             ▼
                                          your terminal
```

The fixed-problem part is load-bearing: `bench/run.ts` deliberately uses
*interior* node pairs, not corner-to-corner, because corner-to-corner is
degenerate (the goal is the farthest node, so even Dijkstra can't prune
and the comparison shows nothing). Choosing the right experiment is half
of making a metric meaningful.

### Move 3 — the principle

Instrumentation is only as useful as the baseline you compare it
against. A counter in isolation is a number; a counter beside the same
counter from a known-reference run is *evidence*. The expensive part
isn't incrementing the variable — it's choosing the experiment (interior
pairs) and the reference (Dijkstra) so the delta actually means
something.

---

## Primary diagram

The full path, from the operation that bumps a counter to the table you
read.

```
  Search instrumentation — the complete surface

  ┌─ DSA layer: features/routing/astar.ts ─────────────────────────┐
  │  search():                                                     │
  │    let pushes=0, pops=0, nodesExpanded=0                       │
  │    open.push(start) ─────────► pushes++                        │
  │    while !open.isEmpty():                                      │
  │       current = open.pop() ──► pops++                          │
  │       if stale: continue                                       │
  │       closed.add(current) ──► nodesExpanded++                  │
  │       for neighbor: open.push ─► pushes++                      │
  │    return { path, nodesExpanded, pushes, pops }  ── SNAPSHOT ──┐│
  └───────────────────────────────────────────────────────────────┘│
                                                                    │
  ┌─ Instrumentation layer: bench/run.ts ──────────────────────────▼┐
  │  for each algo in [dijkstra, astar, bidirectional,             │
  │                    gradeAstar, directedAstar]:                 │
  │     {result, ms} = time(run)      ── adds wall-clock ms ──     │
  │     rows.push({ algorithm, nodesExpanded, pushes, pops,        │
  │                 ms, cost: result.path?.cost })                 │
  └────────────────────────────┬───────────────────────────────────┘
                               │ rows: BenchRow[]
  ┌─ Report layer: bench/report.ts ──▼──────────────────────────────┐
  │  formatTable(title, rows) → padded columns:                    │
  │   algorithm  expanded  pushes  pops    ms     cost              │
  │   dijkstra       4812    9000  8000  12.30  1000.00             │
  │   astar          1107    2200  2000   3.10  1000.00             │
  └────────────────────────────┬───────────────────────────────────┘
                               │ console.log
                               ▼  terminal (the dashboard)
```

---

## Implementation in codebase

### Use cases

The bench is reached for in exactly one scenario today: **proving the
algorithm progression earns its complexity.** The project's whole pitch
is "hand-rolled router, no Valhalla/OSRM" — so it has to *show* that
each stage (Dijkstra → A* → directional → bidirectional) buys something.
The counters are how that claim becomes a number instead of a vibe. You
run `npm run bench` after touching `cost.ts`, `astar.ts`, or `pqueue.ts`
to confirm A* still prunes and bidirectional still meets in the middle.

The same counters are *also* read as correctness signals in the tests
(`astar.test.ts:29-34,47-52`) — the instrumentation does double duty as
both perf evidence and a regression guard on search shape.

### Code, line by line

**The counters declared and incremented** —
`features/routing/astar.ts:35-37, 46, 50, 73`:

```
  features/routing/astar.ts  (search, lines 35-77)

  let pushes = 0;                          ← 35  declare before loop
  let pops = 0;                            ← 36
  let nodesExpanded = 0;                   ← 37

  open.push(startId, heuristicFn(...));    ← 45  the seed insertion…
  pushes++;                                ← 46  …counted explicitly

  while (!open.isEmpty()) {
    const current = open.pop()!;           ← 49
    pops++;                                ← 50  every pop counted…
    if (closed.has(current)) continue;     ← 51  …incl. this stale skip
    if (current === goalId) { ... return { ← 52-59 snapshot on success
        path, nodesExpanded, pushes, pops };
    }
    closed.add(current);                   ← 61
    nodesExpanded++;                       ← 62  finalize = real work
    for (const edgeId of adjacency...) {
      ...
      if (tentative < (g.get(next) ?? ∞)) {← 69  cheaper path?
        ...
        open.push(next, ...);              ← 72
        pushes++;                          ← 73  re-push counted too
      }
    }
  }
  return { path: null, nodesExpanded,      ← 77  FAIL still snapshots
           pushes, pops };
       │
       └─ pops++ at :50 runs BEFORE the stale skip at :51, so pops
          includes wasted duplicate pops. nodesExpanded++ at :62 runs
          only after closed.add — so it counts finalized work only.
          That ordering IS the diagnostic: pops − expanded = stale churn.
```

Drop the `nodesExpanded++` at line 62 and the bench can no longer show
A* pruning — `pops` alone conflates stale duplicates with real work.
Drop the counter from the *failure* return at line 77 and you go blind
exactly when a search explodes (expands everything, finds nothing).

**The snapshot shape** — `features/routing/types.ts:45-51`:

```
  features/routing/types.ts  (lines 45-51)

  export type SearchResult = {
    path: Path | null;       ← 47  the answer
    nodesExpanded: number;   ← 48  nodes finalized (closed set)
    pushes: number;          ← 49  total heap pushes
    pops: number;            ← 50  total heap pops (incl. stale)
  };
       │
       └─ counters are FIELDS on the result, not a side channel.
          every caller (bench AND tests) gets them for free; no
          global mutable metrics object to corrupt across runs.
```

**The collector** — `bench/run.ts:23-27, 44-56`:

```
  bench/run.ts  (lines 23-27, 44-56)

  function time(fn) {                      ← 23  wraps a run with…
    const t0 = performance.now();          ← 24  …a wall-clock probe
    const result = fn();                   ← 25  (the ONLY metric the
    return { result, ms: now() - t0 };     ← 26   engine doesn't carry)
  }

  for (const { algorithm, run } of algos) {← 45
    const { result, ms } = time(run);      ← 46
    rows.push({                            ← 47
      algorithm,
      nodesExpanded: result.nodesExpanded, ← 49  read straight off
      pushes: result.pushes,               ← 50  the snapshot
      pops: result.pops,                   ← 51
      ms,                                  ← 52  timing added here
      cost: result.path ? result.path.cost ← 53  NaN if no path —
            : NaN,                                visible in the table
    });
  }
       │
       └─ ms is the one signal measured OUTSIDE the engine (you can't
          self-time without observer overhead). everything else is just
          read off the immutable SearchResult.
```

**The reporter** — `bench/report.ts:19-37`: `formatTable` pads each
field to a fixed column width (`pad`/`padLeft`, lines 11-17) and joins
title + header + rows. The alignment is the whole point — unaligned
numbers can't be compared by eye, and comparison-by-eye is the entire
interface. `report.test.ts:4-17` guards that the table contains each
algorithm and value, so a formatting regression that hides a number
fails the suite.

---

## Elaborate

This is the oldest profiling pattern there is: counters in the hot path,
read out at the end. It predates flamegraphs and `perf`; it's what you
reach for when you control the source and want a *semantic* count ("how
many nodes did we finalize") rather than a sampled one ("where did the
CPU spend time"). The two are complementary — a profiler tells you the
heap pop is hot; the `pops` counter tells you *how many* and how many
were wasted.

The design choice worth noting: flattr put the counters *on the result
value* rather than in a module-level metrics registry (the
`prom-client`/StatsD shape). At this scale that's strictly better — no
shared mutable state, no reset-between-runs bug, trivially testable. It
*doesn't* scale to a served system where you want counters aggregated
across thousands of requests without threading them through every return
type. That's the boundary where you'd reach for a real metrics library —
and it's named as `not yet exercised` in `audit.md` lens 4.

What to read next: `02-optimality-oracle.md` (the tests read these same
counters as correctness signals), and `../study-performance-engineering/`
for turning these numbers into optimization targets.

---

## Interview defense

**Q: You count `pops` including stale duplicates. Isn't that a bug —
shouldn't a clean metric only count real work?**

No — the stale pops *are* the metric I want. The gap between `pops` and
`nodesExpanded` is exactly the lazy-deletion overhead, and that's a
number I'd tune against. If I only counted real work I'd be hiding the
cost of the design choice (lazy deletion vs decrease-key).

```
  pops vs nodesExpanded — the gap is the diagnostic

   pops        ████████████████████  (incl. stale)
   expanded    ████████████          (finalized only)
               └──────────┘└────────┘
                  real work  stale churn ← THIS is what the gap exposes
```

Anchor: *the stale-pop gap is the cost of lazy deletion, made visible.*

**Q: What's the one counter you'd never drop, and why?**

`nodesExpanded`. It's the only one that proves the heuristic is doing
its job — A* expanding fewer nodes than Dijkstra for the *same optimal
cost* is the entire justification for A*. `pushes`/`pops` describe heap
churn; `nodesExpanded` describes search efficiency, which is the claim
the project is making.

```
  why nodesExpanded is load-bearing

  dijkstra:  expanded 4812 ─┐  same cost 1000.00
  astar:     expanded 1107 ─┘  → A* found the SAME answer
                              touching 77% fewer nodes.
            that delta IS the proof the heuristic works.
```

Anchor: *`nodesExpanded` next to a Dijkstra baseline is the proof, not
the wall-clock ms.*

**Q: Why is this not a real metrics system?**

Because nothing aggregates or persists. Each run prints once and the
numbers die with the process — no time series, no threshold, no alert.
It's instrumentation + a manual read, not monitoring. To make it
monitoring I'd assert counters against a stored baseline in CI (turning
`nodesExpanded` into an SLI), which is the smallest real step and is
named in `audit.md` as RF-2.

Anchor: *signals exist; SLIs/SLOs/alerts are `not yet exercised`.*

---

## Validate

**Reconstruct (from memory).** Name the three counters, the operation
each is bumped at, and the invariant ordering between them
(`nodesExpanded ≤ pops ≤ pushes`). Draw the loop with the three `++`
points marked.

**Explain.** Why does `pops++` (`astar.ts:50`) come *before* the stale
check at `:51` instead of after? What would the table lose if it ran
after?

**Apply to a scenario.** You run `npm run bench` and see A* with
`nodesExpanded` *equal* to Dijkstra's on one interior pair. Using only
`bench/run.ts:17-21`, what's the most likely innocent explanation? (Hint:
which pairs are degenerate, and why does the file comment warn against
corner-to-corner?)

**Defend the decision.** flattr puts counters on `SearchResult`
(`types.ts:45-51`) rather than a global metrics object. Argue why that's
right at this scale and name the exact point (from `audit.md` lens 4)
where it stops being right.

---

## See also

- `02-optimality-oracle.md` — the tests read these counters as
  correctness signals; the oracle is the reproduction loop.
- `03-route-honesty-signal.md` — the *domain* metric (`cost`,
  `steepCount`) that rides alongside these search metrics.
- `00-overview.md` — the full evidence map and ranked findings.
- `audit.md` — lens 4 (metrics/SLIs) and RF-2 (manual, unstored bench).
- `../study-performance-engineering/` — turning these numbers into
  optimization targets.
- `../study-dsa-foundations/` — the A* frontier / closed set / heap
  theory behind what the counters measure.
