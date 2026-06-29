# Chapter 4 — The Build Story   (8:00–8:45, 45 seconds)

## Opening hook

Forty-five seconds to prove this is a real build, not a mockup, and the way
you do that is with one specific war story — the bug that almost killed it and
the fix that saved it. Judges have seen a hundred pitch decks dressed up as
demos. The thing that separates you is a *concrete* obstacle, named precisely,
with the real fix. You're not listing features here. You're telling the one
story that only someone who actually built this could tell.

The story is the "no route" bug — when two valid addresses returned nothing,
and why. Tell it tight, land the fix, then own one rough edge with your chin
up. Owning a limitation reads as confidence; hiding it reads as a pitch.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░ │
  │ 8:00 ─────────────────────── 8:45 ───────────────────10:00 │
  │   THE BUILD STORY — you own 8:00 to 8:45 (45 sec)         │
  │   ONE debugging win + ONE owned rough edge. Fast.         │
  └──────────────────────────────────────────────────────────┘
```

Forty-five seconds. One story, told clean. No feature list.

## The chapter-opening diagram — the "no route" debugging win

This is the bug and the fix in one picture. Two valid addresses, no route
returned — because they landed in two *disconnected* graph components, and the
fix was to load the corridor between them so they sit in one connected graph.

```
  THE "NO ROUTE" BUG → THE FIX

  ─── BEFORE: the reachability probe says "unreachable" ───

   start ●         (gap: no edges loaded here)         ● end
     │                                                   │
   ┌─┴── component A ──┐                   ┌── component B ┴─┐
   │ loaded tile       │   ✗ NO PATH       │ loaded tile     │
   │ around start      │   between them     │ around end      │
   └───────────────────┘                   └─────────────────┘
        A* explores A, drains its frontier, never reaches B
        → returns null → card: "No route between those points"
        (but the streets obviously connect in real life!)

  ─── AFTER: load the corridor → one connected component ───

   start ●━━━━━━━━━━━━ corridor tiles loaded ━━━━━━━━━━━● end
     │                                                   │
   ┌─┴───────────────── one merged + stitched graph ─────┴─┐
   │  ensureBbox([min..max] + 1 tile margin) → fetch the    │
   │  WHOLE span → mergeGraphs → stitchGraph (snap          │
   │  coincident boundary nodes so seams actually connect)  │
   └────────────────────────────────────────────────────────┘
        A* now crosses the seam → real route → it bends
        around the hill. (MapScreen.tsx:139 endpoint effect)
```

The bug looked like a routing failure but it was a *graph connectivity*
failure — and telling that difference is the whole story.

## The body — the beats in order

### Beat 1 — what shipped (one sentence, 8:00–8:10)

Don't list features. One sentence that says "this is a working system."

```
┃ "Everything you just saw is real — a hand-rolled A* router
┃  over a street graph I build on-device from live OpenStreetMap
┃  and elevation data. No Google Maps API doing the work."
```

The "hand-rolled, no routing API" point matters — it tells judges the graph
work is *yours*, which is exactly what they probe for in Q&A.

### Beat 2 — the debugging win (8:10–8:35)

The story. Tell it like it happened, because it did.

```
  SHOW (on screen / slide)      SAY (out loud)
  ──────────────────────        ─────────────────────────────
  the BEFORE half of the        "Early on, two perfectly valid
  diagram (two components)       addresses would just return 'no
                                 route' — even though the streets
                                 obviously connect."
  ──────────────────────        ─────────────────────────────
  point at the gap              "Turned out the start and end were
                                 landing in two disconnected pieces
                                 of the graph — I'd only loaded
                                 tiles around each endpoint, not
                                 the gap between them."
  ──────────────────────        ─────────────────────────────
  the AFTER half               "The fix: when you set both points,
                                 load the whole corridor between
                                 them, merge it, and stitch the
                                 seams so the nodes actually join.
                                 Now A* crosses it."
```

```
┃ "It looked like a routing bug. It was a graph-connectivity
┃  bug — two components that never touched. Once I loaded and
┃  stitched the corridor, the route just appeared."
```

The detail that makes this credible: I kept `BLOCKED` as a large *finite*
number, not `Infinity`, so the router never confuses "this path is too steep"
with "there's no path." A `null` route means genuinely disconnected — like the
bug — and "flattest available" with flagged steep blocks means it exists but
climbs. Two different graph states, surfaced honestly. That distinction is why
I could even *see* this was a connectivity bug and not a cost bug.

### Beat 3 — own the rough edges (8:35–8:45)

Name a real limitation, flat, no apology. This is the move that reads as
confidence.

```
┃ "Two honest edges: my elevation data is coarse — about a
┃  90-meter grid — so grades are approximate, and I label them
┃  that way. And when the free elevation API rate-limits me,
┃  I fall back to flat and retry rather than crash. I'd rather
┃  the map stay up and tell you it's approximate than lie."
```

That's it. You named the coarse 90 m DEM and the flat-fallback-on-throttle,
you framed both as deliberate ("I'd rather X than Y"), and you moved on. No
"unfortunately," no "we ran out of time." Shipped under a clock, owns the
tradeoffs.

### Strong vs weak — the build-story move

```
  WEAK build story                 STRONG build story
  ──────────────────────────      ──────────────────────────
  "We built a router, a heatmap,   ONE bug: "two addresses
   a slider, autocomplete, a tile   returned no route — they were
   system, an elevation cache,       in disconnected components.
   a fallback system, swap..."        Loaded the corridor, fixed."
  → feature checklist, no proof    → a story only the builder
    it was hard or real              could tell → proves it's real

  Hide the rough edges, hope no    "Grades are coarse — 90 m grid
  one asks                          — and I label them approximate
                                     on purpose."
  → defensive when asked           → owns it → reads as confident
```

The weak column is a résumé. The strong column is a story. A story that names
a real bug and a real fix is the single strongest proof in the whole talk that
this is a build, not a deck.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — you're out of time / lose the thread           ║
║ This chapter has no live demo, so nothing crashes — but it's   ║
║ the first thing to compress if the demo ran long. Collapse to  ║
║ one line: "Hardest part was a 'no route' bug — two addresses   ║
║ in disconnected graph pieces; I load and stitch the corridor   ║
║ between them now." Then jump to the close. The story survives   ║
║ as a single sentence.                                          ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

**Cut:** beat 3 (the rough edges) — fold it into Q&A instead, where "what are
the limitations?" is asked anyway.
**Floor:** beat 2, the debugging win, in at least one sentence. If you cut the
whole story you've cut the proof that it's real — and a working build's only
edge over a pitch deck is proof. Keep the bug.

## The one-page run sheet

```
  ┌─ CH 04 · BUILD STORY · 8:00–8:45 ────────────────────────┐
  │                                                           │
  │  BEAT 1 (8:00) what shipped, ONE line:                    │
  │   ┃ "real hand-rolled A* over a graph I build on-device   │
  │      from live OSM + elevation. No routing API."          │
  │                                                           │
  │  BEAT 2 (8:10) ★ THE BUG:                                 │
  │   ┃ "two valid addresses → 'no route' → they were in      │
  │      DISCONNECTED graph components. Fix: load + stitch     │
  │      the corridor between them. A* now crosses it."        │
  │   • BLOCKED is large-FINITE, not ∞ → 'too steep' ≠         │
  │     'no path'. That's how I saw it was connectivity.       │
  │                                                           │
  │  BEAT 3 (8:35) own it, no apology:                        │
  │   ┃ "grades are coarse — 90 m grid, labeled approximate.  │
  │      API throttles → flat fallback + retry, not a crash."  │
  │                                                           │
  │  IF SHORT ON TIME: collapse to beat 2 one-liner → close.  │
  │  TIGHTEN: cut beat 3 (it's a Q&A anyway).                 │
  │    FLOOR: keep the bug. It's the proof.                   │
  │                                                           │
  │  DEEPER: defense book → 04-honest-fallback-routing.md,    │
  │          study → 03-tile-merge-stitch.md                  │
  └───────────────────────────────────────────────────────────┘
```

Go to chapter 05 — land the last line.
