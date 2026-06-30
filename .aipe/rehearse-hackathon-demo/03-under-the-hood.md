# Chapter 3 — Under the Hood   (6:00–8:00, 2 min)

## Opening hook

The demo earned their attention; this chapter earns their respect. You show
*one* technical thing — the single non-obvious mechanism that makes flattr work —
and you go exactly one level deep, then stop. Two minutes, one diagram, three
sentences of mechanism. The trap here is the architecture tour: the presenter who
loves their code walks the whole pipeline and loses the room at the third box.
You're not doing that. You're showing the one idea that makes the route bend, and
moving on.

The one idea is **directional cost**: going from A to B is not the same as going
from B to A, because uphill costs and downhill is free. That asymmetry is why the
route bends around the hill instead of straight over it — and it's the thing
judges don't expect a weekend build to get right.

## The time-budget bar

Two minutes. One diagram up, three sentences, done. Resist going deeper.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────────── 6:00 ─── 8:00 ────────────────── 10:00│
  │        UNDER THE HOOD — you own 6:00 to 8:00 (2 min)      │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — directional cost (A→B ≠ B→A)

This is the only technical diagram you show. It says everything: the same edge
between two nodes costs differently depending on which way you travel it, because
the grade is signed by direction. Uphill is penalized; downhill and flat are
free. That single asymmetry is what makes the router prefer the flat way around.

```
  DIRECTIONAL COST — the same edge, two prices

         the EDGE between two street corners A and B
         (rises +6% from A up to B)

              A  ●━━━━━━━━━━━━━━━━━━●  B
                 (low)           (high)

  ┌─ travel A → B  (UPHILL) ──────────────────────────────────┐
  │  directedGrade =  +6%                                     │
  │  penalty(+6%, max 8%)  → quadratic, > 0                   │
  │  cost = lengthM × (1 + penalty)   →  EXPENSIVE            │
  └───────────────────────────────────────────────────────────┘

  ┌─ travel B → A  (DOWNHILL) ────────────────────────────────┐
  │  directedGrade =  −6%                                     │
  │  penalty(−6%, max 8%)  → 0   (downhill/flat is free)      │
  │  cost = lengthM × (1 + 0)         →  CHEAP (just distance)│
  └───────────────────────────────────────────────────────────┘

         same edge ─┬─ A→B costs more than B→A
                    └─ the router treats them as DIFFERENT moves
                       → so it routes the flat way AROUND the climb

  where it lives:
    features/routing/graph.ts  directedGrade()  — signs grade by direction
    features/routing/cost.ts   penalty()        — 0 down/flat, quad up, BLOCKED over max
    features/routing/astar.ts  search()         — A* using that directed cost
```

The key line is the bottom one: because A→B and B→A have different prices, the
search engine sees them as two different moves, and it'll happily take a longer
flat path over a short steep one. That's the bend, in code.

## The body — three sentences and stop

You say three sentences over that diagram. Not three paragraphs — three
sentences. This is the discipline of the chapter: enough to earn credibility, not
enough to lose the room.

```
  SHOW (on screen)               SAY (out loud)
  ─────────────────────────      ──────────────────────────────────
  the directional-cost diagram   "Here's the one idea that makes it
  on screen                       work: a street's grade is SIGNED by
                                  direction — uphill is positive,
                                  downhill is negative."
  point at the two cost boxes    "So the same block costs more going
                                  up than coming down. Uphill gets a
                                  penalty; downhill and flat are free."
  point at the A* box            "I feed that directed cost into a
                                  hand-rolled A* search — so it finds
                                  the cheapest path, and cheapest now
                                  means flattest."
```

That's it. Three sentences: grade is signed, uphill costs more than down, A*
finds the cheapest-and-now-flattest path. Stop talking and move to Chapter 4.

### The one detail worth naming if a judge leans in

If — and only if — you see a judge lean in wanting more, you have one extra beat
that signals you built this, not borrowed it: the penalty for going *over* the
user's max grade is a large *finite* number (`BLOCKED = 1e9`), not infinity. That
keeps "no flat route exists, here's the least-bad one" distinct from "no route
exists at all." It's the kind of detail that says you thought about the edge
cases. Don't volunteer it unprompted — it's a follow-up, not a beat.

## Strong vs weak — one level deep, then stop

The contrast this chapter teaches against.

```
  WEAK — the architecture tour        STRONG — one idea, one level
  ─────────────────────────────       ──────────────────────────────────
  "So OSM data comes through          "Grade is signed by direction —
   Overpass, gets split into           uphill positive, downhill
   segments, elevation from            negative. Same block costs more
   Open-Meteo on a 90m DEM,            up than down. I feed that into a
   built into an adjacency list,       hand-rolled A* — cheapest path is
   then there's the tile merge         now the flattest. That's the
   and the stitch step, and the        whole trick."
   pqueue is a binary heap, and…"
                                       → one idea, earns respect, 30 sec,
  → six boxes, room glazes over,         room still with you
    you're now at 8:30 and behind
```

The weak version is *more* impressive on paper and *less* effective in the room.
Every box you add past the first divides the room's attention. One idea, told
well, beats six boxes.

## IF IT BREAKS

This chapter is a static diagram, not a live app — low risk. The only failure is
the slide not showing. You don't need the visual; the asymmetry is speakable.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                 ║
  ║ Diagram slide won't display → say it as three sentences      ║
  ║ with your hands: "going uphill costs more than coming down   ║
  ║ the same street — I sign the grade by direction and feed it  ║
  ║ to A*, so cheapest means flattest." No visual required.      ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" cut

This is the first chapter to cut when you're long — it's a ceiling, not a floor.
Drop it to **one sentence over the diagram**: "the trick is grade is signed by
direction, so uphill costs more than downhill, and A* finds the flattest path."
If you're truly out of time, **cut the chapter entirely** and let the demo speak
for the tech. The money shot already proved it works; this chapter only adds
*why*.

## The one-page run sheet

```
  ┌─ RUN SHEET — CH 3 UNDER THE HOOD ── 6:00–8:00 (2 min) ────┐
  │                                                           │
  │  ONE DIAGRAM: directional cost — A→B ≠ B→A.               │
  │                                                           │
  │  SAY (exactly three sentences):                           │
  │   • "Grade is signed by direction — up positive, down     │
  │      negative."                                           │
  │   • "Same block costs more up than down; flat/down free." │
  │   • "Feed that into hand-rolled A* — cheapest = flattest."│
  │                                                           │
  │  NAIL THIS LINE:                                          │
  │   ┃ "The same block costs more going up than coming down. │
  │   ┃  Cheapest path is now the flattest path."             │
  │                                                           │
  │  ONLY IF A JUDGE LEANS IN: BLOCKED is finite (1e9), not   │
  │   ∞ — keeps 'no flat route' distinct from 'no route'.     │
  │                                                           │
  │  files: graph.ts (directedGrade) · cost.ts (penalty) ·    │
  │         astar.ts (search)                                 │
  │                                                           │
  │  IF IT BREAKS: say the three sentences, no visual needed. │
  │                                                           │
  │  TIGHTEN: drop to ONE sentence, or cut the chapter.       │
  │   This chapter is a CEILING — first to go when long.      │
  └────────────────────────────────────────────────────────────┘
```
