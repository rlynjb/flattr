# Chapter 6 — The Q&A   (after the clock — prep only)

## Opening hook

The clock stopped. You finished at 9:30, the room voted, and now the judges
lean in. This chapter never counts against your ten minutes — it's pure prep
for the questions that come *after*. The good news: judges ask the same five
questions at every hackathon, so you can rehearse every one cold. The job here
is crisp, honest, speakable answers anchored to what flattr actually does —
and the discipline to go one level deeper than the demo without going down a
rabbit hole.

One answer matters more than the rest in 2026: the AI-honesty question. You
built this with heavy AI assistance, and the right move is matter-of-fact
ownership of the architecture and algorithm decisions — not defensiveness.
Judges assume AI use; candor reads better than dodging. That answer is below
and it's the one to rehearse hardest.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ──────────────────────────────────────────────── 10:00│
  │   THE Q&A — PREP ONLY. Runs AFTER the clock. 0 budget.    │
  └──────────────────────────────────────────────────────────┘
```

No clock pressure. But keep each answer to two or three sentences — judges
have other teams to see.

## The chapter-opening diagram — the question decision tree

The five questions that come every time, and where each one can go deeper.
Know which branch you're on so you give a two-sentence answer, not a lecture.

```
  THE JUDGE QUESTIONS — five branches, know where each goes

  ┌─ "Is this actually working?" ────────────────────────────┐
  │   → YES. live, on-device, real OSM + elevation. (re-demo) │
  └───────────────────────────────────────────────────────────┘
  ┌─ "What was the hard part?" ──────────────────────────────┐
  │   → the "no route" / disconnected-components bug (ch 04)  │
  │      └─ deeper? → corridor load + stitch (study book 03)  │
  └───────────────────────────────────────────────────────────┘
  ┌─ "What's the stack?" ────────────────────────────────────┐
  │   → Expo/RN + MapLibre; hand-rolled A* in TS; no rt API   │
  │      └─ deeper? → admissible heuristic, PQueue (defense)  │
  └───────────────────────────────────────────────────────────┘
  ┌─ "Did you build this DURING the hackathon?" ─────────────┐
  │   → yes — and here's exactly how AI fit in (the honesty   │
  │      answer below; own architecture + algorithm)          │
  └───────────────────────────────────────────────────────────┘
  ┌─ "Is there a business / what's next?" ───────────────────┐
  │   → accessibility routing; cities + profiles next (ch 05) │
  └───────────────────────────────────────────────────────────┘
```

Each branch has a short answer and a deeper one. Give the short one first;
only descend if they ask.

## The body — the answers

Each answer is in your voice, two to three sentences, ready to say cold.

### Q1 — "Is this actually working, or is it a mockup?"

```
┃ "Fully working — what you saw was live. It pulls real
┃  OpenStreetMap streets and real elevation for the corridor
┃  on-device, builds a graph, and runs the search right there.
┃  Happy to route any two addresses you give me right now."
```

The follow-up offer ("give me two addresses") is the strongest possible proof.
Only make it if your cache is warm for the area they're likely to name — keep
it to your demo neighborhood.

### Q2 — "What was the hardest part?"

```
┃ "The 'no route' bug. Two valid addresses would return
┃  nothing because they landed in two disconnected pieces of
┃  the graph — I'd only loaded tiles around each endpoint, not
┃  the gap. Fix was loading the whole corridor between them and
┃  stitching the seams so the graph actually connects."
```

**Deeper follow-up — "how do you know it's disconnected vs just steep?":**

```
┃ "That's the key design choice — BLOCKED is a large finite
┃  number, not infinity. A too-steep edge stays expensive but
┃  traversable, so a steep-only route still returns and gets
┃  flagged. Only a genuinely disconnected graph returns null.
┃  Two different states, never confused."
```

→ For the full walk: `.aipe/study-system-design/04-honest-fallback-routing.md`
and `.aipe/study-system-design/03-tile-merge-stitch.md`.

### Q3 — "What's the stack?"

```
┃ "Expo and React Native on the front, MapLibre for the map.
┃  The router is hand-rolled — a generic A* in TypeScript where
┃  the grade-aware cost and the heuristic are just parameters.
┃  No Google Maps, no Valhalla, no OSRM — the graph work is the
┃  whole point, so I wrote it."
```

**Deeper follow-up — "why hand-roll the router?":**

```
┃ "Off-the-shelf routers optimize for distance or time — none
┃  of them take a signed, directional grade penalty. To route
┃  for flat I needed the cost function to be mine. The A* stays
┃  optimal because the heuristic is admissible — haversine is a
┃  true lower bound and the penalty's never negative."
```

→ For the heuristic admissibility + PQueue depth:
`.aipe/rehearse-interview-defense/`.

### Q4 — "Did you build this during the hackathon? How much was AI?"  ★ the honesty answer

This is the one to rehearse hardest. Own it, flat and confident. Judges in
2026 assume heavy AI use — defensiveness reads worse than candor.

```
┃ "Built in the window, and yes — I used AI heavily, the same
┃  way I'd use it at work. But the decisions are mine: the
┃  directional, signed-grade cost function; keeping BLOCKED
┃  finite so 'too steep' and 'no route' stay distinct; loading
┃  the corridor to fix the disconnected-graph bug; the
┃  admissible heuristic so A* stays optimal. AI wrote a lot of
┃  the lines. I architected the system and I own the algorithm."
```

The structure that makes this land: name the tool use plainly ("yes, heavily"),
then list the *decisions* — and they're real, specific, defensible decisions
you can each explain on demand. That's the proof you drove it. If they push on
any one of those four decisions, you can go three levels deep on it, which is
exactly what proves ownership.

**Deeper follow-up — "so what did YOU actually do?":**

```
┃ "Pick any of those four and I'll walk you through why. Take
┃  the finite BLOCKED — if I'd used infinity, a steep-only route
┃  would look identical to a disconnected one, and the app would
┃  lie to a wheelchair user that there's no way home. That's a
┃  product decision an autocomplete doesn't make for you."
```

### Q5 — "Is there a business here? What's next?"

```
┃ "The wedge is accessibility — mobility-impaired routing is
┃  genuinely underserved, and cities increasingly have to care
┃  about it. Next is more map coverage, real accessibility
┃  profiles beyond the three presets, and turn-by-turn. Today
┃  it's one city and a clean proof the routing works."
```

Keep "today vs next" sharp, same as the close — never imply the roadmap
exists.

### Bonus probe — "your grades look approximate / are they accurate?"

Own it before they have to push.

```
┃ "Approximate, on purpose, and the app says so. The free
┃  elevation data is a coarse ~90-meter grid, so grades are
┃  ballpark — good enough to tell a flat street from a steep
┃  one, which is the decision that matters. And when the API
┃  rate-limits me I fall back to flat and label it 'grades
┃  approximate' rather than crash or fake a number."
```

→ The fallback + cache mechanics:
`.aipe/study-system-design/05-elevation-provider-fallback.md`.

### Strong vs weak — the Q&A move

```
  WEAK Q&A answer                  STRONG Q&A answer
  ──────────────────────────      ──────────────────────────
  "How much was AI?" →            "Yes, heavily — but here are
   "Oh, not that much really,      the four decisions that are
    I wrote most of it myself"      mine, and I'll defend any of
  → defensive, sounds like a       them." → matter-of-fact, lists
    dodge, invites doubt            real architectural calls
                                   → reads as the engineer who
  "What's the hard part?" →         drove the build
   "Um, it was all pretty hard"
  → vague, no story                 ONE named bug + the fix
                                   → concrete, only-the-builder
```

In 2026, the defensive AI answer is the single most common way a strong build
loses credibility in Q&A. Candor wins. List the decisions.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — a question you don't know the answer to        ║
║ Don't bluff — judges spot it instantly. Say: "I haven't       ║
║ measured that — here's how I'd find out," and name the method. ║
║ "I don't know yet, but my guess is X because Y" beats a        ║
║ confident wrong answer every time. One honest "I don't know"   ║
║ buys credibility for everything else you said.                 ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Q&A has no clock, so there's nothing to cut — but keep *each answer* tight:
two to three sentences, then stop and let them ask the follow-up. The failure
mode here is the opposite of the demo's: not running long on the clock, but
monologuing a single answer until the judge's eyes glaze. Answer, pause, let
them drive.

## The one-page run sheet

```
  ┌─ CH 06 · Q&A · POST-CLOCK · PREP ONLY ───────────────────┐
  │                                                           │
  │  Q1 working? → "fully live, on-device, real data —        │
  │     give me two addresses." (only if cache warm)          │
  │  Q2 hard part? → "no-route bug: disconnected components;  │
  │     load + stitch the corridor."                          │
  │  Q3 stack? → "Expo/RN + MapLibre; hand-rolled A* in TS;   │
  │     no routing API — graph work is the point."            │
  │  Q4 ★ AI? → "yes, heavily. Decisions are mine: signed     │
  │     directional cost · finite BLOCKED · corridor fix ·    │
  │     admissible heuristic. I own the architecture + algo." │
  │  Q5 business/next? → "accessibility routing; cities +     │
  │     profiles + turn-by-turn next. Today: one city, works."│
  │  Bonus grades? → "approximate on purpose, ~90 m grid,     │
  │     labeled honestly; flat fallback on throttle."         │
  │                                                           │
  │  DON'T KNOW IT: "haven't measured — here's how I'd check."│
  │                                                           │
  │  DEEPER: defense book (heuristic, PQueue) ·               │
  │   study 03/04/05 (stitch, fallback, elevation).           │
  └───────────────────────────────────────────────────────────┘
```

That's the book. Pre-warm the cache, open in motion, land the bend at 2:30,
finish at 9:30, and own the AI answer. Go win it.
