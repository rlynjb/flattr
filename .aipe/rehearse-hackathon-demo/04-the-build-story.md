# Chapter 4 — The Build Story   (8:00–8:45, 0:45)

## Opening hook

Forty-five seconds to prove this is a real build, not a mockup — and the way you
do that is by telling the story of the one hard bug you actually cracked. Not a
feature list. A war story. Judges have seen a hundred demos that look real and
fall apart on the second question; the thing that separates yours is that you can
name a genuine obstacle, how you diagnosed it, and how you fixed it. You have one
perfect story for this, and it's true: the "no route" bug.

The discipline here is brevity. Forty-five seconds is one obstacle, one diagnosis,
one fix — told fast, owned cleanly, including the rough edges. Don't reach for a
second story; you don't have time, and the first one is strong enough.

## The time-budget bar

Three-quarters of a minute. One story: problem, probe, fix.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ─────────────────────── 8:00 ─ 8:45 ──────────── 10:00│
  │        BUILD STORY — you own 8:00 to 8:45 (45 sec)        │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the 'no route' bug and the fix

This is the bug, the diagnosis, and the fix in one frame. The story has a perfect
shape: a symptom that made no sense (both addresses exist, but "no route"), a
probe that found the real cause (the two endpoints sat in two disconnected
graphs), and a fix that's genuinely clever (load the whole corridor between them
in one build and stitch it together).

```
  THE 'NO ROUTE' BUG → THE CORRIDOR-STITCH FIX

  SYMPTOM
  ┌──────────────────────────────────────────────────────────┐
  │  start exists ✓   end exists ✓   …yet "No route." ✗       │
  │  made no sense — both points were right there on the map  │
  └──────────────────────────────────────────────────────────┘
                            │  reachability probe on-device
                            ▼
  DIAGNOSIS  (the probe printed:  s=true  e=true  eReach=false)
  ┌──────────────────────────────────────────────────────────┐
  │   only tiles near the viewport had loaded:                │
  │                                                           │
  │     ┌─ component 1 ─┐        ┌─ component 2 ─┐            │
  │     │  ● start      │  GAP   │       end ●   │            │
  │     │   (loaded)    │  no    │   (loaded)    │            │
  │     └───────────────┘ streets└───────────────┘            │
  │                                                           │
  │   two DISCONNECTED graph components → A* can't cross      │
  └──────────────────────────────────────────────────────────┘
                            │  ensureBbox() in useTileGraph.ts
                            ▼
  FIX
  ┌──────────────────────────────────────────────────────────┐
  │   when both endpoints are set, fetch the WHOLE corridor   │
  │   between them in ONE Overpass + elevation build, then    │
  │   stitchGraph() welds coincident boundary nodes →         │
  │                                                           │
  │     ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●                 │
  │       start and end now in ONE connected component        │
  └──────────────────────────────────────────────────────────┘
```

The shape of that story — weird symptom, a probe that found the real cause, a fix
that's faster than the naive approach — is exactly what makes a build sound real.

## The body — the beats in order

### Beat 1 — the symptom + the probe (8:00–8:25)

Tell it like it happened. Both addresses resolved, both points were on the map,
and it still said "no route." That's the hook. Then the diagnosis: you didn't
guess, you ran a reachability probe on the device that told you the start and end
were in two disconnected pieces of the graph.

```
  SHOW (on screen)               SAY (out loud)
  ─────────────────────────      ──────────────────────────────────
  (talking head, or the bug      "The hard one: I'd type two real
   diagram on a slide)            addresses and get 'No route' — even
                                  though both points were right there.
                                  I ran a reachability probe and it
                                  said: start exists, end exists, but
                                  the end is unreachable."
```

### Beat 2 — the fix (8:25–8:45)

The cause and the fix, fast. Only the tiles near the screen had loaded, so the
two endpoints sat in separate graph components. The fix: when both endpoints are
set, load the whole bounding corridor between them in one build and stitch it into
one connected graph.

```
  SHOW (on screen)               SAY (out loud)
  ─────────────────────────      ──────────────────────────────────
  point at the two-components     "Only the streets near the screen
  → one-component panels          had loaded, so the two ends were in
                                  separate islands. The fix: load the
                                  whole corridor between them in one
                                  shot and stitch it into one graph.
                                  No route became every route."
```

```
  ┃ "Two real addresses, and still 'no route.' Turned out the
  ┃  start and the end were in two disconnected islands of the
  ┃  map — so I load the whole corridor between them and stitch
  ┃  it into one graph."
```

## Own the rough edges — say these before a judge finds them

A hackathon build is rough, and you own that with the confidence of someone who
shipped under a clock. Two honest edges, named matter-of-factly. This is strength,
not weakness — it tells the room you know exactly where the build stands.

```
  THE ROUGH EDGES — own them, don't hide them

  ┌─ coarse elevation ───────────────────────────────────────┐
  │  Grades come from a free ~90 m elevation grid. That's why │
  │  the card says "grades approximate" — real enough to bend │
  │  the route, not survey-grade. I'd rather show that than    │
  │  fake precision.                                          │
  └──────────────────────────────────────────────────────────┘

  ┌─ flat fallback when the API throttles ───────────────────┐
  │  The free Open-Meteo elevation API rate-limits. When it   │
  │  429s, I build with flat (0 m) elevation so the streets    │
  │  still render and routing still connects — then quietly    │
  │  self-heal the grades once the API recovers. Connectivity  │
  │  over fidelity, on purpose.                                │
  └──────────────────────────────────────────────────────────┘
```

You don't have to say both on stage — pick the one that fits the moment, or save
them for Q&A. The point of having them written is that nothing a judge asks
catches you flat-footed.

## Strong vs weak — story vs feature list

The contrast that makes forty-five seconds count.

```
  WEAK — the feature list             STRONG — the war story
  ─────────────────────────────       ──────────────────────────────────
  "I built address autocomplete,      "I'd type two real addresses and
   a grade heatmap, a zones            get 'No route' — both points right
   overlay, the swap button, the       there on the map. A probe showed
   max-grade presets, current-         the start and end were in two
   location, an elevation cache…"       disconnected islands of graph. So
                                       I load the whole corridor between
  → a list; nothing proves it           them and stitch it into one. That's
    was HARD; sounds like a tour         the bug I'm proudest of cracking."

                                       → one real obstacle, real diagnosis,
                                         real fix — sounds like an engineer
```

The feature list is true but flat — it proves breadth, not depth. The war story
proves you hit a real wall and got through it. Depth is what judges remember.

## IF IT BREAKS

This chapter is spoken — no live app. If a slide is up and dies, the story stands
on its own as speech.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                 ║
  ║ The bug-diagram slide won't show → tell the story with your  ║
  ║ hands: "two real addresses, still 'no route' — they were in  ║
  ║ two disconnected islands; I load the corridor between them   ║
  ║ and stitch it." The story needs no visual to land.           ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" cut

Cut Beat 1's setup and lead straight with the punchline: "two real addresses,
still 'no route' — they were in disconnected islands, so I load and stitch the
whole corridor." **Floor: you must land one genuine technical obstacle and its
fix.** If you're catastrophically over, cut this whole chapter and fold the one
line into the close — but losing the war story costs you the "this is real"
signal, so cut elsewhere first.

## The one-page run sheet

```
  ┌─ RUN SHEET — CH 4 BUILD STORY ── 8:00–8:45 (45 sec) ──────┐
  │                                                           │
  │  ONE STORY: the 'no route' bug.                           │
  │   • symptom: two real addresses → still "No route"        │
  │   • probe:   reachability check → s✓ e✓ eReach✗           │
  │   • cause:   start + end in two DISCONNECTED components    │
  │   • fix:     load whole corridor in one build → stitch     │
  │                                                           │
  │  NAIL THIS LINE:                                          │
  │   ┃ "The start and end were in two disconnected islands — │
  │   ┃  so I load the whole corridor between them and stitch │
  │   ┃  it into one graph."                                  │
  │                                                           │
  │  ROUGH EDGES (own one if asked):                          │
  │   • coarse ~90 m elevation → "grades approximate"         │
  │   • flat fallback when Open-Meteo 429s, self-heals after  │
  │                                                           │
  │  files: useTileGraph.ts (ensureBbox) · tiles.ts (stitch)  │
  │                                                           │
  │  IF IT BREAKS: tell the story as speech, no visual needed.│
  │                                                           │
  │  TIGHTEN: lead with the punchline.                        │
  │   FLOOR: land ONE real obstacle + its fix.                │
  └────────────────────────────────────────────────────────────┘
```
