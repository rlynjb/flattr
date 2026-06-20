# Chapter 7 — The counterfactuals

"What would you do differently?" is a gift, and most candidates fumble it two ways. They either say "nothing, I'm happy with it" — which reads as no self-awareness — or they apologize for everything, which reads as no conviction. The senior move is in between and specific: name two or three decisions you'd genuinely reconsider, say what you'd do instead and why, and — critically — *don't* manufacture regret for the decisions that were right. Volunteering a real counterfactual before being asked is one of the strongest signals you can send; inventing a fake one to seem humble is one of the weakest.

The discipline for this chapter is separating "I'd change this" from "this was right and I'd keep it." Hand-rolling the router was right — don't apologize for it. Shipping a static graph was right for the access pattern. But the *internal trust boundary*, the *elevation fidelity ceiling*, the *render-thread coupling*, and the *thrash in the data-loading design* — those are real, and owning them makes the right calls more credible by contrast.

```
  COUNTERFACTUALS MATRIX — keep vs change

  DECISION                      VERDICT      WHAT I'D DO DIFFERENTLY
  ──────────────────────────────────────────────────────────────────
  hand-rolled A* engine         ✓ KEEP       nothing — it's the point
  static graph, no DB           ✓ KEEP       right for read-only access
  directional grade cost        ✓ KEEP       the differentiator
  ──────────────────────────────────────────────────────────────────
  graph.json unvalidated        ✗ CHANGE     schema + version, fail fast
  Open-Meteo as only source     ✗ CHANGE     keep free tier + paid opt-in
  search on render thread       ~ RECONSIDER async/worker boundary day 1
  data-loading design           ~ RECONSIDER design the seam up front,
   (tiles → corridor → viewport)             not by iteration under fire
  ──────────────────────────────────────────────────────────────────
  rule: volunteer the ✗ and ~ rows. NEVER fake a regret on a ✓ row.
```

The top three rows are your conviction; the bottom four are your self-awareness. A strong counterfactual answer walks both halves.

## "What would you do differently if you started today?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Starting over, what would you change?"          │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Self-awareness with conviction. Can you name     │
│   real regrets AND defend what you'd keep, without │
│   collapsing into "everything could be better"?   │
└─────────────────────────────────────────────────┘

> "A few things, and I'll be specific. First, the graph artifact: `graph.json` is loaded and cast straight to the type with no validation and no schema version. I'd add a validate-on-load check that fails fast with a clear message, because right now a bad artifact surfaces as a cryptic crash deep in the search. Second, elevation: I'd keep Open-Meteo as the free default but add the paid Google provider behind the same interface from the start, because the 90-meter DEM is coarse enough that it undercuts the product's whole point — showing terrain honestly. Third, and this is more of a process regret than a code one: my data-loading layer went through three designs — per-tile loading, then a route corridor, then a whole-viewport fetch — because I designed it by reacting to bugs instead of thinking through the loading boundary up front. What I'd keep, firmly: the hand-rolled engine, the static-graph-no-database call, and the directional cost. Those were right and I'd make them again."

The shape that lands: three specific changes, then an explicit "what I'd keep and why." You ended on conviction, not apology.

┃ "What I'd keep, firmly: the hand-rolled engine, the no-database call, the directional cost. Those were right."

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "Honestly there's a lot I'd improve — the code could be cleaner, I'd add more tests, maybe use a better elevation API, refactor some things…" | "Three specific things: validate the graph artifact on load, add a paid elevation provider behind the existing interface for fidelity, and design the data-loading boundary up front instead of by iteration. What I'd keep: the hand-rolled engine, no database, directional cost — those were right." |
| **Why it's weak:** "a lot I'd improve" + "refactor some things" is content-free humility. It names nothing and signals you can't prioritize. | **Why it works:** named, prioritized, each with a reason; and it ends on what you'd keep, which shows judgment, not just regret. |

## "Is there a decision you'd defend that looks questionable?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Anything you did that others might disagree     │
│    with, but you'd stand by?"                      │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Conviction. Will you defend a contrarian-looking │
│   call with a real reason, or fold the moment      │
│   it's questioned?                                 │
└─────────────────────────────────────────────────┘

> "Hand-rolling the router instead of using OSRM or GraphHopper. On the surface that looks like reinventing a wheel that production systems already solved. I'd stand by it: the directional grade cost doesn't fit those engines' cost models cleanly, and more importantly the algorithm was the entire learning goal — I wanted to own the search end to end, prove the heuristic admissible, and build the heap myself. If this were a product with a deadline and a team, I'd reach for the library. As a project to demonstrate I can build the thing, not just call it, hand-rolling was the right call. I know what I gave up — contraction hierarchies, city scale — and I'd make the trade again for this context."

The reason this works as a counterfactual answer: you defended a decision that *looks* wrong, gave the criterion (learning goal + cost-model fit), and bounded it ("if it were a product with a deadline, I'd use the library"). Conviction with a clear boundary, not stubbornness.

```
  IF THEY PRESS THE COUNTERFACTUALS

  "I'd validate the artifact / add a paid provider / design loading up front."
        │
        ├─► "Why didn't you do those already?"
        │     "Each was the right deferral at MVP: I control the build
        │      so a bad artifact never shipped; the free DEM was good
        │      enough to prove the concept; the loading design only
        │      needed three iterations because the requirements moved."
        │
        ├─► "Which would you do first?"
        │     "Validate-on-load. Cheapest, and it turns the worst
        │      failure mode — cryptic mid-search crash — into a clear
        │      one. Highest safety-per-effort."
        │
        └─► "Anything you'd NOT change?"
              "The engine, the static graph, the directional cost.
               I'd make all three again. That's not me being precious
               — they match the problem."
```

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They propose a counterfactual you haven't        ║
║   considered — "would you have used a graph         ║
║   database like Neo4j for this?" — and you don't   ║
║   have a worked opinion on it.                     ║
║                                                   ║
║   Say:                                            ║
║   "I haven't seriously evaluated a graph database   ║
║    here, so I won't pretend I have a strong take.   ║
║    My instinct is it's the wrong fit — my access    ║
║    pattern is load-the-whole-graph-once and         ║
║    traverse in memory, with no writes, so the       ║
║    query engine and storage Neo4j gives me would    ║
║    be overhead I don't use. But that's reasoning    ║
║    from the access pattern, not from having run     ║
║    Neo4j — if you've seen it fit this shape, I'd    ║
║    want to hear why."                             ║
║                                                   ║
║   What this signals: you reason from first          ║
║   principles (the access pattern) even on an       ║
║   unfamiliar tool, and you don't fake a take you   ║
║   don't have.                                     ║
║                                                   ║
║   Do NOT say:                                      ║
║   "Yeah Neo4j would probably be better for graphs"  ║
║   — agreeing reflexively because it has 'graph' in  ║
║   the name is the opposite of the access-pattern   ║
║   thinking that's your strength.                  ║
╚═══════════════════════════════════════════════════╝

▸ The senior-engineer move is to volunteer what you'd reconsider before being asked — and to refuse to manufacture regret for the calls that were right.

## What you'd change

The meta-lesson from flattr's counterfactuals is about *when* design happens. The decisions I'm most confident in — the engine, the cost model, the storage shape — I designed deliberately, up front, because I understood the problem. The decisions I'd redo — the data-loading boundary especially — I designed *reactively*, patching each bug into a new shape until it stabilized after three rewrites. The code I planned is the code I'd keep; the code I iterated into existence is the code I'd change. If I started over, the single highest-leverage move would be to treat the runtime data-loading seam as a first-class design problem on day one, the same way I treated the search engine — because the parts I designed on purpose are the parts that held up.

## One-page summary

**Core claim:** Walk both halves — name 2-3 real changes with reasons, then defend what you'd keep with conviction. Never fake a regret for a decision that was right.

- **Would change:** validate `graph.json` on load (schema + version, fail fast); add the paid Google elevation provider behind the existing interface for fidelity; design the data-loading boundary up front instead of through three reactive rewrites.
- **Would keep:** the hand-rolled engine, the static-graph-no-database call, the directional cost — all matched to the problem.
- **Contrarian call defended:** hand-rolling over OSRM — right for a learning project (own the algorithm, prove admissibility); I'd use the library if it were a product with a deadline.
- **Do first:** validate-on-load — cheapest fix, turns the worst failure mode into a clear one.

┃ "The code I planned is the code I'd keep; the code I iterated into existence is the code I'd change."
┃ "I know what I gave up by hand-rolling — and I'd make the trade again for this context."

**What you'd change:** Treat the runtime data-loading seam as a first-class design problem from day one — the parts I designed deliberately held up; the part I iterated into existence is the one I'd redo.
