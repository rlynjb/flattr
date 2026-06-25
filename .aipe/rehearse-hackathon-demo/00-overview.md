# Hackathon Demo — flattr (10-minute run-of-show)

This is the script for showing flattr to a room with a clock running. Not defending it under one-on-one follow-ups (that's the interview-defense book) — *showing* it, landing the wow inside ten minutes, and getting off stage on a beat. The organizing rule of this whole book: the demo is the centerpiece, the money shot lands in the first third, and every other beat has a ceiling it must not exceed.

Default slot is ten minutes (scale every budget proportionally if your real slot is shorter — but the demo always keeps the biggest share and the money shot always lands by the one-third mark). The money shot for flattr is concrete and true: **type two addresses, hit Route, and a path draws that visibly hugs the flat streets and reports its climb — the room sees "routing for flat" actually happen.**

```
  THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌───────────────────────────────────────────────┐
       │ 01 COLD OPEN + ONE-LINER            0:00–1:00  │ 1:00
  1:00 ├───────────────────────────────────────────────┤
       │ 02 THE DEMO (centerpiece)           1:00–6:00  │ 5:00
       │     ★ MONEY SHOT by 3:00: flat route + climb    │
  6:00 ├───────────────────────────────────────────────┤
       │ 03 UNDER THE HOOD (one diagram)     6:00–8:00  │ 2:00
  8:00 ├───────────────────────────────────────────────┤
       │ 04 THE BUILD STORY                  8:00–8:45  │ 0:45
  8:45 ├───────────────────────────────────────────────┤
       │ 05 THE CLOSE + THE ASK              8:45–9:30  │ 0:45
  9:30 ├───────────────────────────────────────────────┤
       │    buffer / breathing room          9:30–10:00 │ 0:30
 10:00 └───────────────────────────────────────────────┘
       06 THE Q&A  ← prep only, runs after the clock
```

That timeline is the contract. Half the battle is finishing at 9:30 with breathing room instead of getting buzzed mid-sentence at 10:01.

## The master demo picture

The one-screen mental model of what the app does, which recurs in the demo chapter:

```
  flattr — what the room sees

   [ From: my location  ][ To: type an address ][ Route ]
   ┌─────────────────────────────────────────────────┐
   │   MAP (MapLibre)                                  │
   │     • blue start pin   ● black destination pin    │
   │     ━━ route line, COLORED by grade:              │
   │        green = flat/easy  →  red = steep          │
   │     (optional) grade HEATMAP toggle: whole-area    │
   │        terrain, green→red                          │
   └─────────────────────────────────────────────────┘
   [ "Flat all the way · 2.1 km · +9 m climb" ]  ← the honesty card
   [ Max grade:  🛴  🚶  🏔️ ]  ← one knob, three presets
```

## The six chapters

| Chapter | Beat | Budget |
|---------|------|--------|
| `01-the-cold-open.md` | Hook + one-liner — start in motion | 0:00–1:00 |
| `02-the-demo.md` | The live route, the money shot, the knob | 1:00–6:00 |
| `03-under-the-hood.md` | One diagram: directional A\* over an elevation graph | 6:00–8:00 |
| `04-the-build-story.md` | What shipped + the hard part (the "no route" bug) | 8:00–8:45 |
| `05-the-close.md` | Where it goes, the ask, the last line | 8:45–9:30 |
| `06-the-qa.md` | Judge questions (prep, post-clock) | after |

## How to rehearse

First pass: read the chapters in order and run the demo once end-to-end with a timer. Second pass: run it again holding only the one-page run sheets. Morning-of: read only the run sheets and time the money shot — it must land by 3:00.

**One critical pre-demo step, because of a real constraint:** flattr's elevation comes from a free API that rate-limits, and a throttled run shows flat/approximate grades. **Route your exact demo neighborhood before you go on stage** so the elevation is cached real and the colors are vivid and instant. The IF-IT-BREAKS boxes cover the live failure, but pre-warming the cache is how you avoid needing them.

This book shows the project; the interview-defense book (`.aipe/rehearse-interview-defense/`) answers the "how does it actually work" questions that come after, and the concept files handle the deepest follow-ups.
