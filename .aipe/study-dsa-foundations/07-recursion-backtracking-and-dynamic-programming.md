# Recursion, Backtracking & Dynamic Programming

**Industry names:** path reconstruction via back-pointers · iterative vs
recursive traversal · memoization / tabulation (DP) · backtracking. **Type:**
Industry standard.

## Zoom out, then zoom in

flattr's relationship to recursion is the interesting part: it has the
*recursion-shaped problem* — walking a came-from chain backward from goal to
start — but solves it **iteratively** with a `while` loop. That's a deliberate
choice you'll recognize from your reincodes BST, where you wrote both recursive
and iterative `delete`. There's **no dynamic programming** here, and no
backtracking — and that's not an omission, it's because best-first search is a
*greedy* frontier expansion, not a subproblem-table fill. This file covers the
one recursion-shaped thing flattr does, and why DP genuinely doesn't fit.

```
  Zoom out — recursion in flattr: one chain-walk, no DP

  ┌─ Algorithm layer ─────────────────────────────────────────┐
  │  reconstruct()  astar.ts:86   goal → start chain walk      │ ★
  │     while (cur !== startId) { ... cur = entry.prev }       │
  │     iterative, not recursive — but recursion-SHAPED        │
  │                                                            │
  │  bidirectional reconstruct  bidirectional.ts:122-144       │
  │     same shape, two chains (forward + reverse) joined      │
  └────────────────────────────────────────────────────────────┘

  not present:  memoization tables · tabulation · backtracking search
```

Zoom in: recursion and iteration are two encodings of the same thing — a stack
of deferred work. Reconstruction is a linear back-walk (each node has exactly
one predecessor), so it's the case where iteration is *strictly better* than
recursion: no call-stack risk, same logic. We'll walk it, then be honest about
why DP has nothing to do here.

## The structure pass

One recursion-shaped operation; DP and backtracking absent. Trace the
**"where is the deferred work stored"** axis.

```
  Axis: where does the "remember to come back to this" state live?

  technique          state lives in        flattr uses it?
  ────────────────   ───────────────────   ──────────────────────────
  recursion          the call stack        no (chose iteration)
  iteration          explicit loop var     YES — reconstruct() while loop
  backtracking       call stack + undo     not yet exercised
  DP memoization     a results cache       not yet exercised
  DP tabulation      a filled table        not yet exercised
```

**The seam:** the boundary between `search()` (forward, builds the `came` map)
and `reconstruct()` (backward, reads it). The contract: `search` promises every
reachable node has exactly one `came` entry pointing at its optimal
predecessor; `reconstruct` relies on that to walk a single unambiguous chain
from goal to start. Because each node has *one* predecessor (not many),
there's no branching to explore — which is precisely why this is a simple
back-walk and not backtracking.

## How it works

### Move 1 — the mental model

You've built recursion call-stack visualizers in reincodes (`Tree.ts`
generators) — you've *watched* a recursion defer and unwind. Reconstruction is
the unwind without the defer: each node points at exactly one predecessor via
the `came` map, so following the chain is just "keep asking 'who came before
me' until you hit the start."

```
  Path reconstruction — follow one back-pointer per node

  came map (built forward during search):
    G ──prev──► A ──prev──► S        (each node: exactly ONE predecessor)

  reconstruct walks it BACKWARD from goal:
    cur = G  → came[G] = {edge ag, prev A}  → record ag, cur = A
    cur = A  → came[A] = {edge sa, prev S}  → record sa, cur = S
    cur = S  → cur === start → stop
  then reverse → [S, A, G] with edges [sa, ag]
```

This is a *linear* recursion (one recursive call per step), which is the
textbook case for converting to a loop — no branching means no real stack
needed.

### Move 2 — the walkthrough

#### reconstruct — the iterative back-walk

Here's the code, `astar.ts:86-103`:

```ts
// astar.ts:86-103 — walk came backward, iteratively
function reconstruct(came, startId, goalId): { nodes, edges } {
  const nodes = [goalId];        // start the answer at the goal
  const edges = [];
  let cur = goalId;
  while (cur !== startId) {       // ← the loop that replaces recursion
    const entry = came.get(cur)!; // who came before cur, on which edge
    edges.push(entry.edge);       // record the EXACT relaxed edge (file 05)
    cur = entry.prev;             // step back one node
    nodes.push(cur);
  }
  nodes.reverse();                // we built goal→start; flip to start→goal
  edges.reverse();
  return { nodes, edges };
}
```

Walk it step by step:

- **Start at the goal, walk to the start.** The `came` chain only points
  *backward* (each node knows its predecessor, not its successor), so you must
  start at the goal end.
- **`cur = entry.prev`** — the single step that, in a recursive version, would
  be the recursive call `reconstruct(prev)`. Here it's just reassigning a loop
  variable.
- **`reverse()`** — because you built the list goal-first, flip it to the
  start→goal order the rest of the system expects.

**Why iterative, not recursive?** A recursive `reconstruct` would push one stack
frame per node on the path. For a cross-city route that's potentially thousands
of frames — a real stack-overflow risk in a JS engine. The iterative loop has
*zero* stack growth: same logic, bounded memory. *This is the case where the
"recursion is elegant" instinct is wrong — a linear chain-walk should be a
loop.* You made the same call in your reincodes BST's iterative delete.

```
  Recursive (stack grows with path length) vs iterative (flat)

  recursive:  reconstruct(G) → reconstruct(A) → reconstruct(S)
              └─ N stack frames for an N-node path → overflow risk

  iterative:  while loop, one `cur` variable
              └─ O(1) stack, O(N) loop iterations → no overflow
```

#### The bidirectional twist — two chains joined at the meeting node

`bidirectional.ts` does the same back-walk *twice* and stitches the halves. The
forward chain walks `meet → start` (via `cameF.prev`), the reverse chain walks
`meet → goal` (via `cameR.next`), `bidirectional.ts:122-144`:

```ts
// bidirectional.ts:122-130 — forward half: meet back to start
let cur = meet;
while (cur !== startId) {
  const entry = cameF.get(cur)!;
  frontEdges.push(entry.edge);
  cur = entry.prev;          // ← walk toward start
  front.push(cur);
}
front.reverse();             // [start, ..., meet]

// bidirectional.ts:133-141 — reverse half: meet forward to goal
cur = meet;
while (cur !== goalId) {
  const entry = cameR.get(cur)!;
  backEdges.push(entry.edge);
  cur = entry.next;          // ← walk toward goal (note: .next, not .prev)
  back.push(cur);
}
const nodes = [...front, ...back];   // join at meet
```

```
  Bidirectional reconstruction — two back-walks, one join

  start ●───►───►───► [meet] ◄───◄───◄───● goal
        │ cameF.prev          cameR.next │
        │ (walk to start)    (walk to goal)
        ▼                                ▼
     front = [start,…,meet]     back = [nodeAfterMeet,…,goal]
                  └────── concatenate at meet ──────┘
                  nodes = [start, …, meet, …, goal]
```

The subtlety: the forward map stores `prev` (predecessor) and the reverse map
stores `next` (successor) — because the reverse search ran *from the goal*, so
"the node it came from" is actually the node *toward the goal*. Both halves
collect the exact relaxed edges, same parallel-edge correctness as `05`.

#### Dynamic programming — not yet exercised, and why it doesn't fit

This is worth being precise about, because it's tempting to call shortest-path
"DP." Here's the honest distinction:

```
  Why flattr's search is greedy best-first, NOT dynamic programming

  ┌─ DP (Bellman-Ford / Floyd-Warshall) ──┐  ┌─ flattr (Dijkstra/A*) ──┐
  │ fill a table of subproblem answers     │  │ expand a frontier in     │
  │ in a fixed order, every cell computed  │  │ cheapest-first order,     │
  │ relaxes ALL edges V times              │  │ each node finalized ONCE  │
  │ handles negative edges                 │  │ requires non-negative     │
  │ O(V·E)                                 │  │ O((V+E) log V)            │
  └────────────────────────────────────────┘  └───────────────────────────┘
```

There *is* a DP shortest-path family — Bellman-Ford fills a table relaxing
every edge V times; Floyd-Warshall tabulates all-pairs distances. flattr uses
**neither**. Its `g` map looks table-ish, but it's filled in *priority order by
a greedy frontier*, with each node finalized exactly once — that's the Dijkstra
discipline, not DP's fixed-order table fill. The reason flattr can be greedy:
edge costs are non-negative (the `penalty` is always ≥ 0, `cost.ts:16-22`),
which is exactly the condition that lets Dijkstra's greedy choice be optimal and
removes the need for DP's repeated relaxation. *So "no DP" isn't a gap — it's
the correct consequence of having non-negative edges.* `not yet exercised`,
and rightly so.

#### Backtracking — not yet exercised

Backtracking is DFS that *undoes* choices when a branch fails — the N-queens,
sudoku, maze-with-deadends shape. flattr's reconstruction never backtracks
because there's nothing to undo: each node has exactly one predecessor, so the
chain is unambiguous. Backtracking would appear if flattr searched over a
*branching* state space with dead-ends to retreat from — which is what your
reincodes river-crossing puzzle (`PG.ts`) does, but flattr's router doesn't.
`not yet exercised`.

### Move 3 — the principle

A linear recursion — one call per step, no branching — is a loop in disguise,
and converting it removes the stack-overflow risk for free; that's the
`reconstruct` lesson. The deeper one is the DP boundary: shortest path is only
"DP" when edges can be negative (Bellman-Ford's repeated relaxation) or you want
all-pairs (Floyd-Warshall's table). With non-negative edges, the greedy
frontier (Dijkstra/A*) is both correct *and* faster, so flattr correctly avoids
DP. Recognizing *when a problem is greedy-solvable vs needs DP* is the
generalizable judgment — and the deciding question is almost always "can a cost
be negative?"

## Primary diagram

The reconstruction story, both flavors, plus the DP boundary.

```
  Recursion & its absence in flattr

  RECONSTRUCTION (iterative back-walk)
  ┌──────────────────────────────────────────────────────────┐
  │  single search:  goal ─came.prev─► … ─► start  (reverse)  │
  │    astar.ts:86   while loop, O(1) stack                   │
  │                                                            │
  │  bidirectional:  start ◄─cameF.prev─ meet ─cameR.next─► goal│
  │    bidirectional.ts:122   two walks joined at meet        │
  └──────────────────────────────────────────────────────────┘

  NOT YET EXERCISED — and why
  ┌──────────────────────────────────────────────────────────┐
  │  DP (Bellman-Ford/Floyd-Warshall)                         │
  │    → not needed: edges non-negative → greedy Dijkstra wins│
  │  backtracking                                             │
  │    → not needed: each node has ONE predecessor, no undo   │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Path reconstruction via back-pointers is the standard companion to any
shortest-path search — the search builds the predecessor map forward, a walk
reads it backward. The recursion-to-iteration conversion is general: any
*tail* or *linear* recursion converts to a loop with no behavior change, and
should when depth is unbounded (here, path length). Dynamic programming
(Bellman, 1950s) and greedy algorithms are the two pillars of optimization;
the dividing line for shortest paths is edge sign — Dijkstra's greedy proof
requires non-negative weights, and Bellman-Ford's DP exists precisely to handle
the negative case flattr's `penalty ≥ 0` rules out. flattr sits cleanly on the
greedy side by construction.

Read next: `05` (the forward search that builds the `came` map) and `01` (the
non-negative `penalty` that makes greedy correct, no DP needed).

## Interview defense

**Q: Why is your path reconstruction a loop instead of recursion?**

Because it's a *linear* back-walk — each node has exactly one predecessor in the
`came` map, so there's no branching, just "follow the chain from goal to start"
(`astar.ts:86`). A recursive version would push one stack frame per node, and a
cross-city path is thousands of nodes — a real overflow risk. The loop is the
same logic with O(1) stack.

```
  recursive: N frames for an N-node path → overflow
  iterative: one `cur` var, while-loop → flat stack
```

Anchor: "linear recursion is a loop in disguise — convert it when depth is
unbounded."

**Q: Isn't shortest-path just dynamic programming?**

No — flattr's is greedy best-first, not DP, and the reason is edge sign. DP
shortest-path (Bellman-Ford) relaxes every edge V times to handle negative
edges; flattr's `penalty` is always ≥ 0 (`cost.ts:16`), so Dijkstra's greedy
"finalize the cheapest frontier node once" is provably optimal and far faster —
`O((V+E) log V)` vs `O(V·E)`. The `g` map looks like a DP table but it's filled
in greedy priority order, each node finalized exactly once.

```
  negative edges possible?  → DP (Bellman-Ford), relax V times
  non-negative (flattr)?     → greedy Dijkstra/A*, finalize once
```

Anchor: "the deciding question is always 'can a cost go negative?' — flattr's
can't, so greedy wins and DP isn't needed."

## See also

- `05-graphs-and-traversals.md` — the forward search that builds `came`.
- `01-complexity-and-cost-models.md` — the non-negative `penalty` enabling greedy.
- `02-arrays-strings-and-hash-maps.md` — the `came` map structure.
- `08-dsa-foundations-practice-map.md` — DP and backtracking as ranked gaps.
