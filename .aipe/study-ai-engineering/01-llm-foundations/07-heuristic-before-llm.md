# Heuristic Before LLM
*Deterministic-first / cascade routing — Language-agnostic*

## Zoom out

The cheapest, fastest, most testable inference is the one you don't send to a model. The mature pattern is a cascade: a deterministic rule handles the common, unambiguous case in microseconds, and the LLM is the *fallback* for genuine ambiguity only. flattr is a striking example — it's all heuristic and *no* LLM, deterministic by design. So this concept lets you see the "fast path" half fully built, with the LLM half simply absent.

```
LAYERS — the cascade, fast path first
┌──────────────────────────────────────────────┐
│ input ─► [ deterministic rule ] ─► answer ✓     │ ◄── 99% exits here
│                  │ ambiguous?                    │
│                  ▼                               │
│            [ LLM fallback ] ─► answer            │ ◄── flattr: absent
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Don't reach for the model first; reach for it *last*. A threshold table, a formula, a lookup — if it answers correctly and cheaply, ship that and never pay the latency, cost, and nondeterminism tax. The LLM earns its place only where rules genuinely can't decide: fuzzy natural language, open-ended judgment. The art is drawing the line so the fast path takes the overwhelming majority of traffic.

```
PATTERN — flattr's grade classifier IS the fast path
  absGradePct ─► classifyAbs()
       ≤ 4  ─► green
       ≤ 8  ─► yellow
       else ─► red
  pure threshold table. no model. fully testable. (classify.ts:11)
```

**Move 2 — the mechanism, in flattr's own code.** flattr's spec §14 mandates "hand-rolled only," and the codebase honors it with two deterministic engines:

- `features/grade/classify.ts:11` — `classifyAbs` maps a grade percent to a color band via fixed thresholds (4%, 8%). A `directedGradePct` variant (`:33`) bands against the user's max. No model, no ambiguity, no variance.
- `features/routing/cost.ts:16` — `penalty(g, max)` is a closed-form piecewise function: free downhill, linear moderate, quadratic steep, `BLOCKED` over max. The A* cost is a formula, not a prediction.

```
MECHANISM — deterministic by construction
  edge grade ─► penalty(g,max)   [cost.ts:16]
     g≤0      ─► 0
     g≤½max   ─► k1·g            (linear)
     g≤max    ─► k2·(g-½max)²+…  (quadratic, continuous at boundary)
     g>max    ─► BLOCKED
  same input → same cost, every run. no LLM in the loop.
```

The "LLM fallback" arm of the cascade doesn't exist here — and that's the point. flattr proves the fast path can carry 100% of the load when the problem is well-specified. The lesson for AI work: only the *residual* ambiguity after your rules should ever reach a model.

**Move 3 — principle.** Spend a model only on the cases your rules can't decide; everything a formula can answer, let the formula answer.

## In this codebase

**Fully exercised — as the heuristic half only.** flattr is deterministic by design (spec §14); `features/grade/classify.ts` (threshold table) and `features/routing/cost.ts` (penalty formula) are the fast path, and there is intentionally no LLM fallback. If one were ever added, the natural-language input at `pipeline/geocode.ts:9` is the place an *ambiguous* query ("somewhere flat-ish nearby") would fall through to a model after the plain-address path failed — a textbook cascade, with flattr's existing engine as the deterministic first stage.

## See also
- [04 — Structured outputs](04-structured-outputs.md)
- [03 — Sampling parameters](03-sampling-parameters.md)
