# In-band search instrumentation

**Industry names:** counters / work metrics returned with the result; "instrument
the algorithm, not the wrapper." **Type:** Project-specific (the *shape* —
metrics-in-the-return-value — is language-agnostic).

---

## Zoom out, then zoom in

Most observability you've shipped lives *beside* the code: a `console.log`, a
metric you `.increment()`, a span you open and close. flattr does the opposite —
the search function *returns* its own work counters as part of the answer. You
don't ask the search how hard it worked; the answer tells you.

```
  Zoom out — where the counters live

  ┌─ Engine layer (features/routing/) ──────────────────────────┐
  │  astar.ts search()  →  ★ counts pushes/pops/expanded ★       │ ← we are here
  │  returns SearchResult { path, nodesExpanded, pushes, pops }  │
  └─────────────────────────────┬───────────────────────────────┘
                                │  SearchResult (data, not a log line)
  ┌─ Bench layer (bench/) ──────▼───────────────────────────────┐
  │  run.ts  →  tabulates counters across 5 stages              │
  │  report.ts  →  formatTable() aligns them column by column   │
  └─────────────────────────────┬───────────────────────────────┘
                                │  same SearchResult
  ┌─ Test layer (*.test.ts) ────▼───────────────────────────────┐
  │  asserts a.nodesExpanded <= d.nodesExpanded (a regression   │
  │  guard built ON the counters)                              │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **return your work metrics as data**. The search reports
three counters — `nodesExpanded` (nodes finalized), `pushes` (heap inserts),
`pops` (heap extractions including stale ones). Because they're return values,
the same numbers feed three consumers — the bench reads them as a comparison, a
test asserts on them as a guard, and you read them by eye when a route comes back
weird. One instrument, three downstream uses, zero logging.

---

## The structure pass

**Layers:** the counters originate in the **engine** (`astar.ts`), are consumed
by the **bench** (a measurement harness) and the **tests** (a regression guard).

**Axis traced — "who can see how hard the search worked?"** Hold that one
question across the layers:

```
  axis = "who can see the search's work?"  — trace it across layers

  ┌─ engine: search() ──────────┐  → it COUNTS (owns the truth)
  └─────────────┬────────────────┘
                │  SearchResult carries the counts out
  ┌─ bench: run.ts ─────────────┐  → it COMPARES (5 stages side by side)
  └─────────────┬────────────────┘
  ┌─ test: astar.test.ts ───────┐  → it ASSERTS (a <= d, or fail the build)
  └─────────────┬────────────────┘
  ┌─ you, reading the table ────┐  → you DIAGNOSE (6× expansion = wrong heuristic)
  └──────────────────────────────┘
```

**The seam that matters — the `SearchResult` return type
(`features/routing/types.ts:45-51`).** This is where the axis flips: *inside* the
search, the counters are mutable locals nobody else can see; the instant they're
packed into the returned `SearchResult`, they become immutable public evidence
any caller can read. That return type is the contract. Everything downstream —
bench, test, your eyeballs — depends only on the type, not on the search's
internals. Study the contract before the mechanics.

---

## How it works

### Move 1 — the mental model

You know how a `fetch()` returns `{ ok, status, body }` — the status code is
*part of the response*, not something you have to log separately to find out what
happened? Same idea. The search returns `{ path, nodesExpanded, pushes, pops }`:
the path is the answer, the counters are the receipt.

```
  The pattern — counters ride out with the answer

   search(graph, start, goal)
        │
        │  inside the loop, three locals tick up:
        │    pushes++      on every heap insert
        │    pops++        on every heap extract
        │    nodesExpanded++   when a node is finalized
        ▼
   return {
     path,            ← the answer
     nodesExpanded,   ┐
     pushes,          ├ the receipt: HOW it got the answer
     pops,            ┘
   }
```

The receipt is the observability. A path with `nodesExpanded: 6000` on a graph
where Dijkstra expands 1000 isn't wrong — but it's a *signal* that the heuristic
collapsed to zero and A* degenerated into Dijkstra. You read that off the return
value, no logging required.

### Move 2 — the step-by-step walkthrough

**The receipt's shape — what each counter means.** Reach for this in any routing
test or bench run; it's the canonical definition.

```typescript
// features/routing/types.ts:45-51
/** A search result plus the metrics the benchmark records. */
export type SearchResult = {
  path: Path | null;
  nodesExpanded: number; // nodes finalized (added to closed set)
  pushes: number;        // total heap pushes
  pops: number;          // total heap pops (incl. stale)
};
```

Read the annotations carefully — they encode the algorithm's accounting model.
`nodesExpanded` counts *finalized* nodes (added to the closed set), not visited
ones. `pops` is explicitly "incl. stale": this heap uses **lazy deletion**, so a
node can sit in the heap multiple times and get popped after it's already closed.
The gap between `pops` and `nodesExpanded` is your stale-duplicate count — itself
a diagnostic. If `pops` balloons relative to `nodesExpanded`, the open set is
churning with stale entries.

**Where the counters tick — inside the loop, one per event.** The increments are
placed at the exact algorithmic events they name. Here's the kernel
(`features/routing/astar.ts:35-77`, condensed):

```typescript
// features/routing/astar.ts
let pushes = 0;
let pops = 0;
let nodesExpanded = 0;                                     // :35-37

g.set(startId, 0);
open.push(startId, heuristicFn(graph.nodes[startId], goal));
pushes++;                                                  // :46  seed push

while (!open.isEmpty()) {
  const current = open.pop()!;
  pops++;                                                  // :50-51  every extract
  if (closed.has(current)) continue; // stale duplicate (lazy deletion) :62
  // ... goal check returns early WITH the counters ...
  closed.add(current);
  nodesExpanded++;                                         // :62  finalize
  // ... relax edges ...
      open.push(next, tentative + heuristicFn(graph.nodes[next], goal));
      pushes++;                                            // :73  every relax-push
}
return { path: null, nodesExpanded, pushes, pops };        // :77  exhausted: still report
```

The discipline worth copying: **the failure path returns counters too**
(`:77`). When the search finds nothing (`path: null`), you still get the receipt
— so "no route" comes with "and here's how much of the graph I searched before
giving up." A `null` path with `nodesExpanded` equal to the whole graph means
genuinely disconnected; a `null` with a tiny count means it gave up early
(a bug). The counters disambiguate the two.

**The instrument is shared, not duplicated.** `dijkstra`, `astar`, `gradeAstar`,
and `directedAstar` are all thin wrappers over one `search()` engine
(`astar.ts:135-163`) — so the counters mean the *same thing* across every stage.
`bidirectional.ts` re-implements the loop but ticks the *same three counters*
(`bidirectional.ts:15-17, 56, 59, 74, 86, 89, 104`). That consistency is what
makes the bench comparison valid: you're comparing like with like.

**The bench reads the receipts side by side.** This is where the counters earn
their keep as a diagnostic.

```
  Layers-and-hops — counters flow from engine to a comparison table

  ┌─ Engine ─────────┐  SearchResult   ┌─ bench/run.ts ──────────────┐
  │ dijkstra()       │ ──────────────► │ rows.push({                 │
  │ astar()          │  (×5 algos      │   nodesExpanded, pushes,     │
  │ bidirectional()  │   per pair)     │   pops, ms, cost })  :44-52  │
  │ gradeAstar()     │ ──────────────► └──────────────┬──────────────┘
  │ directedAstar()  │                                │ BenchRow[]
  └──────────────────┘                ┌───────────────▼──────────────┐
                                       │ report.ts formatTable()      │
                                       │ aligns columns:              │
                                       │ algorithm expanded pushes    │
                                       │ pops ms cost          :19-36 │
                                       └──────────────────────────────┘
```

The harness runs all five algorithms on the *same* grid pair and tabulates
(`bench/run.ts:29-56`). The narrative it prints
(`bench/report.ts:59-63`) tells you what the numbers *should* look like: "A*
prunes the flood to a cone; bidirectional meets in the middle." When the measured
numbers diverge from that expected shape, you have a bug — and the table localizes
it to a stage. This is the **measured-not-claimed** discipline: the context doc
says A* expands ~4–6× fewer nodes than Dijkstra, and that claim is *re-derived
every bench run* from the actual counters, not asserted in a comment.

> The counters-as-budget reading (is the search *fast enough*?) belongs to
> `study-performance-engineering`. Here we read them as a *diagnosis* (is the
> search doing the *right amount* of work?). Same numbers, different question.

### Move 3 — the principle

**Return your work metrics as part of the answer, and three consumers come for
free.** The moment the counters are data instead of a log line, the same numbers
serve measurement (bench), correctness (the `a.nodesExpanded <= d.nodesExpanded`
guard at `astar.test.ts:48-52`), and live diagnosis. Logging would have served
only one. The cost is that nothing *persists* them — which is exactly flattr's
production gap (see `audit.md` lens 4): great instrument, no collection.

---

## Primary diagram

The full loop: counters born in the engine, carried out by the return type,
consumed three ways.

```
  In-band search instrumentation — one instrument, three consumers

  ┌─ Engine layer: features/routing/astar.ts ───────────────────────────┐
  │                                                                     │
  │   while (!open.isEmpty()):                                          │
  │       pop()      → pops++          :50                              │
  │       finalize   → nodesExpanded++ :62                              │
  │       relax/push → pushes++        :73                              │
  │                                                                     │
  │   return { path, nodesExpanded, pushes, pops }   ← SearchResult     │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │  types.ts:45-51 (the contract seam)
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
  ┌─ Bench ───────────┐  ┌─ Test ─────────────┐  ┌─ You ──────────────┐
  │ run.ts tabulates  │  │ astar.test.ts:48-52│  │ read the table:    │
  │ 5 stages × pair   │  │ a.expanded <= d.   │  │ 6× expansion ⇒     │
  │ report.ts aligns  │  │ expanded (guard)   │  │ heuristic broke    │
  │ columns :19-36    │  │                    │  │                    │
  └───────────────────┘  └────────────────────┘  └────────────────────┘
    MEASURE                 GUARD                   DIAGNOSE
```

---

## Elaborate

This pattern is the same one performance tools have used forever — `EXPLAIN
ANALYZE` in Postgres returns rows-scanned and actual-time *with* the query plan;
a profiler returns call counts *with* the result. flattr applies it at the
algorithm level: the unit of observation is "one search," and the receipt is
three integers. The reason it's so clean here is the same reason it's rare in
app code: it only works when the thing you're instrumenting is a **pure
function** with a well-defined unit of work. A request handler that touches five
services can't return one tidy receipt; a graph search can.

The adjacent concept is the **optimality oracle** (`02-optimality-oracle-probe.md`):
the counters tell you *how hard* the search worked; the oracle tells you whether
the answer is *right*. You need both — a search can be efficient and wrong (good
counters, bad path) or correct and slow (right path, blown counters). What to
read next: `bench/report.ts` for how the comparison is framed, then
`study-performance-engineering` for reading the same counters as a latency
budget.

---

## Interview defense

**Q: You have no logging and no metrics backend. How do you debug a search that
returns a weird route?**

Read the receipt. Every search returns `{ path, nodesExpanded, pushes, pops }`
(`types.ts:45-51`). A weird route with a normal expansion count means the *cost
function* is wrong; a weird route with a 6× expansion count means the *heuristic*
collapsed and A* degenerated to Dijkstra. The counters partition the bug space
before I read a line of the loop.

```
  diagnosis fork from the counters

   weird route
       │
   ┌───┴─────────────────────────┐
   │ expansion normal?           │
   ├─────────────┬───────────────┤
   │ yes         │ no (6× high)  │
   ▼             ▼
  cost.ts        heuristic collapsed
  is wrong       (haversine → 0?)
```

Anchor: *the counters partition the bug before I open the loop.*

**Q: What's the load-bearing counter people forget?**

That `pops` includes stale duplicates — it's annotated "incl. stale"
(`types.ts:49`) because the heap uses lazy deletion. Forget that and you'll think
the search is broken when `pops > nodesExpanded`; in fact the gap *is* the
stale-duplicate count, a free diagnostic. Strip the `if (closed.has(current))
continue` stale-skip (`astar.ts:62`) and the search would re-finalize nodes and
the counts would lie.

Anchor: *`pops` minus `nodesExpanded` is the stale-churn metric, by design.*

---

## See also

- `02-optimality-oracle-probe.md` — the counters say *how hard*; the oracle says
  *whether right*.
- `audit.md` — lens 4 (these counters are computed but never collected) and lens
  6 (the receipt as a state snapshot).
- `study-performance-engineering` — the same counters read as a latency/throughput
  budget.
- `study-testing` — the regression guard built on `nodesExpanded`.
