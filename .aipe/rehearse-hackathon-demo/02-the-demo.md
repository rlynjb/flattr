# Chapter 2 — The demo (1:00–6:00)

This is the chapter that wins or loses the slot. Five minutes, the biggest budget in the book, and one job: make the room *see* flat-first routing happen, then react. The money shot — a route that visibly avoids a steep block and reports its climb — has to land by 3:00, inside the first third. Everything before it is setup that earns the moment; everything after is you riding the momentum into the knob and the heatmap.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────── 6:00 ─────────────────────────10:00 │
  │     THE DEMO — you own 1:00 to 6:00 (5 min)           │
  │     ★ money shot by 3:00                               │
  └──────────────────────────────────────────────────────┘
```

The click-path is choreographed so the wow comes early and the rest is gravy.

```
  THE CLICK-PATH — screens in order, money shot marked

  [1] map open, your neighborhood        ~1:00
        │  "From" = current location (◎)
        ▼
  [2] type a destination across a hill   ~1:30
        │  autocomplete suggests it, tap it
        ▼
  [3] hit Route                          ~2:30
        │  a line draws, colored green→red by grade
        ▼
  [4] ★ MONEY SHOT                        ~3:00
        │  the route HUGS flat streets, detours the
        │  red hill; card reads "+9 m climb"
        ▼
  [5] drag Max-grade knob (🛴 → 🏔️)        ~4:00
        │  route RE-ROUTES — stricter = flatter detour
        ▼
  [6] toggle the grade HEATMAP            ~5:00
        │  whole area lights green→red: the terrain itself
```

Steps 1–3 set it up; step 4 is the moment; steps 5–6 prove it's a real system, not a single canned path.

## Beats 1–3 — set up the money shot

The setup has to be fast and value-narrated. Your hands type and click; your mouth talks about *what it means*, never about the clicks themselves.

```
  SAY (out loud)                        SHOW (on screen)
  ──────────────────────────────        ──────────────────────────────
  "I'll start from where I am…"         tap ◎ — From = current location
  "…and go somewhere on the other       type the destination; tap the
   side of a hill."                       autocomplete suggestion
  "Most routers would send me           hit Route — line starts drawing
   straight over it. Watch what
   flattr does instead."
```

That last SAY line is the *setup for the wow* — you've told the room what to watch for right before it happens. Do not say "now I'm clicking Route." Say what's about to matter.

## Beat 4 — the money shot (by 3:00)

This is the moment. The route finishes drawing, and it visibly bends around the steep (red) block to stay on green streets, and the card shows a small climb number.

┃ "There it is — it didn't go over the hill, it went *around* it. Nine meters of climb instead of forty."

```
  SAY (out loud)                        SHOW (on screen)
  ──────────────────────────────        ──────────────────────────────
  [pause — let them see it]             the green route line, curving
                                          around the red segment
  "It didn't go over the hill —         point at the detour, then at
   it went around it."                    the summary card
  "Nine meters of climb instead         the card: "Flat all the way ·
   of forty. That's the whole app."       2.1 km · +9 m climb"
```

The pause matters. Let the room read the picture for a beat before you narrate it. The wow is *visual* — a path bending around red — so give their eyes the half-second to catch it.

| WEAK DEMO MOVE | STRONG DEMO MOVE |
|---|---|
| Explain the A\* algorithm and the cost function, *then* run a route. | Run the route, let them see it dodge the hill, *then* — only if asked — explain how. Show first, explain never (unless they pull). |
| **Why it's weak:** you spend your best minutes on mechanism the room can't see yet, and the visual wow lands late and flat. | **Why it works:** the picture does the persuading; the explanation is held for under-the-hood or Q&A, where it's earned. |

## Beats 5–6 — prove it's a system

Momentum's high; now show it's not one canned path.

```
  SAY (out loud)                        SHOW (on screen)
  ──────────────────────────────        ──────────────────────────────
  "It's one knob — how much hill        drag Max-grade preset 🛴→🏔️;
   you'll tolerate."                       the route RE-ROUTES live
  "Stricter, and it works harder         stricter preset → a flatter,
   to keep you flat."                      longer detour appears
  "And here's the terrain itself —       toggle the heatmap: streets
   green is easy, red is the climbs."      light up green→red across the area
```

┃ "One knob — how much hill you'll put up with — and it re-routes around the rest."

╔══════════════════════════════════════════════════════╗
║ IF IT BREAKS                                           ║
║ Route won't draw, or grades show flat/green (the free  ║
║ elevation API is throttled) → switch to the recorded   ║
║ clip of the same route. Line: "The elevation API is    ║
║ rate-limiting live — here's the same route from my     ║
║ cached run." Keep the energy up; do NOT debug on        ║
║ stage. PREVENT this: route this exact neighborhood      ║
║ before you present so the elevation is cached real.     ║
╚══════════════════════════════════════════════════════╝

## Tighten it

Running long? Cut beat 6 (the heatmap toggle) first — it's the "system proof," nice but not the wow. Then cut beat 5 (the knob). **Floor you must not cut below:** beats 1–4 — the room *must* see a route draw and dodge a hill. That's the demo; everything else is supporting evidence.

## One-page run sheet

- **Budget:** 1:00–6:00. **★ Money shot by 3:00:** route bends around the red hill, card shows "+9 m climb."
- **SAY, in order:** "start where I am" → "go across a hill" → "watch what flattr does" → *[pause]* "it went around it — 9 m instead of 40" → "one knob, how much hill" → "here's the terrain."
- **Nail this line:** ┃ "It didn't go over the hill — it went around it. Nine meters of climb instead of forty."
- **SHOW path:** ◎ current location → type/tap destination → Route → *[the detour]* → drag knob, re-route → heatmap toggle.
- **If it breaks:** cut to recorded clip ("API is rate-limiting live"); pre-warm the cache to avoid it.
- **Tighten:** drop heatmap, then knob. Floor: a route must draw and dodge a hill.
