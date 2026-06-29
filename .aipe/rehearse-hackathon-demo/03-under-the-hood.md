# Chapter 3 — Under the Hood   (6:00–8:00, 2 minutes)

## Opening hook

The room believes the demo. Now you earn the credibility that turns "neat
toy" into "they actually built something." Two minutes, one diagram, three
sentences — and then you stop. The discipline of this chapter is going
*exactly* one level deep. Not the architecture tour, not the PQueue, not the
tiling. One non-obvious mechanism that makes the demo make sense, drawn once,
explained fast.

The thing worth showing is the one that surprises people: **going from A to B
is not the same cost as going from B to A.** Uphill is expensive, downhill is
free — so the route depends on which direction you're traveling. That's the
insight that makes flattr more than a steepness heatmap, and it fits in one
diagram.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░ │
  │ 6:00 ──────────────── 8:00 ──────────────────────────10:00 │
  │   UNDER THE HOOD — you own 6:00 to 8:00 (2 min)           │
  │   ONE diagram (A→B ≠ B→A) + three sentences, then stop.   │
  └──────────────────────────────────────────────────────────┘
```

Two minutes. One diagram. Resist every urge to go deeper.

## The chapter-opening diagram — directional grade cost (A→B ≠ B→A)

This is the only diagram in the chapter and the only technical picture in the
whole talk. Same physical street, two travel directions, two completely
different costs — because the penalty is signed by direction. Draw this (or
have it on a slide) and talk to it.

```
  THE ONE IDEA — uphill costs, downhill is free, so A→B ≠ B→A

  the same street segment, elevation rises left→right:

         A  ●──────────────────●  B
            low                 high
            (10 m)             (22 m)

  ┌─ travel A → B (UPHILL) ──────────────────────────────────┐
  │  directedGrade = +12%   →  penalty kicks in (it's > userMax)│
  │  cost = length × (1 + penalty)  ──►  EXPENSIVE / BLOCKED    │
  └────────────────────────────────────────────────────────────┘

  ┌─ travel B → A (DOWNHILL) ────────────────────────────────┐
  │  directedGrade = −12%   →  g ≤ 0  →  penalty = 0           │
  │  cost = length × (1 + 0)  ──►  CHEAP (free descent)        │
  └────────────────────────────────────────────────────────────┘

       UI: route line       Service: cost.ts          Data: Edge
   colored by directed   penalty(g,max): g≤0 → 0    gradePct is signed
   grade (green if ≤0)   moderate → linear          from→to; flip the
                         steep → quadratic          sign on reverse
                         over max → BLOCKED          traversal
```

Notice the boundary that makes this work: `BLOCKED` is a large *finite*
constant, not `Infinity` — so an only-steep route is still returned and
flagged, while a genuinely disconnected one returns `null`. That's the seam
between "no flat way" and "no way," and it's the hinge of chapter 04's
debugging story.

## The body — the three sentences

You say exactly this much, pointing at the diagram, and no more:

```
┃ "Most routers treat a hill as a hill. flattr signs the
┃  grade by direction — uphill costs, downhill is free —
┃  so going A-to-B and B-to-A are different searches."
```

```
┃ "That cost feeds a hand-rolled A* over a street graph
┃  where every edge knows its grade — so 'flattest route'
┃  is just shortest-path with an uphill penalty."
```

```
┃ "And when the only path is steep, it still returns one and
┃  flags it — it never lies to you that there's no route."
```

Three sentences. The mechanism, the algorithm, the honesty. Then you stop and
move to the build story. Do not start explaining the priority queue.

### Where this lives in the code (one anchor, if asked)

You don't read code on stage, but keep this in your pocket for a judge who
leans in. The whole directional idea is four lines in
`features/routing/cost.ts`:

```
  penalty(g, max):                    // g = SIGNED directed grade %
    if g <= 0:        return 0        // downhill / flat → free  ◄── A→B ≠ B→A
    if g >  max:      return BLOCKED  // over your max → large-finite, not ∞
    if g <= 0.5*max:  return k1 * g           // moderate → linear
    else: return k2*(g-0.5*max)² + k1*0.5*max // steep → quadratic
```

`gradeCostDirected` wraps it with `directedGrade(edge, fromNode)`, which flips
the sign on reverse traversal (`features/routing/graph.ts`) — that one sign
flip is the entire A→B ≠ B→A behavior. The same `search()` in
`features/routing/astar.ts` runs every stage; the only thing that changes
between Dijkstra, A*, and directional-A* is which cost function you hand it.

### Strong vs weak — the under-the-hood move

```
  WEAK under-the-hood              STRONG under-the-hood
  ──────────────────────────      ──────────────────────────
  "So the architecture is a       ONE diagram: A→B ≠ B→A.
   pipeline that builds a graph    "Uphill costs, downhill's
   artifact, then a tile layer,    free — so direction matters."
   a stitch step, a PQueue with    → three sentences → stop
   lazy deletion, a bidirectional
   variant..."                     If they want the PQueue, the
  → 6 mechanisms, room glazes      tiling, the bidirectional A* —
                                    that's Q&A and the defense book.
  → loses the room it just won     → goes exactly one level deep
```

Going deep here feels like rigor. It reads as losing the room. One level,
then stop — the depth is what chapter 06 and the interview-defense book are
for.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — you blank on the mechanism / a judge interrupts ║
║ with "wait, how does that actually work?"                      ║
║ Fall back to the one diagram and the one sentence: "Uphill     ║
║ costs, downhill is free, so A-to-B and B-to-A are different    ║
║ searches." That single line IS the chapter. If they want more, ║
║ say "happy to go deep on the A* in Q&A" and move on — don't    ║
║ burn demo time going down the algorithm rabbit hole on stage.  ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

**Cut:** the second and third script sentences (the A* line and the honesty
line). Keep only the first — "uphill costs, downhill's free, so direction
matters" — point at the diagram, and move on.
**Floor:** the diagram + one sentence. The room needs *one* "huh, that's
clever" technical beat to believe you built it. Below that, you've cut the
credibility this chapter exists to buy.

## The one-page run sheet

```
  ┌─ CH 03 · UNDER THE HOOD · 6:00–8:00 ─────────────────────┐
  │                                                           │
  │  SHOW: the ONE diagram — A→B ≠ B→A (directional cost)     │
  │                                                           │
  │  SAY, three sentences, then STOP:                         │
  │   1. ┃ "Grade is signed by direction — uphill costs,      │
  │         downhill's free — so A→B ≠ B→A."                  │
  │   2. ┃ "Feeds a hand-rolled A* over a graded street       │
  │         graph — flattest = shortest-path + uphill penalty."│
  │   3. ┃ "Only-steep path still returns, flagged — never    │
  │         lies that there's no route."                      │
  │                                                           │
  │  POCKET ANCHOR: cost.ts penalty(g,max), BLOCKED ≠ ∞       │
  │                                                           │
  │  IF ASKED DEEPER: "happy to go deep in Q&A" → don't       │
  │    rabbit-hole on stage. (defense book has the PQueue.)   │
  │                                                           │
  │  TIGHTEN: keep sentence 1 only. FLOOR: diagram + 1 line.  │
  └───────────────────────────────────────────────────────────┘
```

Go to chapter 04 — prove it's real.
