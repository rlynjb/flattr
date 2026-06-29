# Chapter 2 — The Demo   (1:00–6:00, 5 minutes)

## Opening hook

This is the chapter that wins or loses the demo. It gets the biggest budget,
it carries the money shot, and it's the only part the room actually
remembers. Everything before it was setup; everything after it is footnotes.
You have five minutes and the room is watching the screen, not you — so the
rule for this whole chapter is: **let the app do the talking, and speak value
while your hands click.** Never narrate the clicks.

The single most important timing in this entire book: the money shot — the
route bending *around* the steep red block to stay flat — lands at **~2:30**,
inside the first third of the slot. You do not save it. You do not build up to
it. You get there fast, you let the room react, and then everything else in
the demo is a victory lap on a room that already believes you.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ───────────────── 6:00 ───────────────────────── 10:00│
  │   THE DEMO — you own 1:00 to 6:00 (5 min)                  │
  │   ★ MONEY SHOT at ~2:30 — route bows around the red block  │
  └──────────────────────────────────────────────────────────┘
```

Five minutes, money shot at 2:30, then knob + heatmap as the victory lap.

## The chapter-opening diagram — the click-path

This is the exact path through the running app. Four beats, in order, with the
money shot fixed at beat 2. Rehearse this until your hands do it without you.

```
  THE CLICK-PATH — four beats, money shot at beat 2

  BEAT 1 (1:00–2:00)            BEAT 2 (2:00–3:00) ★ MONEY SHOT
  ┌────────────────────┐       ┌──────────────────────────────┐
  │ type From + To      │       │ route DRAWS, colored by grade │
  │ tap [Route]         │  ──►  │ it BOWS AROUND the red block  │
  │ AddressBar.tsx      │       │ card: "Flat all the way        │
  │ → geocode → corridor│       │  1.40 km · +9 m climb"         │
  │   loads → directedAstar      │ RouteSummaryCard.tsx          │
  └────────────────────┘       └───────────────┬──────────────┘
                                                │
  BEAT 4 (4:30–5:30)            BEAT 3 (3:00–4:30)
  ┌────────────────────┐       ┌──────────────▼───────────────┐
  │ toggle [Grades] on  │       │ tap Max-grade knob 🚶→🏔       │
  │ whole-area heatmap   │  ◄──  │ route RE-ROUTES live          │
  │ greens & reds bloom  │       │ now allows the steeper hill   │
  │ graphToGeoJSON       │       │ → shorter, but card climb ↑   │
  │ → "grades approx" card│      │ GradeSlider.tsx → re-run A*   │
  └────────────────────┘       └──────────────────────────────┘
```

Beats 1 and 2 are the demo. Beats 3 and 4 are proof it's a real system, not a
single hardcoded route. Now walk them.

## The body — the beats in order

### Beat 1 — type two addresses, hit Route (1:00–2:00)

Your hands are already moving from the cold-open handoff. You type a From and
a To you have rehearsed and pre-warmed (see the overview's pre-warm box), and
you tap Route. While the geocode + corridor load runs, you talk value — you do
*not* say "now I'm typing the address."

```
  SHOW (on screen)              SAY (out loud)
  ──────────────────────        ─────────────────────────────
  type From: a corner on        "Two addresses — same as any
  one side of a known hill       maps app. Here's a start, here's
                                 where I want to go."
  ──────────────────────        ─────────────────────────────
  type To: a corner on the      "The straight line between these
  far side of that hill          two runs right over a steep
                                 hill. Watch what flattr does
                                 with that."
  ──────────────────────        ─────────────────────────────
  tap [Route]; brief load        "It's pulling real street + real
                                 elevation data for this corridor
                                 right now — this isn't canned."
```

That last line is doing quiet work: it tells the room the data is live before
anyone can wonder. You've pre-warmed the cache so this load is fast.

```
┃ "The straight line runs right over a steep hill. Watch
┃  what flattr does with that."
```

### Beat 2 — THE MONEY SHOT (2:00–3:00): the route bows around the hill

This is it. The route line draws across the map, colored green→red by grade,
and it visibly **bends away from the steep red block** to stay on the flat —
and the card shows a *small* climb number. This is the moment the room goes
"oh." Say the one line, then **stop talking** and let them look.

```
  SHOW (on screen)              SAY (out loud)
  ──────────────────────        ─────────────────────────────
  the route line draws,         "There — see how the route
  GREEN, and it curves           doesn't go straight? It just
  AROUND the red steep block,    bent around the hill."
  not over it
  ──────────────────────        ─────────────────────────────
  the card appears:             "Flat all the way. Plus nine
  "Flat all the way              meters of climb — the straight
   1.40 km · +9 m climb"         route would've been thirty-plus.
                                 It chose the flat way."       ← MONEY SHOT
  ──────────────────────        ─────────────────────────────
  (you say nothing for          (let the room look. two seconds
   ~2 seconds)                   of silence here is worth more
                                 than any sentence.)
```

The number is the proof. The bend is the picture. Together they're the whole
pitch in one screen. The `+9 m climb` comes from `routeSummary` in
`features/routing/summary.ts` — it sums only the *uphill* directed rise along
the path, which is exactly the number a person with a stroller cares about.

```
┃ "It bent around the hill to keep you flat — nine meters
┃  of climb instead of thirty. That's the whole product."
```

**Money-shot timing is fixed at ~2:30.** If beat 1 ran long, cut your value
patter, not the money shot. The room must see the bend inside the first third.

### Beat 3 — the Max-grade knob re-routes live (3:00–4:30)

Now prove it's a real system that responds to the user, not one frozen route.
Tap the Max-grade knob from Walking (🚶 8%) up to Any (🏔 15%) and the route
recomputes in front of them — now it's *allowed* to take the steeper hill, so
it picks a shorter line and the climb number goes *up*. That live recompute is
the "this is a real engine" beat.

```
  SHOW (on screen)              SAY (out loud)
  ──────────────────────        ─────────────────────────────
  tap 🚶 8% → 🏔 15% on the      "This knob is how steep you're
  Max-grade panel                willing to go. Right now it's
                                 set for walking."
  ──────────────────────        ─────────────────────────────
  the route INSTANTLY            "Bump it to 'anything' — and the
  recomputes: now a shorter,     route changes. Now it's willing
  steeper line; card climb ↑      to take the hill, so it's
                                 shorter — but look, the climb
                                 number jumped."
  ──────────────────────        ─────────────────────────────
  tap back to 🛴 5%             "Drop it to a kick-scooter and it
  route re-routes flatter        gets even more careful. One knob,
                                 the whole route re-thinks itself."
```

Every tap re-runs `directedAstar` against the new `userMax` — same engine,
different constraint, live. There's no slider math to fake; the cost function
just gets a new ceiling and the search finds a new optimum.

```
┃ "One knob — kick-scooter to mountain-goat — and the whole
┃  route re-thinks itself live."
```

### Beat 4 — the grade heatmap toggle (4:30–5:30)

The victory lap. Toggle `[Grades]` on and the *whole neighborhood* colors
itself green-to-red by steepness — so the room sees the terrain the router was
reasoning over the whole time. This is also where you get to be honest, which
plays *better* than pretending: tap into a fresh area and the card may say
"grades approximate."

```
  SHOW (on screen)              SAY (out loud)
  ──────────────────────        ─────────────────────────────
  tap [Grades] toggle           "And here's what the router sees.
  whole-area heatmap blooms:     Every street, colored by how
  greens flat, reds steep        steep it is — green flat, red
                                 brutal."
  ──────────────────────        ─────────────────────────────
  point at the red cluster      "See that red ridge? That's the
  the route avoided              block the route refused to climb.
                                 Now you can see why it bent."
  ──────────────────────        ─────────────────────────────
  (optional) [Zones] toggle     "And zoomed out — a coarse terrain
  coarse grid overlay            view, so you can read a whole
                                 neighborhood's hills at a glance."
```

The heatmap closes the loop: the bend in beat 2 now has a visible reason. That
red ridge is *why* the route bowed.

```
┃ "Green is flat, red is brutal. That red ridge is exactly
┃  what the route refused to climb."
```

### Strong vs weak — the demo move that decides it

The contrast that separates a demo that lands from one that doesn't:

```
  WEAK demo move                   STRONG demo move
  ───────────────────────────      ───────────────────────────
  "Now I'm clicking Route, and     "Watch the route." (clicks)
   this calls directedAstar with   → silence → "It bent around
   the userMax param, which then    the hill. Nine meters of
   runs the cost function..."        climb." → let them react
  → narrating clicks +             → SAY value, SHOW the thing,
    architecture mid-demo            explain only if asked
  → room watches you talk          → room watches it WORK

  Bury the money shot at 4:00      Money shot at 2:30, then
  after a feature tour             victory-lap the rest
```

The weak column is the trap engineers fall into — explaining the mechanism
while the magic is happening on screen. Save the mechanism for chapter 03.
During the demo, speak outcomes.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the route won't draw / draws all-green / 429   ║
║                                                                ║
║ A) Route won't load (geocode or Overpass timed out):          ║
║    switch to the 20-second recorded clip (slide 2). Say:       ║
║    "Here's a run from earlier — same thing." Narrate the bend  ║
║    and the +9 m climb over the clip. Keep the energy up.       ║
║                                                                ║
║ B) Route draws ALL-GREEN (elevation API throttled → flat      ║
║    fallback): DON'T panic — point at the card: "Grades         ║
║    approximate — that's the app being honest the elevation     ║
║    feed is rate-limited right now." Then cut to the recorded   ║
║    clip for the real bend. (This is why you pre-warm the cache.)║
║                                                                ║
║ Never freeze. Never apologize twice. Keep moving to the knob.  ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

**Cut, in this order when running long:** first beat 4 (the heatmap toggle) —
mention it in one sentence instead of demoing it. Then beat 3's "back to
kick-scooter" sub-tap — show the knob once, not twice.
**Floor:** beats 1 and 2. The room MUST see the route bend around the hill and
read the small climb number. That is the demo. Everything else is optional;
the money shot is not.

## The one-page run sheet

```
  ┌─ CH 02 · THE DEMO · 1:00–6:00 · ★ MONEY SHOT ~2:30 ──────┐
  │                                                           │
  │  BEAT 1 (1:00) type From/To over a hill → tap Route       │
  │    SAY: "straight line runs over a hill — watch flattr"   │
  │                                                           │
  │  BEAT 2 (2:00) ★ route BOWS around red block; card +9 m   │
  │    SAY: "it bent around the hill — 9 m climb not 30 m"    │
  │    → THEN SHUT UP for 2 seconds. let them react.          │
  │                                                           │
  │  BEAT 3 (3:00) tap knob 🚶→🏔 → re-routes live, climb ↑    │
  │    SAY: "one knob, whole route re-thinks itself"          │
  │                                                           │
  │  BEAT 4 (4:30) toggle [Grades] → heatmap blooms           │
  │    SAY: "that red ridge is what the route refused"        │
  │                                                           │
  │  NAIL: ┃ "It bent around the hill — 9 m climb, not 30."   │
  │                                                           │
  │  IF IT BREAKS: all-green → "grades approximate, it's      │
  │    honest" → cut to recorded clip (slide 2).              │
  │                                                           │
  │  TIGHTEN: cut beat 4, then beat 3's 2nd tap.              │
  │    FLOOR: beats 1+2 — the bend + the number.              │
  └───────────────────────────────────────────────────────────┘
```

Go to chapter 03 — but only one level deep.
