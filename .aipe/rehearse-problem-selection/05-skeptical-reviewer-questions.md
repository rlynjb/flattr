# Skeptical reviewer questions

This is the file to rehearse out loud, because the questions a skeptical reviewer throws at a problem proposal are the same whether the problem is flattr or a feature at work: who asked for this, why now, why you, what does success look like, and what happens if you're wrong. The skill is answering each with conviction where you have evidence and candor where you don't — never bluffing a number you don't have.

```
  THE REVIEW ROOM — the five probes, and where each lands

  "who actually wants this?"  ──► honesty: demand is inferred,
                                   here are the discovery questions
  "why not use OSRM?"         ──► the goal is owning the algorithm,
                                   and grade-as-directional fights libs
  "isn't this a toy?"         ──► yes at city scale, no at the premise:
                                   the engine is real and provably correct
  "how do you know it works?" ──► A* == Dijkstra (oracle), bench numbers
  "what if you're wrong?"     ──► cheap to be wrong: one neighborhood,
                                   free data, no sunk infra
```

The pattern across all five: lead with the honest verdict, then the evidence. Don't defend; answer.

## "Who actually wants this? Show me the demand."

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Is there real demand, or did you build         │
│    something you thought was cool?"               │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Will you fake market evidence, or own that      │
│   demand is unproven and name how you'd find out? │
└─────────────────────────────────────────────────┘

> "I'll be straight: this repo proves the problem is *technically* solvable, not that it's *wanted*. There's no usage data — it's a prototype. The demand case is inference: scooter riders, wheelchair users, and stroller commuters have a real reason to avoid grade, and no mainstream router offers a flat-first mode. But before I'd spend real resources, I'd run discovery — interview target users on whether they actively avoid hills today and whether they'd switch apps for it. I'm not going to hand you a fake adoption number."

That answer *wins trust* precisely because it refuses to overclaim. A fabricated "studies show 40% of riders…" would collapse on the first follow-up.

## "Why not just use OSRM or Valhalla?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Production routers exist. Why reinvent this?"  │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Build-vs-buy judgment. Did you reinvent for ego │
│   or for a reason?                                 │
└─────────────────────────────────────────────────┘

> "Two reasons. The directional grade cost — uphill penalized, downhill free, so A→B ≠ B→A — doesn't fit those engines' distance/time cost models cleanly. And the explicit goal of this project is to own the graph algorithm, not call a library: I built the search, the heap, and proved the heuristic optimal. If this were a funded product on a deadline, I'd reach for OSRM and accept that it can't do directional grade naturally. For a project whose point is the algorithm, hand-rolling was right — and I know the cost, which is no city-scale machinery."

## "Isn't this just a toy? It only covers one neighborhood."

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "This doesn't even cover a city. Is it real?"   │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Can you distinguish 'scoped' from 'unserious'?  │
└─────────────────────────────────────────────────┘

> "At city scale, yes, it's a prototype — no spatial index, no contraction hierarchies. At the level of the premise, no: the engine is real and provably correct — A\* returns the exact same cost as Dijkstra in the tests, with a genuine directional cost model and an honest fallback that distinguishes 'too steep' from 'no route.' The neighborhood scope is deliberate sequencing: it validates flat-first routing without spending months on coverage that would teach me nothing about whether anyone wants it. Toy implies it doesn't work. It works — on one neighborhood, on purpose."

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "It's just an MVP, I'd scale it later." | "City scale is a prototype; the premise is proven — provably-optimal routing with directional grade. The neighborhood scope is sequencing: validate demand before spending months on coverage." |
| **Why it's weak:** "just an MVP" is a shrug that concedes the point. | **Why it works:** separates the scaling gap from the working core, and frames the scope as a *decision* with a reason. |

## "How do you know the routing is even correct?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "How do you know the paths are right?"          │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Evidence or vibes?                               │
└─────────────────────────────────────────────────┘

> "An optimality oracle. A\* is tested against Dijkstra on the same graph and must return the *exact same cost* — if they diverge, the heuristic is inadmissible and the test fails. That's a provable correctness signal, not a vibe. The bench harness also measures that A\* expands four to six times fewer nodes than Dijkstra, so the optimization is real and re-runnable, not claimed."

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They ask for the thing you genuinely don't have: ║
║   "What's your retention? CAC? Conversion?" — real ║
║   product metrics for a project with no users.    ║
║                                                   ║
║   Say:                                            ║
║   "I don't have those — there are no users, it's   ║
║    a prototype. I'm not going to invent them. What  ║
║    I can give you is the technical evidence the     ║
║    engine works and the discovery plan I'd run to   ║
║    get real demand numbers before investing."      ║
║                                                   ║
║   What this signals: you know which numbers are    ║
║   real and you won't manufacture the ones that     ║
║   aren't — the exact trait a reviewer is testing  ║
║   for when they ask.                              ║
║                                                   ║
║   Do NOT say:                                      ║
║   "Early signs are promising and we project…" —    ║
║   projecting metrics for a userless prototype is   ║
║   the fastest way to lose the room's trust.       ║
╚═══════════════════════════════════════════════════╝

## "What if you're wrong about the demand?"

> "Then I've spent a bounded amount of time on one neighborhood with free data and no infrastructure to unwind — there's no server, no database, no sunk cost beyond my time. Being wrong here is cheap, which is exactly why a neighborhood prototype is the right way to test an inferred premise before betting more."

▸ Being cheap to be wrong is a feature of the scope, not an apology for it.

## One-page summary

**Core claim:** Answer every skeptical probe with the honest verdict first, then the evidence — own that demand is unproven, that city scale is a gap, and that the engine is provably correct.

- **"Who wants this?":** demand is inferred, not measured; here's the discovery plan. (Don't fake a market number.)
- **"Why not OSRM?":** directional grade fights their cost model + the goal is owning the algorithm; I'd buy if it were a funded product.
- **"Isn't it a toy?":** city scale is prototype; the premise is proven — provably-optimal routing, real directional cost. Scope is sequencing.
- **"How do you know it works?":** A\* == Dijkstra oracle + bench harness numbers.
- **"What if you're wrong?":** cheap to be wrong — one neighborhood, free data, no sunk infra.

┃ "I'm not going to hand you a fake adoption number."
┃ "Toy implies it doesn't work. It works — on one neighborhood, on purpose."
