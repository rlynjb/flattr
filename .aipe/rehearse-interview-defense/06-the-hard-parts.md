# Chapter 6 — The hard parts

This chapter is about three reflection questions that show up in nearly every
senior loop: the hardest bug you fixed, the part you're proudest of, and the
part you're least confident defending. They feel softer than the architecture
questions, but they're not — they're testing self-awareness and honesty under a
microscope. The candidate who says "honestly nothing was that hard" fails this
chapter. The candidate who can name a real bug, a real source of pride, and a
real soft spot — and talk about all three without collapsing — passes it.

The counterintuitive lesson: **the least-confident answer is a strong-signal
answer when handled right.** Interviewers aren't looking for someone with no
weak spots. They're looking for someone who knows where their weak spots are.
This chapter gives you all three answers grounded in flattr's real code.

---

## The chapter-opening diagram — the confidence map

Here's flattr's codebase annotated by how confidently you can defend each
region. The bright regions are where you go deep; the dim region is where the
"I don't know" honesty lives.

```
  flattr — confidence map of the codebase

  ████████████ ROCK SOLID — defend to any depth ████████████
  ┌──────────────────────────────────────────────────────────┐
  │  cost.ts          directional penalty, finite BLOCKED      │
  │  astar.ts         one parametric search(), admissible h    │
  │  graph.ts         directedGrade, adjacency, otherEnd       │
  │  pqueue.ts        hand-rolled lazy-deletion binary heap    │
  │  PROUDEST: one search() that is Dijkstra/A*/grade/directed │
  │            + provable admissibility → A* == Dijkstra       │
  └──────────────────────────────────────────────────────────┘

  ▓▓▓▓▓▓▓▓▓▓ SOLID — defend the what + why ▓▓▓▓▓▓▓▓▓▓
  ┌──────────────────────────────────────────────────────────┐
  │  useTileGraph.ts  degrade-honestly, tile merge/stitch      │
  │  elevation.ts     provider interface, retry/backoff        │
  │  HARDEST BUG: "no route" — disconnected components, found  │
  │               via a reachability probe                     │
  └──────────────────────────────────────────────────────────┘

  ░░░░░░░░░░ LEAST CONFIDENT — know the shape, not the proof ░░
  ┌──────────────────────────────────────────────────────────┐
  │  bidirectional.ts balanced potential pf = (h_goal -        │
  │                   h_start)/2; the CONSISTENCY proof and     │
  │                   the meeting-point stopping rule are the   │
  │                   part I'd flag as least-confident          │
  └──────────────────────────────────────────────────────────┘
```

You walk left to right: proudest (bright), hardest bug (solid), least confident
(dim). Honest about all three.

---

## "What's the hardest bug you fixed?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What's the hardest bug you've fixed on this project?"         │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Can you debug systematically, or do you flail? Do you reason   │
│   from symptom to root cause? Is the "hard" bug actually hard,   │
│   or just a typo you're dressing up? Do you understand WHY the   │
│   fix worked?                                                     │
└─────────────────────────────────────────────────────────────────┘
```

> "The hardest one was 'no route' between two points that visibly *should* have
> connected. You'd tap two nearby spots and get nothing back — `path: null` —
> even though there was obviously a walkable path between them on the map.
>
> My first instinct was the search was wrong. But the search was fine — I
> confirmed that by running it on a tiny fixture where I knew the answer. The
> real cause was the *graph*, not the algorithm: the two points were landing in
> *disconnected components*. When I load tiles separately and merge them, two
> tiles that share a street boundary have coincident nodes — the same physical
> corner represented as two different node ids, one per tile. The adjacency never
> linked them, so the search couldn't cross the seam.
>
> The way I found it was a reachability probe — a BFS/flood from the start node
> to see which nodes were actually reachable, and the end node simply wasn't in
> that set even though it was meters away. That told me it was a connectivity
> problem, not a search problem. The fix is `stitchGraph` (`tiles.ts`), which
> merges coincident boundary nodes so routing crosses seams. It's the classic
> mesh-construction bug the spec even warns about (§14.3, 'node identity') — two
> 'same' corners that don't share a node."

```
┃ "The search was fine. The bug was in the graph —
┃  disconnected components from coincident nodes that
┃  weren't stitched. I found it with a reachability probe."
```

Why this lands: you separated algorithm from data (a real debugging discipline),
you used a *graph technique* (reachability flood) to diagnose a *graph bug*, and
the root cause is a named classic. That's the opposite of "I added a console.log
and eventually it worked."

---

## "What are you proudest of?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What part of this are you most proud of?"                     │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   What do you think 'good engineering' is? Do you point at        │
│   something that took effort, or something that's actually        │
│   elegant? Can you articulate WHY it's good, not just that you   │
│   like it?                                                        │
└─────────────────────────────────────────────────────────────────┘
```

> "Two things, and they're related. First: there's exactly *one* search
> function. `search()` in `astar.ts:22` is Dijkstra, A*, grade-aware routing, and
> directional routing — all of them — depending only on which `(costFn,
> heuristicFn)` you pass in. Dijkstra is `search` with a zero heuristic and pure
> distance cost. A* swaps in the haversine heuristic. Grade routing swaps in the
> penalty cost. Directional routing swaps in the *signed* penalty cost. The four
> 'stages' of the progression are four three-line wrappers (`astar.ts:136-163`)
> around the same engine. Collapsing what looks like four algorithms into one
> parametric function is the thing I'm happiest with.
>
> Second, and this is what makes the first one trustworthy: the A* heuristic is
> *provably admissible*, so A* returns the exact same optimal path as Dijkstra —
> just faster. The proof is short. Cost is `length * (1 + penalty)` and penalty
> is always ≥ 0 (`cost.ts:16`), so cost is always ≥ length. The heuristic is
> straight-line haversine distance, which is always ≤ the true path length. So
> the heuristic never *overestimates* remaining cost — that's the definition of
> admissible — which means A* can't return a worse path than Dijkstra. I can test
> that invariant directly: same path, fewer nodes expanded. That's what the
> benchmark confirms."

```
        ▸ One parametric search() is four algorithms.
          A provable admissibility bound makes A* == Dijkstra.
          Elegance you can prove beats cleverness you can't.
```

The proof is your power move. Most candidates *use* A* and assume it's optimal.
You can derive *why* — penalty ≥ 0 → cost ≥ length, haversine ≤ true length →
admissible → optimal. That's the senior signal the spec names: you can reason
about invariants, not just run the algorithm (§15.1).

Deeper on the admissibility proof, lazy-deletion heaps, and the algorithm
progression → `.aipe/study-dsa-foundations/`.

---

## "What are you least confident defending?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What part of this are you least confident about?"            │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Self-awareness. Will you claim everything is solid (a lie      │
│   they'll catch) or name a real soft spot? Can you describe      │
│   what you DON'T fully understand precisely — which itself        │
│   shows you understand it better than someone who'd bluff?       │
└─────────────────────────────────────────────────────────────────┘
```

This is the question where the weak instinct is to say "nothing, really." Don't.
Name the real one.

> "The bidirectional A* — specifically its correctness proof. It works and it's
> tested, but I'm less sure I could *defend the proof* than I am for the
> single-direction search. The forward and backward searches use a balanced
> potential, `pf = (haversine-to-goal − haversine-to-start) / 2`, with the
> reverse potential being `−pf` (`bidirectional.ts:30`). I can tell you *why*
> that form is used — you need the two potentials to be consistent with each
> other so the meeting-point cost is correct, and the balanced form makes the
> forward and reverse heuristics symmetric. And I implemented the standard
> stopping rule — stop when the top of both frontiers sums to ≥ the best path
> found (`bidirectional.ts:52`).
>
> But if you pushed me to *prove* that the meeting-point reconstruction is
> guaranteed optimal under that potential — versus me having matched it to the
> textbook formulation and confirmed it against my Dijkstra oracle on fixtures —
> I'd be reconstructing the proof live, not reciting it. The forward search I can
> prove cold. The bidirectional consistency argument I'd want to walk through
> carefully rather than claim from memory."

```
┃ "The forward search I can prove cold. The bidirectional
┃  consistency argument I'd reconstruct live, not recite."
```

That is a *strong* answer. You named the exact thing (consistency of the
balanced potential + meeting-point optimality), showed you understand it well
enough to know where your certainty ends, and you have a fallback (the Dijkstra
oracle on fixtures confirms correctness empirically). Knowing precisely where
your confidence runs out is more senior than false certainty everywhere.

---

## The "I don't know" box — when they push the bidirectional proof

This is the natural place the least-confident answer gets tested. Have the
recovery ready.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They take your least-confident answer and push: "OK, prove  ║
║   the bidirectional search returns the optimal path. Why is    ║
║   the stopping rule correct?"                                  ║
║                                                               ║
║   You flagged this yourself as the proof you'd reconstruct,   ║
║   not recite. Now they're making you do it. Don't bluff a     ║
║   proof you're unsure of — reason out loud and mark your       ║
║   confidence as you go.                                        ║
║                                                               ║
║   Say:                                                         ║
║   "Let me reason through it rather than recite it. The         ║
║    stopping rule is: stop when topF + topR ≥ mu, the best     ║
║    meeting cost found so far. The intuition is that topF       ║
║    and topR are lower bounds on any remaining path through     ║
║    each frontier, so once their sum can't beat mu, no          ║
║    unexplored path can either. That relies on the potentials   ║
║    being consistent — the balanced form gives me that. The     ║
║    part I'd want to verify carefully is the edge case where    ║
║    the optimal meeting node is closed on one side before the   ║
║    other reaches it — I handle that by re-checking total cost  ║
║    when a node is found closed on the opposite side            ║
║    (bidirectional.ts:61). I'm fairly confident in the          ║
║    structure; if we're proving it rigorously I'd want to       ║
║    write out the consistency inequality, not eyeball it."      ║
║                                                               ║
║   What this signals: you can REASON through a proof you        ║
║   don't have memorized, you flag your confidence honestly at  ║
║   each step, and you point at the actual code handling the     ║
║   edge case. Reasoning + calibrated confidence beats a         ║
║   confident hand-wave every time.                             ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "It's optimal because it's bidirectional A* and that's       ║
║    proven in the literature." Appeal to authority on a proof   ║
║   you just admitted you can't reconstruct is the worst         ║
║   possible move.                                               ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## Where the hard-parts conversation goes next

```
  You named the "no route" disconnected-components bug.
        │
        ├─► IF THEY ASK "how do you prevent it now?"
        │     "stitchGraph merges coincident boundary nodes on
        │      every tile merge (tiles.ts). And endpoints are
        │      stored as coordinates, re-snapped to the current
        │      graph as tiles load (MapScreen.tsx:133) so they
        │      track the merged graph, not a stale one."
        │
        ├─► IF THEY ASK "how did you know it was the graph and
        │   │   not the search?"
        │     "I ran the search on a known-answer fixture — it
        │      was correct there. That isolated it to the data.
        │      Then the reachability flood confirmed the end
        │      node wasn't reachable from the start."
        │
        └─► IF THEY ASK "could the proudest part be simpler?"
              "The parametric search is already the simple
               version — one function, four wrappers. If
               anything I'd resist adding more cleverness; the
               readability of `search(g,s,e,max,costFn,hFn)` is
               the win."
```

---

## What you'd change about the hard parts

I'd close the loop on the least-confident one: write out the bidirectional
consistency proof formally and add a property test that fuzzes random
start/goal pairs and asserts `bidirectional` returns the *same cost* as
`directedAstar` (which I can already prove optimal). Right now my confidence in
bidirectional is empirical — it matches the oracle on fixed fixtures. Turning
that into a fuzzed invariant would move it from "solid" to "rock solid" on the
confidence map, and then I could prove it cold like the forward search. The
proudest and hardest-bug parts I wouldn't change — they're the strongest things
in the repo.

---

## One-page summary — Chapter 6

**Core claim:** Name a real bug, a real source of pride, and a real soft spot —
and handle all three honestly. The least-confident answer is a strength when
calibrated.

**The three answers:**
- **Hardest bug** → "no route" from disconnected components (coincident tile-boundary nodes); found via a reachability flood; fixed with `stitchGraph` (tiles.ts). Separated algorithm from data.
- **Proudest** → one parametric `search()` is Dijkstra/A*/grade/directed via `(costFn, heuristicFn)` (astar.ts:22); plus provable admissibility (penalty ≥ 0 → cost ≥ length; haversine ≤ true length → A* == Dijkstra).
- **Least confident** → bidirectional A* consistency proof + meeting-point stopping rule (bidirectional.ts:30,52). Forward search provable cold; bidirectional reconstructed live, with a Dijkstra oracle as the empirical backstop.

**Pull quotes:**
- ┃ "The search was fine. The bug was in the graph — disconnected components, found with a reachability probe."
- ▸ One parametric search() is four algorithms; provable admissibility makes A* == Dijkstra.
- ┃ "The forward search I can prove cold. The bidirectional argument I'd reconstruct live, not recite."

**What you'd change:** Add a fuzzed property test asserting `bidirectional` cost == `directedAstar` cost over random pairs, and write the consistency proof formally — move bidirectional from empirically-solid to provably-solid.
