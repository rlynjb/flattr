# Chapter 8 — The AI question

Every senior interview in 2026 has this question in it somewhere: "Did you use AI to build this?" Sometimes it's direct, sometimes it's the trap version — "can you explain this section line by line?" — designed to catch someone who shipped code they don't understand. The interviewer already assumes you used AI. Everyone does. What they're actually probing is whether you *understand what you shipped well enough to own it.* The dividing line between strong and weak candidates isn't whether AI wrote code — it's whether you can stand behind every decision in it.

The worst answer is defensive ("I mean, I used it a little, but I wrote the important parts"). The second-worst is dishonest ("no, this is all me"). The best answer is matter-of-fact: yes, heavily, here's the division of labor, here's how I made sure I own it, and here's what the tools are actually good and bad at. Calm, specific, reflective. You used AI to build flattr — including this very book — and the way you talk about it is itself a senior signal.

```
  WHAT AI DID  vs  WHAT I DID — the honest split

  ┌─ AI (Claude Code) DID ─────────┬─ I DID ───────────────────────┐
  │ wrote most of the              │ owned the architecture:        │
  │   implementation code          │   build-time/runtime split,    │
  │ iterated the RN/MapLibre UI    │   static-graph-no-DB call       │
  │ drafted the degradation        │ DESIGNED the algorithm:         │
  │   handling on my direction     │   directional cost, admissible  │
  │ suggested specific tactics     │   heuristic, BLOCKED-finite     │
  │   (debounce values, cache TTL) │ DROVE the debugging:            │
  │ wrote the tests to my spec     │   reachability probe, "verify   │
  │                                │   before fix," the curl checks  │
  │                                │ made the trade-offs + can       │
  │                                │   defend every one of them      │
  └────────────────────────────────┴────────────────────────────────┘

  THREE MODES OF DECISION (know which each choice was)
    DELIBERATE        ── my call         e.g. directional cost, no DB
    EVALUATED+ACCEPTED ── AI proposed,    e.g. lazy-deletion heap
                          I judged+took       (matched the spec advice)
    DEFAULTED-TO       ── AI's default,   e.g. exact debounce ms,
                          I didn't deeply     AsyncStorage as the cache
                          evaluate            ◄── riskiest; own it plainly
```

That third mode — "defaulted-to" — is the one that separates honest seniors from everyone else. Owning a defaulted decision *well* is more impressive than pretending every choice was deliberate.

## "Did you use AI to build this?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Did you use AI tools to build this?"            │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Not whether you used it — they assume you did.  │
│   Whether you can be matter-of-fact about it and  │
│   still demonstrate you own what shipped.         │
└─────────────────────────────────────────────────┘

> "Yes, heavily — I built it with Claude Code. The way I'd describe the split: the AI wrote most of the implementation and iterated the UI, but I owned the architecture and designed the algorithm. The build-time/runtime split, the decision to ship a static graph instead of a database, the directional cost model, keeping the heuristic admissible, making BLOCKED finite — those are mine, and I can defend each one. The debugging was mine too — when distant routes failed, I drove the reachability probe that found the disconnected components; I didn't ask the tool to guess. Where I'll be honest: some tactical choices were the AI's defaults that I accepted without deep evaluation — exact debounce timings, using AsyncStorage for the elevation cache. I can defend why they're reasonable, but I won't pretend I evaluated three alternatives for each."

That last sentence is the whole game. You distinguished what you decided from what you accepted from what you defaulted to — and you didn't inflate the defaults into deliberate choices. That's the senior signal.

┃ "The AI wrote most of the code; I owned the architecture and designed the algorithm — and I can defend every decision in it."

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "I used it a bit for boilerplate, but the core logic and the hard parts I wrote myself." | "Yes, heavily — Claude Code wrote most of the implementation. I owned the architecture and the algorithm design, and drove the debugging. Some tactical choices were AI defaults I accepted — I can defend them, but I won't pretend I evaluated each one deeply." |
| **Why it's weak:** "a bit for boilerplate" is the defensive minimization every interviewer has heard. It's almost always untrue in 2026, and they know it. | **Why it works:** honest about the scale of AI use, precise about the division of labor, and distinguishes deliberate from defaulted decisions. Nothing to catch you on. |

## "Can you explain this section line by line?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Pull up the A\* code — walk me through it line   │
│    by line."                                       │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   The trap. Did you ship code you can't read?     │
│   This is where 'I wrote it myself' collapses if   │
│   it was a lie — and where real understanding      │
│   shines.                                          │
└─────────────────────────────────────────────────┘

This is where owning the *understanding* matters more than owning the *authorship*. You don't need to have typed every character — you need to be able to read it cold. For the search engine, you can, because you studied it (that's what the concept files were for).

> "Sure. The search loop pops the lowest-f node from the heap, and the first guard checks if it's already closed — that catches stale entries from lazy deletion, where I pushed a better-priority copy and the old one is still in the heap. If it's the goal, reconstruct and return. Otherwise close it and relax each neighbor: compute tentative cost as cost-so-far plus the edge cost, and if that beats the best known cost to the neighbor, record it and push with priority f = g + h. The thing I'd point out is that the cost function is the only thing that changes between Dijkstra and the grade variants — the loop is identical."

If they pick a section you're *less* fluent in — say the tile-stitching or the MapLibre layer wiring — that's where the honesty move comes back in.

```
  WHEN THEY PICK A SECTION TO READ

  "Explain this section."
        │
        ├─► IT'S THE SEARCH / HEAP / COST
        │     Go deep. This is your strong tier. Read it cold,
        │     name the lazy-deletion guard, the relaxation test,
        │     why cost is the only thing that varies.
        │
        ├─► IT'S THE UI / MAP WIRING
        │     "This is more standard RN/MapLibre wiring — I can
        │      walk the data flow, but I'd be reading it with you
        │      rather than reciting it. The interesting logic is
        │      in the engine."
        │
        └─► IT'S A DEFAULTED TACTICAL BIT (debounce, cache)
              "That value's an AI default I accepted — here's why
               it's reasonable: [debounce keeps geocode under the
               rate policy]. I didn't tune it empirically."
```

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They point at a block you genuinely can't        ║
║   explain — something the AI wrote that you        ║
║   accepted and never fully read.                  ║
║                                                   ║
║   Say:                                            ║
║   "Honestly, I'd be reading this with you — this   ║
║    is a part the AI wrote that I accepted and      ║
║    didn't study closely. Give me a second to read  ║
║    it. [read it.] Okay, it looks like it's doing   ║
║    X — does that match what you're seeing?"        ║
║                                                   ║
║   What this signals: intellectual honesty, and     ║
║   the ability to read unfamiliar code live —       ║
║   which is most of the actual job in 2026.        ║
║                                                   ║
║   Do NOT say:                                      ║
║   "Oh yeah, I definitely wrote that, it's          ║
║    basically just…" then bluff — getting caught    ║
║    bluffing on code you claimed is the single      ║
║    worst outcome of the whole interview. One       ║
║    honest 'I'd read this with you' costs you        ║
║    nothing; one caught bluff costs you the offer.  ║
╚═══════════════════════════════════════════════════╝

## "What did the AI get wrong?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Where did the AI lead you astray?"             │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you supervise the tool or trust it blindly?  │
│   A real "here's where it was wrong and I caught   │
│   it" proves you're driving.                      │
└─────────────────────────────────────────────────┘

> "The elevation throttling is the clearest case. The first instinct in the code — mine and the tool's — was to treat a flat fallback as good enough when the API failed. But that created a real bug: flat regions painted over real grades and the whole map looked green, which silently lies about terrain in a product whose entire point is showing terrain. I caught it because I was looking at the actual output, not just the code, and had to push back: degrade, but *mark* it degraded, and keep degraded regions out of the heatmap. The lesson is that the AI is good at producing plausible code fast and bad at noticing when plausible code violates the product's intent. That judgment is the part I have to bring."

This is the answer that proves you supervise rather than trust — and it's true, you lived it.

▸ The AI is good at plausible code fast; it's bad at noticing when plausible code violates the product's intent. That judgment is what you bring.

## What you'd change

What I'd change about how I *used* AI on flattr is the ratio of evaluated-to-defaulted decisions. The architecture and algorithm I drove deliberately, and those are the parts I can defend cold. But too many tactical choices — cache strategy, debounce timings, some of the data-loading rewrites — I accepted as defaults and only understood deeply *after* they caused a problem. If I started over, I'd spend a little more time evaluating the tool's suggestions at the point of acceptance, especially anything on a failure path, so that fewer decisions land in the "defaulted-to" column. The goal isn't to use AI less — it's to convert more of its output from "accepted" into "evaluated and accepted," because that's the column that holds up under a line-by-line drill.

## One-page summary

**Core claim:** They assume you used AI — the question is whether you own what shipped. Be matter-of-fact, distinguish deliberate / evaluated-and-accepted / defaulted-to decisions, and never bluff on code you can't read.

- **"Did you use AI?":** Yes, heavily (Claude Code). AI wrote most implementation; I owned architecture + algorithm design + debugging. Honest that some tactical choices were accepted defaults.
- **"Explain line by line":** go deep on the engine (your strong tier, read it cold); on UI/defaulted bits, offer to read it together rather than recite. Never claim authorship you can't back.
- **"What did AI get wrong?":** the flat-elevation fallback that masked real grades — caught by watching output, fixed by marking degraded. AI writes plausible code; it misses product-intent violations.
- **The three modes:** deliberate (directional cost, no DB), evaluated-and-accepted (lazy-deletion heap), defaulted-to (debounce ms, AsyncStorage) — own the third honestly.

┃ "I owned the architecture and designed the algorithm — and I can defend every decision in it."
┃ "One honest 'I'd read this with you' costs nothing; one caught bluff costs the offer."

**What you'd change:** Convert more decisions from "defaulted-to" into "evaluated-and-accepted" — spend the evaluation time at the point of acceptance, especially on failure paths, so more of the code holds up under a line-by-line drill.

---

That's the book. Read it in order once, then live in the diagrams and pull quotes. The night before, read only the one-page summaries. And remember the through-line that connects all eight chapters: you built a real graph search engine with a directional cost model, proved it correct, and made it degrade honestly when its free dependencies failed — you used AI to get there fast, and you understand it well enough to own every decision. That's the candidate the interview is looking for.
