# Chapter 6 — The Q&A   (post-clock, prep only)

## Opening hook

This chapter never touches the ten-minute clock — it runs *after* the buzzer,
when judges turn to you and probe. But it's where a strong demo gets confirmed or
unravels, so you prep it like a beat even though it isn't timed. The job here is
crisp, honest, speakable answers anchored to what flattr actually does. No
hedging, no over-claiming, and — critically for 2026 — no defensiveness about AI.
Judges assume heavy AI use; candor reads better than a flinch every time.

Each answer below is short enough to say in one breath, true to the codebase, and
followed by the place a deeper follow-up goes. You don't memorize these
verbatim — you internalize the *shape* so you can answer in your own words under
pressure.

## The chapter-opening diagram — the question decision tree

These are the questions judges always ask, and the follow-up each one branches
into. Know the branch, not just the answer.

```
  JUDGE Q&A — the probes and their follow-ups

  ┌─ "Is this actually working?" ────────────────────────────┐
  │   YES — live, on-device. (you just showed it)            │
  │   └─► follow-up: "what's faked?" → nothing in the demo;  │
  │       grades cached from a real elevation API            │
  └──────────────────────────────────────────────────────────┘
  ┌─ "What was the hard part?" ──────────────────────────────┐
  │   the 'no route' bug → disconnected components → corridor │
  │   └─► follow-up: "how'd you find it?" → reachability probe│
  └──────────────────────────────────────────────────────────┘
  ┌─ "What's the stack?" ────────────────────────────────────┐
  │   Expo/RN + MapLibre · pure-TS engine · hand-rolled A*    │
  │   └─► follow-up: "why not Google/OSRM?" → they optimize   │
  │       fastest; the grade router is the whole point        │
  └──────────────────────────────────────────────────────────┘
  ┌─ "Did you build this in the hackathon?" ─────────────────┐
  │   yes — and here's how much was AI-assisted (own it)      │
  │   └─► follow-up: "so what did YOU do?" → architecture +   │
  │       the algorithm + the debugging                       │
  └──────────────────────────────────────────────────────────┘
  ┌─ "Is there a business / what's next?" ───────────────────┐
  │   honest: a feature, maybe an SDK, not a company today    │
  │   └─► follow-up: "who pays?" → cycling/micromobility apps │
  └──────────────────────────────────────────────────────────┘
```

Five probes, five branches. Walk into Q&A knowing which one you're on.

## The body — the answers

### Q1 — "Is this actually working, or is it a mockup?"

It's working, live, on-device. You just routed two real addresses and the grades
came from a real elevation API (cached, but real). Say so plainly.

```
  ┃ "It's live — what you saw was a real route computed on the
  ┃  phone, real elevation data behind the grades. Nothing in
  ┃  the demo is faked; the only trick is I cache the elevation
  ┃  so the free API doesn't throttle me on stage."
```

Follow-up — *"so what's cached vs live?"*: The street graph for the demo area is
bundled; elevation samples are cached to disk after the first real fetch
(`mobile/src/elevCache.ts`); the routing itself runs fresh on every tap and knob
change.

### Q2 — "What was the hard part?"

This is your build-story bug — the strongest answer you have. Tell it the same way
as Chapter 4, tightened.

```
  ┃ "Two real addresses kept returning 'no route' even though
  ┃  both points existed. A reachability probe showed they were
  ┃  in two disconnected pieces of the graph — only nearby
  ┃  streets had loaded. So I load the whole corridor between
  ┃  the endpoints in one build and stitch it into one graph."
```

Follow-up — *"how did you find it?"*: A reachability probe on-device — it printed
that start existed, end existed, but end was unreachable from start. That told me
it was a connectivity problem, not a routing-logic problem.
→ deeper walk: `.aipe/study-system-design/03-tile-merge-stitch.md`.

### Q3 — "What's the stack?"

Now you name it — this is where the stack belongs, not the cold open. Crisp and
specific.

```
  ┃ "Front end is Expo / React Native with MapLibre for the map.
  ┃  The routing engine is pure TypeScript, no framework — a
  ┃  hand-rolled A* search over a grade-annotated street graph
  ┃  built from OpenStreetMap plus a free elevation API."
```

Follow-up — *"why hand-roll A*? Why not Google Directions or OSRM?"*: Because the
grade-aware router *is* the project — off-the-shelf routers optimize for fastest,
and there's no knob to make them prefer flat. The directional cost function and
the A* over it are the whole point.
→ deeper walk: `.aipe/study-system-design/06-parametric-search-engine.md`.

### Q4 — "Did you build this during the hackathon?" + the AI-honesty answer

This is the one to get right. Judges in 2026 assume heavy AI use. The wrong move
is defensiveness; the right move is matter-of-fact candor about what the tools did
and what *you* did. Own it.

```
  ┃ "Yes, this weekend — and I built it with heavy AI assistance,
  ┃  which I'm happy to be specific about. The AI helped me move
  ┃  fast on the React Native UI and a lot of the boilerplate.
  ┃  What's mine is the architecture, the directional-grade
  ┃  cost algorithm, and the debugging — like the disconnected-
  ┃  graph bug, which no tool was going to hand me."
```

The shape of this answer: *yes, heavily AI-assisted, and here's the line between
what the tools did and what I own.* You own the **architecture** (the build-time
graph artifact, the on-device corridor build, the tile merge/stitch), the
**algorithm** (directional grade cost → A*), and the **debugging** (the
reachability probe and the corridor fix). Naming that line confidently is what
separates "I prompted an app" from "I engineered one with AI in the loop."

Follow-up — *"so what did you actually write yourself?"*: The signed directional
grade penalty (`cost.ts`), keeping the A* heuristic admissible, the
finite-`BLOCKED` design so "no flat route" stays distinct from "no route," and the
corridor-stitch fix. The decisions, the algorithm, and the bugs — those are mine.

### Q5 — "Is there a business here / what's next?"

Honest and unhyped. It's a strong feature, possibly an SDK, not a company you're
claiming today.

```
  ┃ "Honestly, today it's a strong feature, not a company. Where
  ┃  I'd take it: sharper elevation data, profiles per vehicle,
  ┃  and maybe a routing SDK that cycling and micromobility apps
  ┃  drop in — they all want flat-preferring routes and none of
  ┃  the big routers give them one."
```

Follow-up — *"who'd pay?"*: Cycling apps, e-scooter and micromobility operators,
accessibility-focused navigation — anyone whose users care about effort or
grade, not just arrival time.

### Q6 — "How accurate are the grades, really?"

The honesty question. Own the coarseness; don't oversell.

```
  ┃ "Coarse — about 90-meter resolution from a free elevation
  ┃  grid. That's why the card literally says 'grades
  ┃  approximate.' It's accurate enough to bend the route around
  ┃  a real hill, not accurate enough to trust to the meter — and
  ┃  I'd rather tell you that than fake precision I don't have."
```

Follow-up — *"what happens when the elevation API is down?"*: It falls back to
flat (0 m) elevation so the streets still render and routing still connects, flags
the grades as approximate, and quietly re-fetches real elevation once the API
recovers. Connectivity over fidelity, on purpose.
→ deeper walk: `.aipe/study-system-design/05-elevation-provider-fallback.md`.

## Strong vs weak — answering under pressure

The contrast that decides whether a follow-up helps or hurts you.

```
  WEAK — defensive / vague             STRONG — candid / specific
  ─────────────────────────────       ──────────────────────────────────
  "Well, I mean, I wrote most of      "Heavily AI-assisted, yes. The AI
   it myself, the AI just helped       did the RN boilerplate; I own the
   a little with some parts, it's       architecture, the directional-cost
   basically all my code…"             algorithm, and the debugging — like
                                       the disconnected-graph bug."
  → sounds defensive, judges
    push harder                        → sounds like an engineer who used
                                         a tool well; judges move on
```

The weak answer minimizes the AI and invites a harder push. The strong answer
names the AI's role *and* the clear line of what you own — and that line is
exactly what the judges are trying to find.

## IF IT BREAKS — the question you can't answer

Q&A has no live app, but it has its own failure mode: a question you genuinely
don't know. Never bluff. Name the boundary and offer the nearest true thing.

```
  ╔══════════════════════════════════════════════════════════════╗
  ║ IF YOU DON'T KNOW                                            ║
  ║ Don't bluff. Say: "I haven't measured that — here's what I   ║
  ║ do know," and give the nearest true fact. Or: "good          ║
  ║ question, that's exactly the next thing I'd test." Candor    ║
  ║ about a gap reads as confidence; a bluffed answer that       ║
  ║ collapses on the follow-up reads as the opposite.            ║
  ╚══════════════════════════════════════════════════════════════╝
```

## The one-page run sheet

```
  ┌─ RUN SHEET — CH 6 Q&A ── post-clock, prep only ──────────┐
  │                                                          │
  │  Q "actually working?"  → live, on-device, grades real   │
  │                            (cached, not faked)           │
  │  Q "hard part?"         → 'no route' → disconnected →     │
  │                            corridor stitch               │
  │  Q "stack?"             → Expo/RN + MapLibre · pure-TS    │
  │                            engine · hand-rolled A*        │
  │  Q "built in hackathon?"→ yes, heavy AI; I OWN the        │
  │                            architecture + algorithm +     │
  │                            debugging                      │
  │  Q "business/next?"     → feature now, maybe an SDK;      │
  │                            cycling/micromobility pay      │
  │  Q "grades accurate?"   → coarse ~90 m; 'approximate';    │
  │                            flat fallback when API 429s    │
  │                                                          │
  │  AI HONESTY (verbatim shape):                            │
  │   ┃ "Heavily AI-assisted. Tools did the RN boilerplate;  │
  │   ┃  I own the architecture, the directional-cost        │
  │   ┃  algorithm, and the debugging."                      │
  │                                                          │
  │  DON'T KNOW IT? Name the gap + nearest true fact.        │
  │   Never bluff.                                           │
  │                                                          │
  │  deeper follow-ups → .aipe/rehearse-interview-defense/   │
  │   + .aipe/study-system-design/ (03, 05, 06)             │
  └────────────────────────────────────────────────────────────┘
```
