# flattr — Hackathon Demo Book (Overview & Run-of-Show)

You built a router that optimizes for **flat, not fast**. Type two
addresses, hit Route, and a line draws across the map colored by grade —
green where it's flat, red where it climbs — with one honest number on a
card: how much you'll actually go uphill. The whole pitch fits in one
sentence and one screen. This book choreographs the ten minutes around
that, and it points at the single moment the room reacts: **the route
visibly bending around a steep red block to keep you on the flat.**

This is the coach talking, not a narrator. I've watched a hundred of these.
The demos that win open in motion and land the wow before minute three. The
demos that lose spend ninety seconds on a title slide and bury the magic at
minute eight. Everything below is built to keep you in the first camp.

---

## The whole slot on one timeline

This is the shape of your ten minutes. Read it left to right — every chapter
owns a slice, the money shot is pinned inside the first third, and you plan
to finish at 9:30 with breathing room, never at 10:00 on the buzzer.

```
  flattr — THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                0:00–1:00  │ 1:00
       │       open on the map, not a slide                  │
  1:00 ├────────────────────────────────────────────────────┤
       │ 02  THE DEMO  (centerpiece, largest budget)         │
       │       1:00  type two addresses → Route              │
       │       2:30  ★ MONEY SHOT ★  route bows AROUND       │ 5:00
       │             the red block; card shows a small climb │
       │       4:00  Max-grade knob re-routes live           │
       │       5:00  grade heatmap toggle                    │
  6:00 ├────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD   one diagram, three sentences   │ 2:00
       │       A→B ≠ B→A : directional grade cost            │
  8:00 ├────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY   the "no route" debugging win  │ 0:45
  8:45 ├────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK   last line they repeat     │ 0:45
  9:30 ├────────────────────────────────────────────────────┤
       │     buffer / breathing room              9:30–10:00 │ 0:30
 10:00 └────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only. Runs AFTER the clock.
                      Never eats the ten minutes.
```

The money shot lands at **~2:30 — comfortably inside the first third.** If
you take nothing else from this book, take that: the bend-around-the-hill
moment is non-negotiable and it happens early.

**Scaling to a shorter slot.** If your hackathon gives you 5 minutes, halve
everything *except* the demo — it keeps the lion's share. The 5-minute
split: cold open 0:30, demo 0:30–3:00 (money shot still at ~1:30), under-the-
hood 3:00–4:00, build story + close folded into 4:00–4:45. The rule never
changes: the demo has a floor, everything else has a ceiling, and the money
shot lands in the first third.

---

## The master demo diagram — what the app does, one screen

This is the picture you're selling. Everything in chapter 02 happens on this
one screen; come back here whenever you need to re-anchor on what the room
is looking at.

```
  flattr — ONE SCREEN, THE WHOLE PRODUCT

  ┌───────────────────────────────────────────────┐
  │  From: [ 24th Ave E & E Galer ........ ]       │  ← address bar
  │  To:   [ Volunteer Park ............. ] [Route]│    (AddressBar.tsx)
  ├───────────────────────────────────────────────┤
  │                                                 │
  │            ░░░░░░  RED steep block  ░░░░░░       │  the hill
  │          ╔══════════════════════════╗           │  routing avoids
  │   start  ║   ▓▓▓ +12% uphill ▓▓▓    ║   end     │
  │    ●─────╜   (router refuses this)   ╙────●      │
  │     \                                  /        │
  │      green ───── route bows AROUND ──── green   │  ← the route line,
  │            the red block to stay flat           │    colored by grade
  │                                                 │
  │  ┌─────────────────────────────────┐  Max grade │
  │  │ Flat all the way                │   🛴 5%     │  ← Max-grade knob
  │  │ 1.40 km · +9 m climb            │   🚶 8%     │    (GradeSlider.tsx)
  │  └─────────────────────────────────┘   🏔 15%    │
  │   ↑ RouteSummaryCard.tsx — the honest number     │
  │                                                 │
  │  [ Off ] [ Grades ] [ Zones ]  ← heatmap toggle  │
  └───────────────────────────────────────────────┘
```

The line is green→red by grade. The card says `+9 m climb` instead of the
straight-line route's much bigger number. The knob (🛴/🚶/🏔) re-routes
live. That's the product — and the bend around the red block is the proof.

---

## How to rehearse this book

Three passes. Do not skip the timer — going long is the single most common
way these demos die.

```
  REHEARSAL — three passes, each tighter

  ┌─ PASS 1 ───────────────────────────────────────┐
  │ Read all 7 chapters in order, once.            │
  │ Then run the demo end-to-end ONCE with a timer. │
  │ Goal: find where you run long. (It's the demo.) │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ PASS 2 ──────────────▼─────────────────────────┐
  │ Run it again holding ONLY the one-page run sheets│
  │ (the last section of each chapter). No script.   │
  │ Goal: the money shot lands by 2:30 on the clock. │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ NIGHT BEFORE / MORNING OF ─────────────────────┐
  │ Read only the run sheets. Time the money shot.   │
  │ Pre-warm the demo neighborhood (see below).      │
  └──────────────────────────────────────────────────┘
```

### CRITICAL pre-demo step — warm the elevation cache

flattr fetches elevation from the free **Open-Meteo API, which rate-limits**.
Cold, it 429s and the app falls back to flat (0 m) grades — your route draws
all-green and the money shot dies, because there's no red block to bend
around. The fix is one minute of prep, the night before AND again the morning
of:

```
  ┌──────────────────────────────────────────────────────────┐
  │  PRE-WARM (do this before you present, on demo wifi)      │
  │  1. Open the app on the exact demo phone + network.        │
  │  2. Route your demo From → To once. Toggle Grades on.      │
  │  3. Pan the demo neighborhood so the corridor loads.       │
  │  4. Confirm you see RED edges (real grades, not all-green).│
  │     The elevation cache now persists to disk (elevCache.ts)│
  │     and survives restarts — grades render instantly + real.│
  └──────────────────────────────────────────────────────────┘
```

If you skip this and the API throttles you live, the route summary shows
*"Grades approximate — elevation unavailable, retrying"* and the line goes
flat-green. That's the honest fallback working as designed — but it's not the
demo you want the room to see. Warm the cache.

---

## Where this book sits in the study system

This book helps you **show** the work in a room watching a clock. Two
siblings help with the other rooms:

- **`.aipe/rehearse-interview-defense/`** — the interview-defense book
  answers the "how does it actually work / why this way" follow-ups that come
  *after* the demo (admissible heuristic, lazy-deletion PQueue, BLOCKED vs
  Infinity). When a judge drills deeper than chapter 03 goes, that's the
  book. Cross-linked from chapters 03, 04, and 06.
- **`.aipe/study-system-design/`** — the comprehension guides. Deepest
  follow-ups live here:
  `04-honest-fallback-routing.md` (no-route vs no-flat-route, the chapter-04
  debugging story), `05-elevation-provider-fallback.md` (the flat fallback +
  cache, the chapter-06 honesty answer), `03-tile-merge-stitch.md` (the
  corridor/stitch mechanics behind chapter 04's "no route" win).

Read this book to present flattr. Reach for those two when the room wants to
go deeper than ten minutes allows.

---

## The chapter list (the contract)

```
  00-overview.md          ← you are here: the run-of-show
  01-the-cold-open.md     ← first 60s: hook + one-liner
  02-the-demo.md          ← centerpiece + the money shot (≤2:30)
  03-under-the-hood.md    ← one diagram: A→B ≠ B→A
  04-the-build-story.md   ← the "no route" debugging win + rough edges
  05-the-close.md         ← vision, ask, last line
  06-the-qa.md            ← judge questions (prep, post-clock)
```

Now go to chapter 01 and open in motion.
