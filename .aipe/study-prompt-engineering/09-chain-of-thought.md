# 09 · Chain-of-thought (CoT)

> Industry name: chain-of-thought / step-by-step reasoning prompting · Type label: Industry standard

> **Status: seam, not feature.** flattr does no model reasoning — but it has a textbook multi-step decision that a model *would* need CoT to get right: `cost.ts`'s `penalty()` makes a banded, conditional, multi-branch judgment. This file maps CoT onto that decision shape, honestly: penalty is pure code today; here's what asking a model to make the same call would require.

## Zoom out — where this concept lives

CoT applies where a decision has multiple dependent steps. flattr's `penalty()` is exactly that shape — and it lives in the cost layer the router calls per edge:

```
  Zoom out — CoT, mapped onto penalty()'s multi-step decision

  ┌─ Routing (today, deterministic) ─────────────────────────────┐
  │ astar.ts → cost.ts: penalty(g, max)                          │
  │   step 1: downhill/flat? → 0                                 │
  │   step 2: over max?      → BLOCKED                           │
  │   step 3: which band?    → linear or quadratic               │
  │   (a MULTI-STEP decision — coded as branches today)         │
  └──────────────────────────────────────────────────────────────┘

  ┌─ If a model made this call (hypothetical) ───────────────────┐
  │ ★ THIS FILE: it would need to reason through the steps ★     │ ← we are here
  │ CoT: think step-by-step, THEN emit the band — in a field    │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **for a multi-step decision, prompt the model to reason through the steps before answering — it improves accuracy on problems that need intermediate work, and wastes tokens on problems that don't.** The modern caveat is real: frontier models reason internally now, so explicit CoT helps cheaper models more than top ones. And if you want reasoning *and* a structured answer, the reasoning goes in a thinking field, never loose prose. Let me build it.

## Structure pass

**Layers.** Two: the *reasoning trace* (the intermediate steps) and the *final answer* (the thing you actually consume). The discipline is keeping these separate so the answer stays parseable. `penalty()` shows the structure: it has intermediate decisions (which band) but returns one clean number.

**Axis — cost (does the extra reasoning pay for itself?).**

```
  One axis — "does reasoning earn its tokens?" — by task shape

  multi-step (penalty-shaped):  band depends on flat/over/half-max
    → CoT helps: model works the steps, gets the band right

  single-step (lookup/classify): "is this JSON valid?"
    → CoT WASTES tokens: no intermediate work to do

  the seam: CoT pays off only when the decision has dependent steps
```

**Seam.** The load-bearing boundary is *between multi-step decisions and single-step ones*. CoT earns its token cost on the former and burns tokens for nothing on the latter — and a classifier (Seam 2's parse) is mostly the latter, which is why you don't reflexively bolt CoT onto everything.

## How it works

### Move 1 — the mental model

You've written `penalty()` as a sequence of guards: check flat, check over-max, check which band. You did that because the answer *depends on intermediate determinations* — you can't jump to "quadratic penalty of 3.2" without first establishing "g is above half-max." CoT is asking a model to externalize that same sequence of guards before it commits to an answer, instead of blurting a number it might get wrong by skipping a step.

```
  The CoT kernel — reason through steps, then answer

  problem ─► [ step 1: is g flat/downhill? ]
            [ step 2: is g over max?       ]
            [ step 3: which band, linear/quad? ]
                          │
                          ▼
            answer (the band)  ← emitted AFTER the steps
   without CoT: model jumps to "answer", skips a step, gets it wrong
```

### Move 2 — the step-by-step walkthrough

**The reasoning-prompt pattern.** You add "think step by step" (or, better, name the steps) and the model emits its intermediate work before the conclusion. The accuracy gain comes from the model conditioning its final token on its own reasoning tokens — it's literally giving itself more relevant context to attend to before answering.

**The multi-step decision flattr already has.** Here's `penalty()` — read it as the decision a model would otherwise have to reason through:

```ts
// features/routing/cost.ts:16 — a genuinely multi-step decision
export function penalty(g, max, k1 = 0.4, k2 = 1.0): number {
  if (g <= 0) return 0;              // step 1: flat/downhill → no penalty
  if (g > max) return BLOCKED;       // step 2: over max → blocked
  const half = 0.5 * max;            // step 3: find the band boundary
  if (g <= half) return k1 * g;      // step 4a: moderate band → linear
  return k2 * (g - half) ** 2 + k1 * half;  // step 4b: steep band → quadratic
}
```

Four ordered, dependent steps. If a model had to *replicate this judgment in prose* — "given an 8% grade and a 6% max, classify the penalty band" — skipping step 2 (over-max check) would make it apply the quadratic formula to a grade that should be `BLOCKED`. CoT is how you'd stop that: make it state "is 8% over the 6% max? yes → BLOCKED" *before* it answers. The code never needs CoT because the branches are explicit; the lesson is that the *decision shape* is what CoT is for.

```
  Hop — penalty's decision as a reasoning trace

  ┌─ model reasoning (thinking field) ───────────────────────────┐
  │ "g=8, max=6. Step1: g>0, not flat. Step2: g>max (8>6) → over.│
  │  Conclusion: BLOCKED."                                       │
  └─────────────────────────┬────────────────────────────────────┘
                            │ THEN the structured answer
  ┌─ answer field ──────────▼────────────────────────────────────┐
  │ { band: "blocked" }                                          │
  └──────────────────────────────────────────────────────────────┘
```

**When it helps vs when it hurts.** Helps: multi-step problems like the `penalty` band classification, or "given this route's summary, decide whether to warn the user about the climb" (depends on `climbM` AND `steepCount` AND `userMax` — multiple dependent factors). Hurts: single-step lookups and tight classifiers. Seam 2's parse ("flat near water" → struct) is mostly single-step extraction — adding CoT there spends tokens and latency for no accuracy gain, and risks the reasoning leaking into the output mode (`07`).

**The modern caveat — frontier models reason internally.** Top models now do chain-of-thought inside the model before emitting tokens, so explicitly asking for it adds less than it did in 2022. But it still helps *cheaper* models measurably — and in a single-purpose-chain setup (`06`), the cheap model is exactly where you'd route a parse-or-classify step. So CoT isn't dead; it migrated to where the small models live. Don't cargo-cult "think step by step" onto a frontier model for a task it already reasons through internally — verify with evals (`05`) that it actually moved the score.

**The interaction with output validation — reasoning goes in a field.** This is the production-critical part. If you want both the reasoning *and* a structured answer, the reasoning lives in a `thinking` field of the schema, not as free prose wrapped around the JSON:

```
  RIGHT (CoT + structured output coexist):
    { "thinking": "g=8 > max=6, so over the threshold",
      "band": "blocked" }                    ← parseable, validated

  WRONG (reasoning leaks into output mode — the 07 bug):
    "Let me think... g is 8 and max is 6, so... {"band":"blocked"}"
    → safeParse fails on the whole blob
```

The thinking field gives the model its reasoning room *inside* the schema, so structured-output validation (`02`) still works. This is how CoT and structured outputs coexist instead of fighting.

### Move 3 — the principle

CoT trades tokens for accuracy on multi-step decisions — and only multi-step decisions. The shape to recognize is `penalty()`: a banded, conditional, order-dependent judgment where skipping a step gives the wrong answer. Match CoT to that shape; skip it for single-step lookups and tight classifiers. On frontier models it's largely internal now, so its remaining home is the cheap models in your chain. And whenever you want reasoning alongside a structured answer, the reasoning goes in a thinking field — never loose prose, or you reintroduce the output-mode-mismatch bug.

## Primary diagram

The full CoT pattern mapped onto penalty's decision, with the thinking-field structure marked.

```
  CoT — penalty()'s multi-step shape, reasoned in a thinking field

  ┌─ problem ────────────────────────────────────────────────────┐
  │ classify the penalty band for grade g against max             │
  └─────────────────────────┬────────────────────────────────────┘
                            │ CoT prompt (helps cheap models most)
  ┌─ reasoning (thinking field) ▼────────────────────────────────┐
  │ step1 flat? → step2 over max? → step3 which band?            │
  │   (mirrors penalty()'s 4 ordered branches in cost.ts:16)     │
  └─────────────────────────┬────────────────────────────────────┘
                            │ THEN, in the SAME struct
  ┌─ answer (validated field) ▼──────────────────────────────────┐
  │ { thinking: "...", band: "linear" | "quadratic" | "blocked" } │
  │   parseable — structured output (02) still works             │
  └──────────────────────────────────────────────────────────────┘
   skip CoT for single-step tasks (Seam 2 parse) — pure token waste
```

## Elaborate

CoT comes from Wei et al.'s "Chain-of-Thought Prompting" — the finding that prompting intermediate steps improves arithmetic and reasoning accuracy. The 2024-2026 shift is that reasoning models (o-series, extended-thinking modes) internalize it, so the explicit prompt is a smaller lever on the frontier and a real one on small models. The interaction with structured output is the part that matters most in production: the `thinking` field is the bridge that lets CoT and schema-validation coexist, and it's the same idea as Anthropic's recommendation to let the model think in `<thinking>` tags before the answer. flattr's `penalty()` is a clean teacher for the *decision shape* CoT targets — multi-branch, order-dependent, wrong-if-you-skip-a-step — even though the function itself will never call a model.

## Project exercises

### EX-COT-1 — Climb-warning decision with a thinking field

- **Exercise ID:** EX-COT-1
- **What to build:** A `shouldWarn(summary, userMax)` LLM step that decides whether to warn about a route's climb, emitting `{ thinking, warn: boolean, reason }` — reasoning in the field, structured answer alongside.
- **Why it earns its place:** Exercises the multi-factor decision (climbM + steepCount + userMax) where CoT pays off, and the thinking-field structure that keeps it parseable.
- **Files to touch:** new `features/routing/warn.ts`; consumes `RouteSummary` from `summary.ts`.
- **Done when:** the thinking field is populated, the boolean validates, and an eval shows CoT beats no-CoT on a small model.
- **Estimated effort:** 3 hours.

## Interview defense

**Q: When does chain-of-thought help and when does it hurt?**

Helps on multi-step decisions where the answer depends on intermediate determinations — like classifying a penalty band that depends on flat/over-max/which-band checks. Hurts on single-step lookups and tight classifiers, where it just burns tokens. Match it to the decision shape.

```
  penalty-shaped (multi-branch, ordered) → CoT helps
  parse/classify (single extraction)     → CoT wastes tokens
```

Anchor: flattr's `penalty()` (`cost.ts:16`) is the multi-step shape — four ordered branches where skipping one gives the wrong band.

**Q: You want reasoning AND a structured answer. How?**

Reasoning goes in a `thinking` field of the schema, not as free prose around the JSON. Loose reasoning leaks into the output mode and breaks `safeParse`. The thinking field gives the model room to reason while keeping the answer validatable.

## See also

- `02-structured-outputs.md` — the schema the thinking field lives in
- `05-eval-driven-iteration.md` — proving CoT actually moved the score
- `07-output-mode-mismatch.md` — why loose reasoning breaks the parser
- `10-self-critique.md` — the next step up in spend-tokens-for-reliability
