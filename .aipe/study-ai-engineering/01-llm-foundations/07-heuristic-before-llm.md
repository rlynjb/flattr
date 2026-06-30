# Heuristic before LLM

**Industry name(s):** heuristic-before-LLM / deterministic-first routing /
the cheap-path-first pattern. **Type:** Industry standard architecture
discipline.

## Zoom out — where this would sit in flattr

The pattern: don't call a model for work a deterministic rule already
nails. Keep the cheap, exact, testable path as the default; reserve the
LLM for the genuinely ambiguous cases (parse fuzzy NL, write prose). flattr
is the *poster child for the heuristic side* — its router is exact A*, its
grade classification is a threshold table, its cost function is a
hand-tuned formula. There is **zero LLM**, and that's correct: none of
flattr's current work is ambiguous enough to need one. This file teaches
the pattern flattr already embodies and names the two seams where an LLM
would earn its slot.

```
  Zoom out — flattr is already the deterministic-first default

  ┌─ HEURISTIC core (flattr TODAY — keep it) ───────────────┐
  │ directedAstar  ─► exact path        (cost.ts CostFn)     │
  │ classifyAbs    ─► color band        (if/else, classify.ts)│
  │ penalty()      ─► grade cost        (formula, cost.ts:16)│
  └────────────────────────────┬─────────────────────────────┘
              only fall to a model for AMBIGUOUS cases ▼
  ┌─ LLM lane (NOT BUILT — narrow) ─────────────────────────┐
  │ • parse "avoid hills near park" → filter (INPUT seam)    │
  │ • describe RouteSummary as prose (OUTPUT seam)           │
  └──────────────────────────────────────────────────────────┘
```

flattr has **no LLM and needs none today**. The lesson: flattr already
lives on the right side of this pattern — the skill is knowing the two
spots where crossing to the LLM lane is justified.

## Structure pass

- **Layers:** deterministic core (router, classify, cost) → optional LLM
  lane (parse, describe) → UI.
- **Axis — determinism vs ambiguity:** the core handles inputs with a
  *right answer* (shortest grade-aware path, which color a grade is). An
  LLM handles inputs with *no closed-form rule* (free-text intent, natural
  phrasing). The axis is "is there an exact rule?" — if yes, never call a
  model.
- **Seam:** the flip is at the *edges* of the deterministic core. Input
  edge: where fuzzy NL would enter (near `geocode.ts:9` /
  `MapScreen.tsx:182`). Output edge: where numbers become prose
  (`summary.ts:5`). Everything between stays heuristic.

## How it works

### Move 1 — the mental model

You know "don't reach for a regex when `String.includes` works, and don't
reach for a parser when a regex works." Heuristic-before-LLM is the next
rung: don't reach for a model when a rule, table, or formula works. The
model is the *most* expensive, least testable, least deterministic tool —
last resort, not first.

```
  Pattern — escalate only when the cheaper tool can't decide

  exact rule? ──yes──► use it (A*, threshold, formula)   ← flattr lives here
       │ no
       ▼
  small heuristic? ──yes──► use it
       │ no
       ▼
  genuinely ambiguous? ──► LLM   (parse NL / write prose)
```

### Move 2 — the walkthrough

**flattr's core is all heuristic — and that's right.** Three examples:

```ts
// cost.ts:16 — a FORMULA, not a model
export function penalty(g, max, k1 = 0.4, k2 = 1.0) {
  if (g <= 0) return 0;            // downhill/flat: free
  if (g > max) return BLOCKED;     // over max: blocked (finite, cost.ts:5)
  const half = 0.5 * max;
  if (g <= half) return k1 * g;    // moderate: linear
  return k2 * (g - half) ** 2 + k1 * half;  // steep: quadratic
}
```

```ts
// classify.ts:11 — a THRESHOLD TABLE, not an ML classifier
export function classifyAbs(absGradePct, bands = DEFAULT_BANDS): Band {
  const g = Math.abs(absGradePct);
  if (g <= bands.greenMax) return "green";   // if/else over {greenMax:4, yellowMax:8}
  if (g <= bands.yellowMax) return "yellow";
  return "red";
}
```

Each has an exact right answer. An LLM here would be slower, costlier,
non-deterministic, and *worse* — it would approximate a formula you can
just write. **Never call `classify.ts` ML.** It is `if/else`.

```
  Layers-and-hops — heuristic core, LLM only at the fuzzy edges

  INPUT edge          ┌─ DETERMINISTIC CORE ─┐         OUTPUT edge
  (fuzzy NL?)         │ penalty()  classifyAbs│         (prose?)
  ┌─────────┐ filter  │ directedAstar         │ summary ┌─────────┐
  │ LLM parse│ ──────► │ (exact, tested)       │ ──────► │LLM describe│
  └─────────┘         └───────────────────────┘         └─────────┘
   geocode.ts:9 region                                  summary.ts:5
```

**Where an LLM would actually earn its slot.** Two spots, both ambiguous:
parsing free-text intent ("flatter route, avoid the bridge") into a filter
at the input edge, and turning `RouteSummary` into a sentence at the output
edge. Both have no closed-form rule. Everything else stays heuristic.

### Move 3 — the principle

The deterministic path is the default; the LLM is an escalation for inputs
with no exact rule. flattr already gets this right — its core is exact and
its would-be model lives only at the fuzzy edges. The engineering skill is
resisting the urge to model-ify work a formula already solves.

## Primary diagram

```
  Heuristic-before-LLM — flattr already lives on the right side

  ┌─ KEEP DETERMINISTIC (today) ────────────────────────────┐
  │ penalty (cost.ts:16) · classifyAbs (classify.ts:11)      │
  │ directedAstar — exact, testable, $0, deterministic       │
  └────────────────────────────┬─────────────────────────────┘
            escalate ONLY for ambiguous edges ▼
  ┌─ LLM LANE (NOT BUILT — narrow, justified) ──────────────┐
  │ in:  fuzzy NL → filter   (near geocode.ts:9)             │
  │ out: RouteSummary → prose (summary.ts:5)                 │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

This is the single most under-applied discipline in AI engineering: teams
LLM-ify deterministic work and inherit latency, cost, and flakiness for no
gain. The strong version is a *router*: a cheap rule decides whether the
request even needs the model. flattr's whole core is that cheap rule
already; the work is keeping it that way and only adding the model at the
two fuzzy seams. dryrun applies the same escalation (on-device heuristic /
model, cloud only when needed).

## Project exercises

### B-HB.1 — document the escalation boundary

- **Exercise ID:** B-HB.1
- **What to build:** a short `ROUTING.md`-style note (or code comment
  block) at the cost/classify modules stating "deterministic by rule; LLM
  only at the parse and describe edges," with the two seam file:line refs.
- **Why it earns its place:** it codifies the pattern flattr embodies so a
  future contributor doesn't model-ify the formula.
- **Files to touch:** `features/routing/cost.ts:16`;
  `features/grade/classify.ts:11`.
- **Done when:** the note names both seams and forbids LLM-ifying the core.
- **Estimated effort:** 30 min.

### B-HB.2 — guard before escalating

- **Exercise ID:** B-HB.2
- **What to build:** a `needsLLM(text): boolean` heuristic at the input
  edge that returns false for inputs the existing geocode path already
  handles (plain addresses), so the model is only called for genuinely
  fuzzy intent.
- **Why it earns its place:** it builds the cheap-path-first router
  explicitly at the real input seam.
- **Files to touch:** `pipeline/geocode.ts:9`;
  `mobile/src/MapScreen.tsx:182` (resolve site).
- **Done when:** plain addresses skip the model; only fuzzy intent
  escalates; a test covers both.
- **Estimated effort:** 1–2 hrs.

## Interview defense

**Q: Where does flattr use a model, and why so little?** Answer: It uses
none, correctly. The router is exact A*, grade classification is a
threshold table (`classify.ts` — `if/else`, not ML), and the cost
function is a tuned formula (`cost.ts:16`). None of that is ambiguous, so a
model would only add latency, cost, and flakiness. The two spots a model
*would* earn its slot are fuzzy NL parsing and prose description — the
edges of the deterministic core. Keep the cheap path default; escalate
only for ambiguity.

```
  exact rule (router/classify/cost) → no model
  ambiguous edge (parse/describe)   → escalate to LLM
```

Anchor: *"flattr is deterministic-first by construction; the LLM lane is
only the two fuzzy edges — parse near geocode.ts:9, describe at
summary.ts:5."*

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — why classify.ts isn't ML.
- [08-provider-abstraction.md](08-provider-abstraction.md) — the lane the escalation picks.
- [04-structured-outputs.md](04-structured-outputs.md) — typing the escalated output.
