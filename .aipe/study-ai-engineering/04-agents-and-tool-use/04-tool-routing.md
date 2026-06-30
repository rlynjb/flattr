# Tool routing — flattr is all heuristic, no LLM router

**Industry name(s):** tool routing (heuristic vs LLM-decided).
**Type:** Industry standard.

## Zoom out — flattr routes everything heuristically; there's no model picking a path

Tool routing is the choice of *how* you decide which tool (or path) to
take: a fast deterministic rule (heuristic) or letting an LLM read the
input and pick (model-decided). Production systems often put a heuristic
at the front and fall back to an LLM. flattr is the pure heuristic case,
all the way down — every routing decision it makes is a deterministic rule
or function, with no LLM in the fallback slot because there's no LLM at
all.

```
  Zoom out — flattr's routing is 100% heuristic

  ┌─ UI/engine decisions (all deterministic) ───────────────┐
  │  which node? ── nearestNode (haversine)     nearest.ts:5│
  │  which path? ── A* over a cost function      astar.ts   │
  │  how penalized? ── penalty(g,max) thresholds cost.ts:16 │
  │  ★ no LLM router · no model-decided fallback            │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** input → heuristic decision (nearest / cost / penalty) →
  routing.
- **Axis — what decides the route?** LLM routing: a model reads ambiguous
  input and picks. Heuristic routing: a fixed rule decides from surface
  form. flattr is heuristic at every layer — `haversine` picks the node,
  the cost function picks the path, threshold tables pick the grade band.
  The axis never reaches a model.
- **Seam:** the cost function `penalty` (`cost.ts:16`) — flattr's most
  decision-like point, where grade steers path choice. It's a
  deterministic function, the kind of place an ML score *could* later
  attach (see below), but today it's pure heuristic.

## How it works

### Move 1 — the mental model

You know the two ways to dispatch a request: a `switch` on a known field
(fast, deterministic, you wrote the cases) versus asking something smarter
to classify it (slow, flexible, handles ambiguity). Tool routing is that
fork. The production pattern is heuristic-front, LLM-back: the `switch`
handles the obvious cases cheaply, the model handles the ambiguous ones.
flattr only ever has the `switch` side — every decision is a rule.

```
  Pattern — heuristic vs LLM routing (flattr is all heuristic)

  heuristic:  input ──rule──► path        (fast, deterministic) ← flattr
  LLM:        input ──model──► path        (flexible, for ambiguity)
  production: heuristic front → LLM fallback
              flattr: heuristic front → (no fallback, no LLM)
```

### Move 2 — the walkthrough

**flattr's routing decisions are all functions.** The path choice is
steered by a deterministic cost, `cost.ts:16`:

```ts
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;                         // downhill/flat: free
  if (g > max) return BLOCKED;                  // over max: blocked (finite)
  const half = 0.5 * max;
  if (g <= half) return k1 * g;                 // moderate: linear
  return k2 * (g - half) ** 2 + k1 * half;      // steep: quadratic
}
```

This is the rule that "routes" A* toward flatter edges — and it's pure
arithmetic on thresholds, no model. Likewise `nearestNode` picks the start
node by `haversine` (`nearest.ts:5`), and grade bands come from a
threshold table in `classify.ts`. Every routing decision in flattr is a
deterministic function of its inputs.

```
  Layers-and-hops — heuristic routing throughout (no model)

  ┌─ input ───┐ rule: haversine   ┌─ nearest.ts ──────────┐
  │tap/point  │ ──────────────────►│ pick nearest node     │ nearest.ts:5
  └───────────┘                    └──────────┬─────────────┘
                  rule: cost fn               ▼
  ┌─ engine ──┐ ───────────────────► A* picks path by penalty(g,max) cost.ts:16
  │astar.ts   │                      (deterministic — no LLM router)
  └───────────┘
```

**The boundary condition — the one place a model could attach.** `penalty`
is the documented ML attach point: you could replace the hand-tuned
quadratic with a learned grade-aversion score. But there's a hard
constraint — the function must stay **≥ 0 and monotone**, and `BLOCKED`
must stay **finite** (`cost.ts:5`), or A*'s admissibility breaks and the
search stops returning optimal paths. So even a *learned* router here
isn't an "LLM router" picking tools; it's a learned cost score inside a
deterministic search, bound by admissibility. That distinction matters: it
stays heuristic-shaped routing, not model-decided dispatch.

### Move 3 — the principle

Routing is about matching decision cost to decision difficulty: cheap
deterministic rules for predictable cases, a model only when intent is
genuinely ambiguous from surface form. flattr's decisions (nearest node,
cheapest path, grade band) are all computable from the inputs, so
heuristic routing is correct everywhere and a model would add cost and
nondeterminism for no gain. The principle: don't put a model on a decision
a function can make — and if you ever learn the cost function, keep it
inside the deterministic search's invariants.

## Primary diagram

```
  flattr's routing — heuristic at every decision

  ┌─ decisions (all deterministic) ──────────────────────────┐
  │ node:  nearestNode (haversine)            [nearest.ts:5]  │
  │ path:  A* minimizing cost                 [astar.ts]      │
  │ grade: penalty(g,max) threshold arithmetic [cost.ts:16]   │
  │ band:  classify threshold table           [classify.ts]   │
  └──────────────────────────────────────────────────────────┘
   ★ penalty() is the ML attach point — but must stay ≥0/monotone,
     BLOCKED finite (cost.ts:5): a learned COST, not an LLM router
```

## Elaborate

The heuristic-front / LLM-back routing pattern is everywhere in production
LLM systems — it's how you keep the fast path fast and pay the model only
for ambiguity. flattr is the pure-heuristic end of that spectrum: every
decision is a function, and the one learnable point (`penalty`) stays
bound by A*'s admissibility, so even ML there is a cost score, not a
router. The transferable judgment is recognizing which decisions are
surface-computable (route heuristically) versus genuinely ambiguous (route
with a model) — flattr's are all the former.

## Project exercises

### B-ROUTE.1 — learned grade-aversion score inside penalty()

- **Exercise ID:** B-ROUTE.1
- **What to build:** swap `penalty`'s hand-tuned quadratic for a learned
  grade-aversion score, while *proving* it stays ≥ 0 and monotone and
  keeps `BLOCKED` finite — a learned cost inside deterministic routing.
- **Why it earns its place:** it makes the heuristic-vs-learned boundary
  concrete and forces the A*-admissibility invariant to be respected.
- **Files to touch:** `features/routing/cost.ts:16` (`penalty`);
  `features/routing/cost.test.ts` (assert ≥0/monotone/finite-BLOCKED).
- **Done when:** the learned score routes A* and a test pins the
  admissibility invariants.
- **Estimated effort:** one to two days (the invariant proof is the work).

## Interview defense

**Q: How does flattr route — heuristic or LLM?** Answer: 100% heuristic.
The node is chosen by `haversine` (`nearestNode`, `nearest.ts:5`), the
path by A* minimizing a cost, and the grade steering by `penalty(g,max)`
(`cost.ts:16`) — all deterministic functions, no LLM. The one place a
model could attach is `penalty`, but it must stay ≥0/monotone with
`BLOCKED` finite (`cost.ts:5`) for A* admissibility, so that's a *learned
cost*, not an LLM router. Load-bearing point: flattr's decisions are
surface-computable, so heuristic routing is correct everywhere.

```
  haversine + cost fn + thresholds = all heuristic routing (no model)
```

Anchor: *"flattr routes entirely with functions — nearest by haversine,
path by cost — and even the ML attach point (penalty) stays a learned
cost inside A*, never an LLM router."*

## See also

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — the fixed chain that needs no router.
- [02-tool-calling.md](02-tool-calling.md) — the tools a router would dispatch to.
- [../01-llm-foundations/07-heuristic-before-llm.md](../01-llm-foundations/07-heuristic-before-llm.md) — the heuristic-first principle.
