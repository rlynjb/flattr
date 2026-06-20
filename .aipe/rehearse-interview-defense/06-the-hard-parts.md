# Chapter 6 — The hard parts

This chapter is reflection, and reflection is where candidates either show range or show fragility. "What was the hardest bug?" "What are you proudest of?" "What's the part you're least sure about?" — these aren't softball questions. They test whether you can be specific under no pressure, whether you can praise your own work without inflating it, and — the one most people get wrong — whether you can name a weakness without collapsing into apology. "The part I'm least confident defending" is a *strong-signal* answer when you handle it right: it tells the interviewer you know exactly where your understanding ends, which is the most senior thing you can demonstrate.

The trick across all three is the same: anchor to something real and specific. A vague "I had some tricky bugs" teaches the interviewer nothing. "Distant routes returned 'no route' even though both endpoints existed, and I traced it to disconnected graph components with a reachability probe" — that's a story, and you have it, because you lived it.

```
  CONFIDENCE MAP OF THE CODEBASE — defend accordingly

  HIGH CONFIDENCE (lead here, go deep)
  ┌──────────────────────────────────────────────┐
  │ ★ A* / search() — one engine, four variants   │  proudest
  │ ★ admissibility proof (A* == Dijkstra cost)    │
  │ ★ directional cost (A→B ≠ B→A)                 │
  │ ★ lazy-deletion heap + invariant tests        │
  │ ★ honest degradation (elevation, BLOCKED)     │  hardest bug lived here
  └──────────────────────────────────────────────┘

  MEDIUM CONFIDENCE (can defend, name the edges)
  ┌──────────────────────────────────────────────┐
  │ ~ bidirectional A* balanced potential          │  subtle, least confident
  │ ~ tile merge/stitch correctness                │
  │ ~ on-device pipeline re-run                     │
  └──────────────────────────────────────────────┘

  LOWER CONFIDENCE (own the gap, don't bluff)
  ┌──────────────────────────────────────────────┐
  │ · RN/Hermes runtime internals                  │
  │ · MapLibre native render pipeline              │
  │ · distributed / multi-user scale (no server)   │
  └──────────────────────────────────────────────┘
```

Know which tier a question lands in *before* you answer. Go deep in the top tier; name the edges in the middle; own the boundary in the bottom.

## "What was the hardest bug?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Tell me about a hard bug you debugged."         │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you debug systematically — evidence, root    │
│   cause, fix — or flail? The METHOD matters more  │
│   than the bug.                                   │
└─────────────────────────────────────────────────┘

> "Routing between distant points returned 'no route,' even though both the start and the end clearly existed on the map. The tempting fix was to mess with the search, but I didn't want to guess, so I instrumented instead — I added a reachability probe: from the start node, BFS the whole merged graph and count how many nodes are reachable, and check whether the end node is in that set. The probe said: both endpoints exist, but the end is *not reachable* from the start. That was the root cause — they were in two disconnected components. The tile loader only fetched tiles near the viewport, so a start and a destination far apart became two separate islands with no loaded corridor between them. The fix was to load the bounding-box corridor between the two endpoints and stitch it in, so they share one connected component. What I'd underline is the method: I added evidence before I touched the fix, and the evidence pointed straight at the cause."

This is a textbook systematic-debugging story and it's *yours*. The method — instrument, find root cause, then fix — is exactly what senior interviewers want to hear, and the reachability probe is a concrete, memorable detail.

┃ "I added evidence before I touched the fix — the reachability probe pointed straight at 'disconnected components.'"

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "There was a bug where routes didn't work sometimes, and I tried a few things and eventually figured out it was a graph issue and fixed it." | "Distant routes returned 'no route' though both endpoints existed. I added a reachability probe — BFS from start, is end in the set? It wasn't: disconnected components, because tiling only loaded the viewport. Fix: load and stitch the corridor between endpoints." |
| **Why it's weak:** "tried a few things and eventually figured out" is the opposite of method. It describes flailing and getting lucky. | **Why it works:** names the symptom precisely, shows instrumentation-before-fix, names the root cause and the mechanism behind it. Method visible throughout. |

## "What are you proudest of?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "What part of this are you most proud of?"      │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you know what's actually hard vs what just   │
│   took time? Pride in the right thing signals     │
│   taste.                                          │
└─────────────────────────────────────────────────┘

> "The search engine — specifically that it's *one* `search()` function that's Dijkstra, A\*, grade-A\*, and directed-A\* depending on the cost and heuristic you pass it. Dijkstra is literally A\* with a zero heuristic. I'm proud of that because it's the senior version of the algorithm: the generic traversal and the domain intelligence are cleanly separated — the search loop never mentions grade, the cost function never mentions search. And I can *prove* it's correct, not just claim it: the heuristic is admissible because every edge cost is at least its length and straight-line distance never overestimates, so A\* returns the exact same cost as Dijkstra — which I test against directly. That proof-backed correctness is the part I'd put my name on."

Pride in the *separation of concerns* and the *provable correctness*, not "I used A\*," is what shows taste. You're proud of the design, not the feature.

▸ Be proud of the design decision, not the feature. "I separated traversal from cost and can prove the heuristic admissible" beats "I implemented A\*."

## "What's the part you're least confident defending?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "What part would you be least comfortable if I   │
│    drilled into it?"                               │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Self-awareness. Can you name a real weak spot    │
│   without either hiding it or falling apart? This  │
│   answer is a senior signal when handled right.   │
└─────────────────────────────────────────────────┘

> "The balanced potential in bidirectional A\*. The forward and backward searches each need a heuristic, and you can't just use plain straight-line distance on both sides — they won't be *consistent* with each other, and the rule for when the two frontiers meet can then return a non-optimal path. The fix is a balanced potential — each side uses half the difference of the two heuristics — and I have it implemented and tested against the optimal cost. But if you asked me to re-derive *why* that specific formula keeps both sides consistent from first principles, I'd have to think carefully and might not get the proof airtight on the spot. I know it's correct because the test pins it to directed-A\*'s cost, and I know the shape of why — but the formal consistency argument is the edge of my understanding here."

This is the answer that *gains* you credibility. You named a genuinely subtle thing, showed you understand it operationally (it's tested, you know the failure mode), and drew the exact line where your knowledge gets shaky. That's senior.

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They take the bidirectional answer as an         ║
║   invitation and ask you to prove the              ║
║   consistency of the balanced potential on the     ║
║   whiteboard, right now.                          ║
║                                                   ║
║   Say:                                            ║
║   "Let me set it up and you tell me if I drift.    ║
║    The potential on the forward side is            ║
║    (h_goal − h_start)/2, the reverse is its        ║
║    negation, so an edge's reduced cost is          ║
║    consistent across both searches — that's what   ║
║    makes the topF+topR ≥ mu stopping rule sound.   ║
║    The full proof that reduced costs stay          ║
║    non-negative I'd want to work through carefully  ║
║    rather than wave at — can we do it together?"   ║
║                                                   ║
║   What this signals: you'll attempt the hard       ║
║   thing, you know where the rigor gets shaky, and  ║
║   you invite collaboration instead of bluffing.   ║
║                                                   ║
║   Do NOT say:                                      ║
║   "It just balances the two sides so it works" —   ║
║   restating the name as if it were an explanation  ║
║   is the collapse. Either attempt the mechanism    ║
║   or cleanly say where the proof exceeds you.      ║
╚═══════════════════════════════════════════════════╝

## What you'd change

The hard-parts reflection I'd carry forward isn't about a line of code — it's about *when* I reached for instrumentation. The "no route" bug got solved fast because I probed before fixing, but the all-green elevation problem took several rounds because at first I *assumed* it was throttling and guessed at fixes, instead of immediately checking the API with a curl and adding the degraded-region diagnostic. Both bugs had the same right method available; I only used it cleanly on one. What I'd change is making "instrument first, always" the reflex from the first symptom, not the third — the times I followed it, the root cause fell out in one step.

## One-page summary

**Core claim:** Anchor every reflection to a specific, real story, and treat "least confident" as a strength — naming exactly where your understanding ends is the most senior signal you can give.

- **Hardest bug:** distant routes returned "no route"; a reachability probe (BFS from start) showed the endpoints were in disconnected components from viewport-only tiling; fixed by loading+stitching the corridor. Method: evidence before fix.
- **Proudest:** one `search()` for Dijkstra/A\*/directed — clean separation of traversal from cost — with a *provable* admissible heuristic (A\* == Dijkstra cost in tests).
- **Least confident:** the bidirectional balanced-potential consistency proof — implemented and tested, but the formal derivation is the edge of my understanding. (Named honestly, attempted collaboratively.)
- **Confidence tiers:** deep on A\*/heap/degradation; name edges on bidirectional/tiling; own the gap on RN runtime internals and multi-user scale.

┃ "I added evidence before I touched the fix."
┃ "I'm proud of the design — traversal separated from cost, with a provable heuristic — not just that I used A\*."

**What you'd change:** Make "instrument first" the reflex from the first symptom, not the third — the bugs I probed immediately resolved in one step.
