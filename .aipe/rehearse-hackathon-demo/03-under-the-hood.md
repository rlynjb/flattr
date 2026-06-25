# Chapter 3 — Under the hood (6:00–8:00)

The room just watched flat-first routing work. Now you earn technical credibility with *one* thing, one level deep, then stop. The trap here is the architecture tour — six boxes and a data pipeline that loses the room by the third arrow. You have two minutes and one job: show the single non-obvious mechanism that makes flattr more than a Google Maps wrapper, in about three sentences over one diagram.

For flattr that mechanism is the **directional grade cost** — the reason the route from A→B isn't the reverse of B→A. It's non-obvious, it's the product's actual differentiator, and it's genuinely yours (hand-rolled, not a library). That's the one to show.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░ │
  │ 6:00 ──────────── 8:00 ─────────────────────────10:00 │
  │     UNDER THE HOOD — you own 6:00 to 8:00 (2 min)     │
  └──────────────────────────────────────────────────────┘
```

One diagram, three sentences, then back to the close. Resist going deeper — depth is for the Q&A and the interview, not the clock.

```
  THE ONE MECHANISM — why A→B ≠ B→A

  the street graph stores each block ONCE (undirected)
        │
        │   but the COST of crossing it depends on direction:
        ▼
   ┌─────────────────────────────────────────────────┐
   │   A  ●────────── 8% grade ──────────● B          │
   │                                                  │
   │   A → B  (uphill)   penalty HIGH  → A* avoids it  │
   │   B → A  (downhill) penalty ZERO  → A* loves it   │
   └─────────────────────────────────────────────────┘
        │
        ▼
   so the search naturally routes downhill-and-flat, and the
   "flattest" path one way is NOT the reverse of the other way

   under it: ONE search() function = Dijkstra / A* / grade / directed
             (Dijkstra is just A* with a zero heuristic)
```

That diagram is the whole technical story: one edge, two costs, and a search that's really one function wearing four hats. Show it, say the three sentences, stop.

## The three sentences

```
  SAY (out loud)                        SHOW (on screen / slide)
  ──────────────────────────────        ──────────────────────────────
  "Under the hood it's a graph           the diagram above (one slide)
   search I wrote by hand — A*."
  "The trick is the cost is              point at A→B vs B→A
   directional: going up a block
   is expensive, coming down is
   free."
  "So it naturally routes you            point at the 'one search()' line
   downhill and flat — and it's
   one search function that's also
   plain Dijkstra and A*."
```

Three sentences. You've shown it's hand-rolled (credibility), named the non-obvious idea (directional cost), and signaled algorithmic depth (one function, four behaviors) — without a tour.

| WEAK MOVE | STRONG MOVE |
|---|---|
| Walk the whole pipeline: Overpass → split → elevation → grade → graph → tiles → render, box by box. | One diagram of the directional cost, three sentences, done. "Happy to go deeper in Q&A." |
| **Why it's weak:** seven boxes in two minutes is a blur; the room remembers none of it and you've spent the credibility budget on plumbing. | **Why it works:** one memorable, non-obvious idea lands and sticks. Depth is offered, not forced. |

┃ "The cost is directional — uphill is expensive, downhill is free — so the flattest way there isn't the flattest way back."

╔══════════════════════════════════════════════════════╗
║ IF IT BREAKS                                           ║
║ The diagram slide won't show → this beat needs no live ║
║ app, just the picture. If even the slide fails, draw    ║
║ the A→B/B→A arrow on a whiteboard or say it: "one       ║
║ block, two costs — uphill expensive, downhill free."   ║
║ The idea survives without the visual.                  ║
╚══════════════════════════════════════════════════════╝

## Tighten it

Short on time, cut this to ONE sentence: "Under the hood it's a hand-rolled A\* where the cost is directional — uphill expensive, downhill free." Drop the "one function = Dijkstra + A\*" line (save it for Q&A). **Floor:** say "hand-rolled" and "directional cost" — those two phrases are the entire credibility play.

## One-page run sheet

- **Budget:** 6:00–8:00. No money shot; this is the credibility beat.
- **SAY, in order:** "hand-rolled A\*" → "cost is directional: up expensive, down free" → "routes you downhill/flat; one function that's also Dijkstra and A\*."
- **Nail this line:** ┃ "The cost is directional — uphill expensive, downhill free — so the flattest way there isn't the flattest way back."
- **SHOW:** one diagram — A→B vs B→A on a single block. No pipeline tour.
- **If it breaks:** whiteboard or say the one-block/two-costs idea; no app needed.
- **Tighten:** one sentence — "hand-rolled A\*, directional cost." Floor: "hand-rolled" + "directional cost."
