# Chapter 6 — The Q&A (after the clock)

This chapter runs *after* your timed slot — it never eats the ten minutes. But it's where the demo is won or lost a second time, because judges decide between close demos on the answers. The standard probes are predictable, so prepare them: crisp, honest, anchored to what the code actually does, and never defensive. The rule across all of them: lead with the direct answer, then one sentence of evidence, then stop. Rambling in Q&A undoes a clean demo.

```
  THE FIVE PROBES JUDGES ALWAYS ASK

  "is this actually working?"        ──► yes, you saw it live; tested
                                          against a reference algorithm
  "what was the hard part?"          ──► the disconnected-graph bug,
                                          found by instrumenting first
  "what's the stack?"                ──► hand-rolled TS engine, Expo/RN,
                                          MapLibre, OSM + Open-Meteo
  "did you build this in the window?"──► yes; honest about AI assistance
  "is there a business / what's next?"─► honest: it's a prototype; the
                                          real next step is demand discovery
```

Each gets a tight answer below, plus a branch for the likely follow-up.

## "Is this actually working, or is it smoke and mirrors?"

> "It's working — you saw it route live. And it's not just plausible, it's *correct*: the router is tested against a slower reference algorithm and has to return the exact same optimal cost, or the test fails. The rough edge I'll own is that the elevation data is coarse and falls back to flat when the free API rate-limits — which I mark as approximate rather than fake."

## "What was the hardest part?"

> "Distant routes returned 'no route' even though both endpoints existed. Instead of guessing, I added a reachability probe — BFS from the start to check if the end was even reachable. It wasn't: the graph was loading in disconnected islands because I only fetched streets near the screen. Fixed by loading the corridor between the two points. The lesson was instrument before guessing."

## "What's the stack?"

> "A hand-rolled routing engine in TypeScript — A\*, the heap, the cost model, all mine, no routing library. The app is Expo/React Native with a MapLibre map. Data's from OpenStreetMap via Overpass and elevation from Open-Meteo, baked into a static graph at build time so routing runs fully on-device, offline."

```
  IF THEY PUSH ON THE STACK

  "hand-rolled TS engine + Expo/RN + MapLibre + OSM/Open-Meteo"
        │
        ├─► "Why hand-roll instead of OSRM?"
        │     "Directional grade cost doesn't fit their cost models,
        │      and owning the algorithm was the point."
        │
        ├─► "Why no backend?"
        │     "Access is read-only whole-graph traversal — a static
        │      bundled artifact beats a server for that. Works offline."
        │
        └─► "React Native, not web?"
              "It's a phone-first mobility product — native GPS and
               offline matter. I've shipped RN before."
```

## "Did you build this during the hackathon? Did you use AI?"

The 2026 question. Judges assume heavy AI use; defensiveness reads worse than candor.

> "Yes, built in the window, and yes — I used AI heavily, Claude Code. The split: the AI wrote a lot of the implementation, but I owned the architecture and designed the algorithm — the directional cost, keeping the heuristic admissible, the honest fallback — and I drove the debugging. I can defend every decision in it, which is the part that matters."

╔══════════════════════════════════════════════════════╗
║ IF THEY DRILL THE CODE                                 ║
║ "Explain this function" → go deep on the engine        ║
║ (search/heap/cost — your strong tier, read it cold).   ║
║ On UI or a part you defaulted to: "that's more         ║
║ standard wiring / an AI default I accepted — happy to   ║
║ read it with you." Never bluff authorship you can't    ║
║ back; one caught bluff costs the room's trust.         ║
╚══════════════════════════════════════════════════════╝

## "Is there a business here? What's next?"

> "Honestly, it's a prototype — no users yet, so I won't pretend there's a validated business. The problem is real: grade-aware routing matters for scooters and accessibility. The genuine next step isn't more features, it's demand discovery — talking to real riders about whether they'd switch for a flat-first mode. The engine scales city-wide with a spatial index and contraction hierarchies when that's justified."

| WEAK Q&A ANSWER | STRONG Q&A ANSWER |
|---|---|
| "Yeah there's a huge market, micromobility is exploding, we'd monetize with premium routes…" | "It's a prototype with no users — I won't fake a business. The problem's real; the honest next step is demand discovery with actual riders." |
| **Why it's weak:** inventing a market for a userless prototype collapses on one follow-up and torches your credibility. | **Why it works:** candor about the stage, conviction about the problem, a real next step. Judges trust the honest answer. |

▸ In Q&A, lead with the direct answer, add one sentence of evidence, then stop. The ramble is what undoes a clean demo.

## One-page run sheet

- **When:** after the timed slot — never counts against the ten minutes.
- **"Working?":** yes, live; tested against a reference algorithm for optimality; coarse elevation owned honestly.
- **"Hard part?":** disconnected-graph bug, found by a reachability probe; instrument-before-guess.
- **"Stack?":** hand-rolled TS engine, Expo/RN, MapLibre, OSM/Overpass + Open-Meteo, static on-device graph.
- **"AI / built in window?":** yes and yes — AI wrote much of the code, I owned architecture + algorithm + debugging, can defend every decision.
- **"Business?":** prototype, no users; problem is real; next step is demand discovery, not features.
- **Rule:** direct answer → one sentence of evidence → stop. Never bluff code you can't read; never fake a market.

┃ "I used AI heavily — and I can defend every decision in it. That's the part that matters."
