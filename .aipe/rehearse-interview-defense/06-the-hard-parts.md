# Chapter 6 — The Hard Parts

These are the reflection questions: the hardest bug you fixed, the part
you're proudest of, the part you're least confident defending. They're not
trivia — they're character questions. The interviewer is reading *how* you
talk about difficulty, pride, and uncertainty, because that's how you'll
behave on their team when something breaks at 2am.

The counterintuitive truth this chapter teaches: "the part I'm least
confident defending" is a *strong-signal* answer when you handle it right.
Candidates who claim total confidence in everything read as either junior or
dishonest. Candidates who can point at the one proof they couldn't fully
nail, and reason about it cleanly anyway, read as senior. This chapter gives
you all three answers, grounded in real code.

---

## The confidence map

This is the chapter's spine: flattr's code, annotated by how confidently you
can defend each region. The regions are the answers to the three reflection
questions — proudest (high confidence), hardest bug (high, because you solved
it), least confident (the bidirectional proof).

```
  flattr — the confidence map

  HIGH CONFIDENCE — defend these all day
  ┌────────────────────────────────────────────────────────────┐
  │ ★ PROUDEST: one parametric search()         astar.ts:22     │
  │   Dijkstra / A* / grade / directional are all the SAME      │
  │   function with different (costFn, heuristicFn). And the     │
  │   A* heuristic is provably admissible, so A* == Dijkstra's   │
  │   answer, just faster.                                       │
  │                                                              │
  │   directional cost                          cost.ts:32      │
  │   BLOCKED finite sentinel                    cost.ts:5       │
  │   hand-rolled binary heap                    pqueue.ts       │
  └────────────────────────────────────────────────────────────┘

  HARD-WON — solved it; can walk the whole debugging story
  ┌────────────────────────────────────────────────────────────┐
  │ ★ HARDEST BUG: "no route" on a connected-looking map         │
  │   Cause: disconnected components. Found via a reachability    │
  │   probe. Fixed by corridor tile pre-load.   MapScreen.tsx:139│
  └────────────────────────────────────────────────────────────┘

  LOWER CONFIDENCE — honest about the proof I couldn't fully nail
  ┌────────────────────────────────────────────────────────────┐
  │ ▲ LEAST CONFIDENT: bidirectional balanced-potential          │
  │   consistency. The forward/backward potentials and the       │
  │   stopping rule are correct empirically (tests pass), but I   │
  │   can't hand you the full consistency PROOF.  bidirectional.ts│
  └────────────────────────────────────────────────────────────┘
```

Lead the chapter on the proudest region (the one parametric `search()`), pivot
to the hardest bug (you solved it), and close honestly on the bidirectional
proof. That arc — strength, resilience, honesty — is the shape interviewers
are listening for.

---

## The hardest bug — "no route" on a connected-looking map

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What's the hardest bug you debugged on this project?" │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Not "do you write bug-free code." They want your       │
│   DEBUGGING PROCESS: how you form a hypothesis, how you  │
│   isolate, how you confirm. A good bug story is a story  │
│   about method, not about being smart.                   │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice — tell it as a method story:

> "The hardest one was routing returning 'no route' between two points that
> looked obviously connected on the map. The map showed a continuous street
> network; the router said there was no path. That's the worst kind of bug —
> the visual evidence contradicts the result.
>
> My first hypothesis was the search itself — maybe A* was terminating early.
> I ruled that out by checking: `search` returns `path: null` only when the
> frontier empties without reaching the goal (astar.ts:77). If the goal were
> reachable, it'd be found. So the search was correct — which meant the goal
> genuinely *wasn't* reachable in the graph, even though it looked reachable
> on the map.
>
> That reframed it from a search bug to a *graph* bug. I confirmed it with a
> reachability probe — a plain flood-fill from the start node to see which
> nodes it could actually reach, and the end node wasn't in that set. The
> graph had disconnected components: the street network rendered as
> continuous, but the underlying graph had gaps — two subgraphs that didn't
> share an edge. The map lied; the graph was right.
>
> The root cause was that I was loading graph *tiles* on demand, and the start
> and end were landing in tiles that hadn't both loaded, so they sat in
> separate components. The fix is in MapScreen.tsx:139 — when both endpoints
> are set, I pre-load every tile spanning them plus a tile of margin, so the
> graph is guaranteed connected end-to-end before I route. The margin matters
> because the optimal route can bow outward around an obstacle, past the
> straight-line corridor."

The method is the answer: hypothesis (search bug) → ruled out by reading the
termination condition → reframe (graph bug) → confirmed with a reachability
probe → root cause (tile loading) → fix (corridor pre-load). That's a clean
debugging narrative, and "the map lied, the graph was right" is the memorable
line.

```
┃ "The map rendered as connected. The graph wasn't. The bug
┃  was believing the picture over the data structure."
```

---

## The proudest part — one search() to rule them all

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What part of this are you proudest of?"               │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   What do you think GOOD engineering looks like? Your    │
│   answer reveals your taste. "I'm proud it works" is     │
│   empty. "I'm proud of this specific design property and │
│   here's why it's elegant" shows you have standards.     │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "Two things, and they're related. First, there's exactly *one* search
> function. Dijkstra, plain A*, grade-aware A*, and directional A* aren't four
> implementations — they're one `search()` (astar.ts:22) called with different
> `(costFn, heuristicFn)` pairs. Dijkstra is `search` with a distance cost and
> a zero heuristic. A* is the same with a haversine heuristic. Directional is
> the same with the directed-grade cost. The progression I built —
> Dijkstra → A* → grade → directional → bidirectional — is a progression of
> *arguments*, not of code. That collapse is the thing I'm proudest of,
> because it means there's one place for a bug to live, not four.
>
> Second, and this is the part I can actually *prove*: the A* heuristic is
> admissible. It's haversine straight-line distance to the goal
> (astar.ts:9), which is a true lower bound — the real path can't be shorter
> than the straight line — and my grade penalty is always ≥ 0, so adding it
> only makes paths cost *more*, never less. Admissible heuristic means A*
> returns the same optimal path Dijkstra would, just by expanding far fewer
> nodes. So I'm not trading correctness for speed — I get Dijkstra's answer at
> A*'s cost, and I can show why."

The provable-admissibility point is the load-bearing one. Lots of people say
"I used A*." Being able to say *why the heuristic is a valid lower bound and
why that guarantees optimality* is the difference between using an algorithm
and understanding it.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'm proud that I        │ "There's one search()   │
│ implemented A* and it    │ function — Dijkstra, A*,│
│ finds good routes fast." │ grade, directional are  │
│                          │ all the same code with  │
│                          │ different cost/heuristic│
│                          │ args. And the heuristic │
│                          │ is provably admissible: │
│                          │ haversine is a true     │
│                          │ lower bound and the      │
│                          │ penalty is >= 0, so A*  │
│                          │ returns Dijkstra's exact │
│                          │ answer, faster."        │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "It works fast" is a     │ Names a design property │
│ result, not a design     │ (one function, four     │
│ insight. Anyone can say  │ behaviors) AND a        │
│ it. It reveals no taste. │ correctness PROOF       │
│                          │ (admissibility →        │
│                          │ optimality). Reveals    │
│                          │ standards.              │
└─────────────────────────┴─────────────────────────┘
```

For the full treatment of A* admissibility, why the haversine lower bound
holds, and the heap mechanics underneath, point yourself at
**`.aipe/study-dsa-foundations/`**.

```
┃ "The progression Dijkstra → A* → directional is a
┃  progression of ARGUMENTS, not of code. One search(),
┃  four behaviors."
```

---

## The least confident part — the bidirectional proof

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What part of this are you LEAST confident defending?" │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Can you be honest about a limit without collapsing?    │
│   This question separates people who can say "here's the │
│   exact edge of what I'm sure of, and here's how I'd     │
│   close it" from people who either fake confidence or    │
│   fall apart. The honest, precise answer is the senior   │
│   one.                                                   │
└─────────────────────────────────────────────────────────┘
```

This is the chapter's most important answer. Handle it right and it's your
strongest moment, not your weakest.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW — and it's the question itself            ║
║                                                               ║
║   "What are you LEAST confident defending?" is the rare       ║
║   question where the honest answer IS the strong answer. The  ║
║   trap is treating it like a weakness to minimize. Don't.     ║
║   Name the precise edge of your certainty.                    ║
║                                                               ║
║   Say:                                                        ║
║   "The bidirectional search. It runs a forward search from    ║
║    the start and a backward one from the goal and meets in    ║
║    the middle, and to keep A*'s pruning on both sides I use a  ║
║    balanced potential — the forward potential is               ║
║    (dist-to-goal minus dist-to-start) over two, and the       ║
║    reverse is its negation (bidirectional.ts:30). Empirically  ║
║    it's correct — it returns the same paths as my single-      ║
║    direction A*, and the tests pass. What I can't fully hand   ║
║    you on a whiteboard is the consistency PROOF: the formal    ║
║    argument that the balanced potential stays consistent on    ║
║    both sides and that the stopping rule — stop when the two   ║
║    frontiers' top priorities sum to at least the best path     ║
║    found (bidirectional.ts:52) — provably yields the optimal   ║
║    meeting point. I trust it because it's tested and it        ║
║    matches the single-direction result, but proving it from    ║
║    first principles is the part I'd want to sit down and work  ║
║    through carefully before I claimed I had it."              ║
║                                                               ║
║   What this signals: you understand the mechanism precisely    ║
║   (you can describe the potential and the stopping rule), you  ║
║   know EXACTLY where your confidence ends (the formal proof,   ║
║   not the implementation), and you back the gap with           ║
║   empirical evidence (tests, agreement with single-direction). ║
║   That is a textbook senior answer.                           ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "Oh, bidirectional search, yeah, it's just two searches     ║
║    that meet in the middle, it's totally fine." — false        ║
║   confidence on the one thing you're genuinely unsure of is    ║
║   the worst possible read, because the follow-up ("prove the   ║
║   stopping rule is optimal") will expose it instantly.        ║
╚═══════════════════════════════════════════════════════════════╝
```

The structure of that answer is the lesson: *I understand the mechanism, I
can name the exact thing I can't prove, and I have empirical evidence the
implementation is right.* That's not weakness — it's calibration, and
calibration is a senior signal.

```
┃ "The strongest answer to 'what are you least confident
┃  about' isn't a small weakness. It's a precise one,
┃  backed by evidence, with the edge named exactly."
```

---

## What you'd change

In the territory of the hard parts, the thing I'd change is to write the
bidirectional consistency proof down — not just rely on the tests agreeing
with single-direction A*. The implementation is right; what's missing is the
*argument* for why, and that gap is exactly the one I name as my least
confident. Turning empirical confidence into proven confidence is the work
that would move that region of the confidence map from amber to green.

---

## One-page summary — read this the night before

**Core claim:** The reflection questions are character questions. Lead with
the proudest part (one parametric `search()`, provable admissibility), tell
the hardest bug as a *method* story, and answer "least confident" with a
precise, evidence-backed edge — that honesty is a senior signal.

**Questions covered:**
- *Hardest bug* → "no route" on a connected-looking map. Method: ruled out the
  search (astar.ts:77), reframed to a graph bug, confirmed with a reachability
  probe, root-caused to tile loading, fixed with corridor pre-load
  (MapScreen.tsx:139). "The map lied; the graph was right."
- *Proudest* → one `search()` (astar.ts:22) for Dijkstra/A*/grade/directional;
  provably admissible heuristic (haversine lower bound + penalty ≥ 0) ⇒ A*
  returns Dijkstra's optimal answer, faster.
- *Least confident* → the bidirectional balanced-potential consistency proof
  (bidirectional.ts:30, :52). Implementation tested and correct; the formal
  proof is the named edge.

**Pull quotes:**
- "The map rendered as connected. The graph wasn't."
- "One search(), four behaviors — a progression of arguments, not code."
- "The strongest 'least confident' answer is a precise one, backed by
  evidence."

**What you'd change:** Write the bidirectional consistency proof down — turn
empirical confidence into proven confidence.
