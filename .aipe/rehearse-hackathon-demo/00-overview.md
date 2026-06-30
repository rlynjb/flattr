# flattr — Hackathon Demo Book (Overview)

> The run-of-show. Read this first, then the six chapters in order. You hold the
> one-page run sheets (bottom of each chapter) on stage. Coach's voice
> throughout — that's me talking to you, second person, "you."

Here's the whole thing before any detail: flattr routes you the *flattest* way
between two addresses, not the fastest, and it proves it by drawing the route
**colored by grade** — green where it's flat, red where it climbs — with a climb
number on a card. The single moment the room reacts is the route visibly
**bending around a steep red block** to stay flat while the card shows only a
small climb. That's the money shot, and it lands by 3:00. Everything else in the
ten minutes is setup for it or payoff after it.

---

## The whole slot on one timeline

This is the shape of your ten minutes. Every chapter owns a slice; the buffer at
the end is deliberate — you plan to finish early, not to use every second.

```
  flattr — THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌─────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER              0:00–1:00      │  1:00
  1:00 ├─────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)             1:00–6:00      │  5:00
       │      ★ MONEY SHOT — route bends around red ~2:45–3:00 │
       │        type two addresses → Route → colored path      │
       │        → flip the Max-grade preset → it re-routes      │
  6:00 ├─────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD (directional cost)  6:00–8:00      │  2:00
  8:00 ├─────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY (the 'no route' win) 8:00–8:45    │  0:45
  8:45 ├─────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                8:45–9:30      │  0:45
  9:30 ├─────────────────────────────────────────────────────┤
       │     buffer / breathing room            9:30–10:00     │  0:30
 10:00 └─────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs AFTER the clock stops.
                       Never eats the ten minutes.
```

The demo owns the largest share and the money shot sits in the first third —
that ordering is the whole strategy. If you're tight on time, you cut from
under-the-hood, build story, and close. You never cut the demo below the point
where the room sees the route bend.

---

## The master demo diagram — what the app does, one screen

Keep this picture in your head. It's the app in one frame, and it recurs in
Chapter 2 as your click-path. One input (two addresses + a max-grade knob); one
output (a route colored by grade with an honest climb number).

```
  flattr — ONE SCREEN, INPUT → OUTPUT

  ┌─ UI layer (Expo / React Native + MapLibre) ─────────────────┐
  │                                                             │
  │   AddressBar:  [ From: 5th & Pine        ]                  │
  │               [ To:   Summit & Madison   ]  [ Route ▸ ]     │
  │                                                             │
  │   GradeSlider (Max grade):  🛴 5%   🚶 8%   🏔️ 15%          │
  │                                                             │
  │   ┌─ the MAP ───────────────────────────────────────────┐  │
  │   │   ●━━━━━━━━━ green ━━━━━┓        ▓▓▓ steep red ▓▓▓    │  │
  │   │                        ┃        ▓▓▓  block      ▓▓▓   │  │
  │   │            route BENDS  ┗━ green ━┛  AROUND it        │  │
  │   │                                         ●            │  │
  │   └─────────────────────────────────────────────────────┘  │
  │                                                             │
  │   RouteSummaryCard:  "Flattest available · 1.4 km · +9 m   │
  │                       climb"   (grades approximate)         │
  └─────────────────────────────────────────────────────────────┘
            │
            │  one directedAstar() call per (start, end, userMax)
            ▼
  ┌─ Engine (pure TypeScript, no framework) ────────────────────┐
  │  features/routing/  graph.ts · cost.ts · astar.ts           │
  │  directional grade penalty → flat path costs less           │
  └─────────────────────────────────────────────────────────────┘
```

Everything above the line is what the room sees; everything below is what you
explain for exactly three sentences in Chapter 3, then stop.

---

## How to rehearse this book

Three passes. Do them in order — the night-before pass is the one that saves you.

```
  REHEARSAL — three passes

  PASS 1  (read + run)     Read all six chapters in order. Run the demo once,
                           end to end, with a timer. Find where you run long.

  PASS 2  (run sheets)     Run it again holding ONLY the one-page run sheets at
                           the bottom of each chapter. No script. Time it.

  NIGHT-BEFORE / MORNING   Read only the run sheets. Time the money shot — it
                           MUST land by 3:00. Do the one pre-demo warm-up below.
```

### The one pre-demo step you cannot skip — warm the elevation cache

This is the single most important operational note in the book. flattr fetches
real elevation from the free Open-Meteo API, which rate-limits (429s) under
load. The app caches every elevation sample to disk
(`mobile/src/elevCache.ts`), so **the fix is to route your demo neighborhood
once, beforehand, on the same device.** That populates the cache; on stage the
grades render from cache, instantly and real, with no live API call to throttle.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ WARM THE CACHE BEFORE YOU PRESENT                            ║
  ║ Open the app on your demo device. Type the SAME two          ║
  ║ addresses you'll use on stage. Hit Route. Let the colored    ║
  ║ route fully render (grades real, not all-green). Done — the  ║
  ║ ~90 m elevation cells are now on disk and survive restarts.  ║
  ║ Skip this and a throttled API gives you a flat (all-green)   ║
  ║ fallback and the money shot DOESN'T LAND.                    ║
  ╚══════════════════════════════════════════════════════════════╝
```

---

## Where this book sits in the study system

This book is one of three ways to turn the flattr codebase into spoken
performance. They share the codebase; they prep different rooms.

```
  .aipe/study-system-design/         UNDERSTAND it
    (audit + 6 pattern files)        comprehension — how it works, deeply

  .aipe/rehearse-interview-defense/  DEFEND it
                                     a hiring interviewer probes "why this way";
                                     you hold ground under follow-ups

  .aipe/rehearse-hackathon-demo/     SHOW it   ← you are here
    (this book)                      a room watches a clock; you land the wow
```

Cross-links you'll reach for:

- **Deeper "how does it work" answers** when a judge drills in →
  `.aipe/rehearse-interview-defense/` (the defense book answers the follow-ups
  this demo book deliberately keeps shallow).
- **The directional cost mechanism** (Chapter 3's one diagram) walked in full →
  `.aipe/study-system-design/06-parametric-search-engine.md` and
  `.aipe/study-system-design/04-honest-fallback-routing.md`.
- **The "no route → corridor stitch" win** (Chapter 4) walked in full →
  `.aipe/study-system-design/03-tile-merge-stitch.md` and
  `.aipe/study-system-design/02-on-device-pipeline-rerun.md`.

---

## Scaling to a shorter slot

Most hackathons give 3–5 minutes, not 10. If your real slot is shorter, scale
every budget proportionally but keep two things fixed: **the demo stays the
largest share, and the money shot stays inside the first third.**

```
  SLOT SCALING — keep the demo dominant, money shot in first third

  10 min  →  01:1:00  02:5:00  03:2:00  04:0:45  05:0:45  (money shot ~2:45)
   5 min  →  01:0:30  02:3:00  03:0:45  04:0:20  05:0:25  (money shot ~1:30)
   3 min  →  01:0:20  02:2:00  03:cut   04:cut   05:0:20  (money shot ~0:55)

  Tightest cut order: under-the-hood → build story → close.
  Never cut: the room seeing the route bend around the red block.
```

Now go to Chapter 1.
