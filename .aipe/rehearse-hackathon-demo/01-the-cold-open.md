# Chapter 1 — The Cold Open + One-Liner   (0:00–1:00, 1 min)

## Opening hook

You have sixty seconds and the room decides inside the first fifteen whether
this is worth their attention. So you do not open on a title slide, you do not
say your name, you do not explain what a "grade" is. You open on the *sting* —
the problem everyone in the room has felt — and then you say one sentence that
tells them exactly what flattr is. The phone is already on the screen, app open,
addresses already typed in but not yet routed. The whole minute is a loaded
spring; Chapter 2 releases it.

The failure mode I've watched kill this minute a hundred times: the presenter
spends it on setup the room doesn't need yet. "So, maps use something called
elevation data, and there's this API…" — gone, you've lost them. Start in
motion.

## The time-budget bar

You own the first minute. By 1:00 the room knows the problem and the one-liner,
and your finger is on the Route button.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ── 1:00 ───────────────────────────────────── 10:00 │
  │        COLD OPEN — you own 0:00 to 1:00 (1 min)           │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the attention curve

This is what you're managing in the cold open: the room's attention. It's
highest at second zero and decays fast unless you give it something to hold. The
sting holds it; the one-liner converts it into "okay, show me."

```
  THE ROOM'S ATTENTION — first 60 seconds

  high │█
       │█▓                        ← if you open on a title slide,
       │█▓▓░                        attention free-falls here and
       │█▓▓░░░░░░  ........          you spend the demo clawing it back
       │
  ─────┼──────────────────────────────────────────────►  time
       │█                          ← if you open on the STING:
       │█▓▓▓▒▒▒▒▒▒▓▓▓███           attention dips, then the one-liner
       │█▓▓▓▒▒▒    ▓▓███            re-spikes it into "show me"
       │
       0:00      0:20      0:40      1:00
              sting      one-liner   finger on Route
```

The shape you want is the bottom curve: a dip after the sting, then a re-spike
on the one-liner that carries straight into the demo. The top curve is what a
title slide buys you.

## The body — the two beats

### Beat 1 — the sting (0:00–0:25)

Open on a shared, physical frustration: the bike/scooter/walk route that *looked*
fine on a normal map and turned out to be a wall of hill. No map app optimizes
for that — they all optimize for fastest, which routes you straight up the steep
street because it's shorter.

```
  SHOW (on screen)               SAY (out loud)
  ─────────────────────────      ──────────────────────────────────
  phone up, flattr open,         "Every map app routes you the
  two addresses already in        FASTEST way. On a bike or a
  the AddressBar, NOT routed      scooter or your own two legs,
  yet                             fastest means straight up the
                                  steepest hill — and nobody wants
                                  that."
```

### Beat 2 — the one-liner (0:25–1:00)

Now the sentence that defines the product. The shape is "X is a Y that does Z
for W." Say it once, cleanly, then move your finger to Route. Do not elaborate —
the demo is the elaboration.

```
  SHOW (on screen)               SAY (out loud)
  ─────────────────────────      ──────────────────────────────────
  finger moves to the            "flattr routes you the FLATTEST
  [ Route ▸ ] button             way, not the fastest. Two
                                  addresses, one tap — and it draws
                                  the route colored by how steep it
                                  is. Watch."
```

That last word — "Watch." — is the handoff. It's the verbal trigger that starts
Chapter 2. Say it and tap.

### The script lines — say these close to verbatim

```
  ┃ "Every map app routes you the fastest way. On a bike, fastest
  ┃  means straight up the steepest hill — and nobody wants that."
```

```
  ┃ "flattr routes you the flattest way, not the fastest. Two
  ┃  addresses, one tap, and it draws the route colored by how
  ┃  steep it is. Watch."
```

## Strong vs weak — how to open

The contrast that matters most in this chapter. One of these opens cold with the
problem; the other apologizes its way in.

```
  WEAK open                          STRONG open
  ─────────────────────────────      ──────────────────────────────────
  "Hi, I'm Rein, this is flattr,     phone already up, app open:
   a grade-aware routing app I       "Every map app routes you the
   built this weekend using Expo,     fastest way — straight up the
   React Native, MapLibre, and a      steepest hill. flattr routes
   hand-rolled A* router over a       you the flattest. Watch."
   street graph. Let me explain
   the elevation pipeline first."     → in motion, room leaning in,
                                        stack named LATER (Q&A)
  → 40 seconds of stack the room
    can't use yet; attention gone
```

The weak open isn't wrong — every fact in it is true. It's just *out of order*.
The stack belongs in the Q&A (Chapter 6), not in your first forty seconds.

## IF IT BREAKS

The cold open has no live action yet — the route hasn't fired — so the only risk
is the app not being open or the screen not mirroring. Handle it in one breath
and keep talking; the sting works as pure speech.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                 ║
  ║ Screen mirror drops / app not foregrounded → keep delivering ║
  ║ the sting and one-liner as pure speech (they need no visual).║
  ║ Say: "let me get the screen back — meanwhile, here's the     ║
  ║ idea" and continue. Re-open the app while you talk. Never    ║
  ║ stop to fix it in silence.                                    ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" cut

If you're already behind before you start (the slot slipped), drop the sting's
elaboration and lead straight with the one-liner over the live screen. **Floor:
you must still say the one-liner and reach the Route tap by 1:00.** Never cut the
one-liner itself — the room needs the "X is a Y that does Z" frame before the
demo or the colors mean nothing.

## The one-page run sheet

```
  ┌─ RUN SHEET — CH 1 COLD OPEN ── 0:00–1:00 (1 min) ──────────┐
  │                                                            │
  │  SAY, in order:                                            │
  │   • "Every map app routes you the fastest way…"            │
  │   • "…on a bike, fastest means straight up the hill."      │
  │   • "flattr routes you the flattest, not the fastest."     │
  │   • "Two addresses, one tap, colored by steepness. Watch." │
  │                                                            │
  │  NAIL THIS LINE:                                           │
  │   ┃ "flattr routes you the flattest way, not the fastest." │
  │                                                            │
  │  SHOW: app open, 2 addresses typed, finger → Route ▸       │
  │                                                            │
  │  IF IT BREAKS: deliver sting+one-liner as pure speech,     │
  │   re-open app while talking, never stop in silence.        │
  │                                                            │
  │  TIGHTEN: drop sting elaboration, lead with one-liner.     │
  │   FLOOR: say the one-liner + reach Route tap by 1:00.      │
  └────────────────────────────────────────────────────────────┘
```
