# Chapter 8 — The AI question

In 2026 every senior interviewer knows you used AI to build this. Claude Code
wrote a lot of flattr's code. That is not a secret to protect — it's the default,
and pretending otherwise is the fastest way to fail this chapter. The question
under "did you use AI?" is never really about whether you used it. It's about
whether you understand what you shipped well enough to own it. This chapter
teaches the calibrated-honest answer: matter-of-fact about the AI's role,
matter-of-fact about yours, grounded in real understanding of the code.

The framework that runs through this whole chapter is **three modes of
decision-making.** Some decisions you made deliberately. Some the AI suggested
and you evaluated and accepted. Some the AI defaulted to and you didn't deeply
evaluate. Naming which mode each decision was — *especially* admitting the third
mode where it's true — is the single strongest signal you can send. The
candidate who claims every decision was mode one is lying and the interviewer
knows it.

---

## The chapter-opening diagram — what AI did, what I did

The honest split. Not a 50/50 marketing slide — a real map of where your
understanding is load-bearing and where the AI did mechanical work.

```
  flattr — what AI did vs what I own

  ┌─ AI (Claude Code) DID ────────┬─ I OWN ──────────────────────┐
  │ wrote most of the actual code  │ the ARCHITECTURE: build-time │
  │ (typing out astar.ts, the      │ vs runtime split, no backend,│
  │ React Native components, tests)│ static graph decision        │
  │                                │                              │
  │ boilerplate: GeoJSON shaping,  │ the ALGORITHM: directional   │
  │ MapLibre wiring, Expo config   │ cost model, admissible        │
  │                                │ heuristic, finite BLOCKED,    │
  │ suggested library choices,     │ the Dijkstra→A*→grade→        │
  │ idiomatic TS patterns          │ directed progression          │
  │                                │                              │
  │ helped DEBUG: surfaced the     │ the DEBUGGING JUDGMENT: knew  │
  │ disconnected-components lead    │ to separate algorithm from   │
  │                                │ data, ran the reachability    │
  │                                │ probe, recognized the classic│
  │                                │ mesh-construction bug         │
  └────────────────────────────────┴──────────────────────────────┘

  THE TEST: I can explain any line. AI typed it; I directed it.
  Where I CAN'T explain a line, I say so (never bluff code).

  ┌─ THREE MODES of every decision ──────────────────────────────┐
  │  1. DELIBERATE          my call    (directional cost, no DB)  │
  │  2. EVALUATED+ACCEPTED  AI suggested, I weighed it             │
  │                         (Open-Meteo, lazy-deletion heap)      │
  │  3. DEFAULTED-TO        AI's default, I didn't deeply vet     │
  │                         (own this honestly — riskiest, most   │
  │                          senior-positive when owned)          │
  └──────────────────────────────────────────────────────────────┘
```

The right column and the three-modes box are what you defend. The left column
you state plainly and move on.

---

## "Did you use AI to build this?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Did you use AI to build this?"                               │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   NOT whether you used it — they assume you did. They're          │
│   testing whether you'll be defensive or honest, and whether     │
│   "I used AI" means "I understand it" or "I copy-pasted and       │
│   hoped." Your tone in the first five seconds answers half of    │
│   it.                                                             │
└─────────────────────────────────────────────────────────────────┘
```

> "Yes, heavily — I built it with Claude Code. The way I'd frame it: the AI did
> most of the *typing*, and I did the *directing*. The architecture is mine — the
> build-time-versus-runtime split, the decision to have no backend, the static
> graph. The algorithm is mine — the directional cost model, keeping the
> heuristic admissible, the finite BLOCKED value, building it as a measured
> progression. Claude wrote a lot of the actual lines, especially the boilerplate
> — GeoJSON shaping, MapLibre wiring, the test scaffolding.
>
> The test I hold myself to is: I can explain any line in the routing engine, and
> *why* it's there, not just what it does. Where the AI made a choice I didn't
> deeply evaluate, I'll tell you that too — I'd rather be precise about what I
> directed versus what I accepted than pretend I hand-wrote every character."

```
┃ "The AI did the typing. I did the directing. I can
┃  explain any line in the engine — and where I can't,
┃  I'll say so."
```

That's the whole posture in two sentences. Notice it's neither defensive
("well, I wrote the important parts myself") nor evasive ("I mean, everyone uses
AI"). It's matter-of-fact and it sets up the deeper questions.

---

## "Can you explain this section line by line?"

This is the real test. They'll pick a function and ask you to walk it. This is
where bluffing dies and understanding shows.

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "Can you walk me through this function line by line?"          │
│   (pointing at search() in astar.ts)                            │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   The actual probe behind the whole chapter. Did you understand  │
│   what the AI wrote, or did you accept code you can't read?      │
│   They'll pick a load-bearing function on purpose.              │
└─────────────────────────────────────────────────────────────────┘
```

The good news: `search()` is exactly the function you understand best. Walk it
with confidence.

> "Sure. `search` (astar.ts:22) is the one engine the whole project runs on. It
> takes the graph, start and goal, the user's max grade, and — the key part — a
> `costFn` and a `heuristicFn`. Those two arguments are what make it Dijkstra, or
> A*, or grade-aware, or directional.
>
> It sets up an open priority queue, a `g` map of best-known cost to each node, a
> `came` map for path reconstruction, and a `closed` set. It pushes the start with
> priority equal to the heuristic. Then the main loop: pop the lowest-f node. If
> it's already closed, skip it — that's lazy deletion, I push duplicates and skip
> stale pops instead of doing a decrease-key. If it's the goal, reconstruct and
> return. Otherwise close it, and for each incident edge, compute the tentative
> cost through the current node using `costFn` — *this* is where directional cost
> enters, because `costFn` gets the `fromNodeId` and can apply a signed penalty —
> and if that beats the best known cost to the neighbor, relax it and push it with
> `tentative + heuristic`.
>
> The lazy-deletion choice was deliberate — it's the simplest correct heap, and
> the spec says upgrade to decrease-key only if profiling demands it (§14.3). At
> my graph size it never did."

That walkthrough proves the point: you don't just know that the AI wrote it, you
know *why each piece is shaped the way it is* — the lazy deletion, the `costFn`
seam, the relaxation condition. That's ownership.

Deeper line-by-line on `search()`, lazy deletion, and the relaxation invariant →
`.aipe/study-dsa-foundations/`.

---

## "What did the AI get wrong?" — the three modes in action

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What did the AI get wrong, or what did you have to push       │
│    back on?"                                                     │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Were you a passenger or a driver? Can you name a moment you    │
│   overrode the AI — which proves you were actually evaluating    │
│   its output, not just accepting it? And can you admit a place   │
│   you DIDN'T evaluate (mode three) honestly?                     │
└─────────────────────────────────────────────────────────────────┘
```

This is where the three modes earn their place. Walk all three.

> "Three honest categories.
>
> Deliberate, where I drove: the finite BLOCKED value. The instinct — and I think
> the default an AI would reach for — is to make an impassable edge cost Infinity.
> I specifically wanted it large-but-finite (1e9, cost.ts:5) so that a steep-only
> route still gets returned and flagged, distinct from a genuinely disconnected
> 'no route.' That distinction was my call and I'd push back on Infinity every
> time.
>
> Evaluated and accepted: the lazy-deletion priority queue, and Open-Meteo for
> elevation. The AI suggested both. I evaluated lazy deletion against decrease-key
> and accepted it because it's simpler and correct and profiling didn't justify
> the complexity. I evaluated Open-Meteo against Google's paid API and accepted
> the free one *because* I could put it behind a provider interface and swap later.
> Those were AI suggestions I actively weighed.
>
> Defaulted-to, where I'll be honest I didn't go deep: some of the Expo and
> MapLibre configuration, and the exact GeoJSON property shaping for the map
> layers. The AI produced idiomatic versions, they worked, and I didn't
> independently verify every Expo 56 API choice against the docs — I leaned on the
> AI and the fact that it rendered. If you drilled into why a specific MapLibre
> layer style is structured the way it is, I'd be reconstructing it, not recalling
> a decision I made."

```
        ▸ Three modes: what I drove, what I weighed, what
          I defaulted to. Owning the third mode honestly
          is the strongest signal in this chapter.
```

Naming the defaulted-to mode (Expo/MapLibre config) is the move most candidates
are too scared to make — and it's exactly the one that reads as senior, because
it proves the other two modes are real distinctions, not a story.

---

## Weak vs strong — the AI question

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                   │ STRONG ANSWER                 │
├──────────────────────────────┼──────────────────────────────┤
│ "I mean, I used some AI for   │ "Yes, heavily — Claude Code.  │
│ autocomplete but I really     │ The AI typed most of the code;│
│ wrote it myself. The AI just  │ I directed the architecture   │
│ helped with small stuff."     │ and the algorithm. I can      │
│  — OR —                       │ explain any line in the       │
│ "Yeah AI wrote most of it,    │ engine. Three modes: I drove  │
│ honestly I'm not sure how     │ the finite BLOCKED, I weighed │
│ some of it works but it       │ and accepted the lazy heap and│
│ passes the tests."            │ Open-Meteo, and I defaulted to│
│                               │ the Expo/MapLibre config —    │
│                               │ which I'd reconstruct, not    │
│                               │ recall."                      │
├──────────────────────────────┼──────────────────────────────┤
│ Why both are weak:            │ Why it works:                  │
│ The first is defensive and    │ Matter-of-fact about the AI,   │
│ obviously false — minimizing  │ specific about ownership,      │
│ AI use in 2026 reads as       │ proves understanding (can      │
│ insecurity. The second is the │ explain any line), and the     │
│ opposite failure: accepting   │ three-modes honesty — including │
│ code you can't explain. Both  │ the defaulted-to admission —   │
│ fail the real test:           │ shows you were driving, not    │
│ understanding.                │ riding.                        │
└──────────────────────────────┴──────────────────────────────┘
```

---

## Where the AI conversation goes next

```
  You gave the three-modes answer.
        │
        ├─► IF THEY DRILL INTO A "DEFAULTED-TO" AREA
        │     (e.g. "why is this MapLibre layer shaped this way?")
        │     "That's one I flagged as defaulted-to — I'd be
        │      reconstructing it live rather than recalling a
        │      decision. Let me reason through it..." then
        │      actually reason. Never bluff a recall you don't
        │      have. See the box below.
        │
        ├─► IF THEY ASK "so what did YOU actually contribute?"
        │     "The judgment. The AI can write an A*; it can't
        │      decide that cost should be directional, or that
        │      BLOCKED must be finite, or that the snap is the
        │      first bottleneck not the search. Those are the
        │      decisions, and they're mine."
        │
        └─► IF THEY ASK "what has working with AI taught you?"
              "To be sharper about what I'm actually deciding
               versus accepting. When the AI types fast, the
               risk is accepting choices you didn't make. The
               discipline is knowing, for every load-bearing
               line, which mode it came from."
```

---

## The "I don't know" box — when they drill a defaulted-to area

This is the one place in the whole book where "I don't know" is *most* likely and
*most* survivable — because you pre-labeled it as defaulted-to.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They drill exactly into a "defaulted-to" area you flagged:  ║
║   "You said you didn't evaluate the Expo config deeply. OK —  ║
║   why does loadGraph cast through `unknown`? Why that         ║
║   pattern?"                                                    ║
║                                                               ║
║   You genuinely may not have a designed reason — it's an AI   ║
║   default you accepted. Owning that beats inventing one.      ║
║                                                               ║
║   Say:                                                         ║
║   "Honest answer: that `as unknown as Graph` cast            ║
║    (loadGraph.ts:10) is a TypeScript pattern for asserting    ║
║    a type the compiler can't infer from a JSON import — and   ║
║    it's exactly the spot I called out as a validation gap in  ║
║    Chapter — in the failure story. It's an AI default I       ║
║    accepted without making it a real boundary. I wouldn't     ║
║    defend it as a good decision; I'd defend it as a known     ║
║    gap I'd fix with a validation pass. I'm not going to       ║
║    invent a principled reason for it, because there isn't     ║
║    one — it was the path of least resistance and I'd change   ║
║    it."                                                        ║
║                                                               ║
║   What this signals: you connected the drilled line to a gap  ║
║   you ALREADY identified (consistency across the interview),  ║
║   refused to manufacture a justification, and named the fix.  ║
║   That's maximum credibility — you'd rather own a gap than    ║
║   fake a reason.                                              ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "Oh, I chose that cast deliberately because it's the most   ║
║    type-safe way to..." — inventing a principled reason for   ║
║   an AI default is the one move that can sink an otherwise    ║
║   strong loop. They can smell a retrofitted justification.    ║
╚═══════════════════════════════════════════════════════════════╝
```

```
┃ "I'm not going to invent a principled reason for it,
┃  because there isn't one. I'd rather own the gap than
┃  fake the rationale."
```

---

## What you'd change about how you used AI

If I ran this project again, I'd be more deliberate about turning mode-three
decisions into mode-two decisions *during* the build instead of discovering them
in interview prep. Every time the AI produced something load-bearing — the
`loadGraph` cast, the Expo config — I'd pause and decide whether to evaluate it or
consciously accept the default, and write that down. The engine I drove hard and
understand cold. The shell I let the AI default on, and that's exactly where my
"defaulted-to" admissions cluster. Closing that gap during the build, not after,
is the discipline AI-assisted work actually demands.

---

## One-page summary — Chapter 8

**Core claim:** The AI question tests understanding, not usage. Be matter-of-fact
about the AI's role, prove you can explain the code, and name the three modes of
decision-making honestly — including defaulted-to.

**The answers:**
- **"Did you use AI?"** → "Yes, heavily, Claude Code. AI typed; I directed. I can explain any line in the engine."
- **"Explain this line by line"** → walk `search()` (astar.ts:22): the `(costFn, heuristicFn)` seam, lazy deletion, relaxation. You own this function cold.
- **"What did AI get wrong / push back on?"** → three modes: drove finite BLOCKED; weighed+accepted lazy heap + Open-Meteo; defaulted-to Expo/MapLibre config.

**The three modes:** deliberate · evaluated-and-accepted · defaulted-to. Owning mode three is the strongest signal.

**Pull quotes:**
- ┃ "The AI did the typing. I did the directing. I can explain any line — and where I can't, I'll say so."
- ▸ Three modes: what I drove, what I weighed, what I defaulted to.
- ┃ "I'm not going to invent a principled reason for it. I'd rather own the gap than fake the rationale."

**What you'd change:** Turn mode-three decisions into mode-two *during* the build — pause on every load-bearing AI default and consciously evaluate or accept it, in writing. Never bluff code; own the gap instead.
