# Chapter 4 — The build story (8:00–8:45)

Forty-five seconds to prove this is a real build, not a mockup, and to show you hit a genuine wall and got through it. Judges have watched a dozen demos that were front-ends over nothing; the build story is where you separate from those. The move is one concrete "this actually works" claim and one real hard part — told fast, owned honestly, rough edges and all.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░ │
  │ 8:00 ──────── 8:45 ──────────────────────────── 10:00 │
  │     BUILD STORY — you own 8:00 to 8:45 (45 sec)       │
  └──────────────────────────────────────────────────────┘
```

One real obstacle, told as a story with a turn — that's what forty-five seconds buys you.

```
  THE HARD PART — a story with a turn

  SYMPTOM     "distant routes returned 'no route' —
              even though both points were clearly on the map"
        │
        ▼
  THE MOVE    didn't guess. added a reachability probe:
              BFS from the start, is the end even reachable?
        │
        ▼
  THE CAUSE   it wasn't — they were in two DISCONNECTED islands.
              the map only loaded tiles near the screen, so far-apart
              points had no loaded streets between them.
        │
        ▼
  THE FIX     load and stitch the corridor between the two points,
              so they share one connected graph. routes worked.
```

That arc — symptom, the disciplined move, the real cause, the fix — is a debugging story a judge believes, because it's specific and it's yours.

## What actually shipped (proof it's real)

```
  SAY (out loud)                        SHOW (on screen, optional)
  ──────────────────────────────        ──────────────────────────────
  "This is a real engine, not a          (gesture back at the running app)
   mockup — I hand-rolled the A*,
   the heap, the whole search."
  "It's tested too — the router is        (optional: flash the test run /
   checked against a slower correct        green checkmarks)
   algorithm, so I know the routes
   are optimal, not just plausible."
```

The "tested against a slower correct algorithm" line is your credibility ace — it's the optimality oracle, and most hackathon builds have no correctness story at all.

## The hard part (the turn)

┃ "Distant routes kept failing — and instead of guessing, I added a probe that asked 'is the destination even reachable?' It wasn't: the map was loading in disconnected islands."

```
  SAY (out loud)
  ──────────────────────────────────────────────
  "The hardest bug: routes between far-apart points
   failed, even though both existed. I added a
   reachability check — turned out they were in two
   disconnected pieces of the graph, because I only
   loaded streets near the screen. Fix was to load
   the corridor between them. The lesson was to
   instrument before guessing."
```

## Own the rough edges

Don't pretend it's production. Name a rough edge with the confidence of someone who shipped under a clock:

┃ "It's one neighborhood, the elevation data is coarse, and the grades fall back to flat when the free API rate-limits — I mark those honestly rather than fake them."

That sentence is *stronger* than claiming polish, because it shows judgment about what's real.

╔══════════════════════════════════════════════════════╗
║ IF IT BREAKS                                           ║
║ No screen needed here — this beat is spoken. If you    ║
║ wanted to flash the test suite and it won't run, just  ║
║ say it: "the router's tested against a reference        ║
║ algorithm for optimality." The claim carries without   ║
║ the green checkmarks.                                  ║
╚══════════════════════════════════════════════════════╝

## Tighten it

Cut to ONE sentence: the hard part only. "The hardest bug was distant routes failing — I probed and found the graph was loading in disconnected islands, and fixed it by stitching the corridor between endpoints." Drop the shipped-proof and rough-edges lines. **Floor:** tell one real, specific obstacle — a vague "it was hard" proves nothing.

## One-page run sheet

- **Budget:** 8:00–8:45 (45 sec). No money shot.
- **SAY, in order:** "real engine, hand-rolled A\*/heap" → "tested against a slower correct algorithm = optimal" → the hard part (reachability probe → disconnected islands → stitch the corridor) → own a rough edge (neighborhood, coarse elevation, honest flat fallback).
- **Nail this line:** ┃ "Instead of guessing, I added a probe that asked 'is the destination even reachable?' It wasn't — the map was loading in disconnected islands."
- **SHOW:** optional gesture at the running app / test run; this beat is mostly spoken.
- **If it breaks:** all spoken — no screen required.
- **Tighten:** the hard part only. Floor: one specific real obstacle.
