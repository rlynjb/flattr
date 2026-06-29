# Sampling Parameters
*Sampling / decoding parameters — Industry standard*

## Zoom out

The model emits a probability distribution over the next token; *sampling* is how you pick from it. Temperature, top-p, and top-k are the knobs that decide whether output is deterministic-and-boring or varied-and-risky. For anything fact-bearing — and flattr's only candidate feature is fact-bearing — you want the boring end.

```
LAYERS — sampling sits between model and your string
┌───────────────────────────────────────────┐
│ [transformer] → logits over vocab          │
│        │ temperature / top-p / top-k        │ ◄── you control these
│        ▼                                     │
│   pick one token → append → loop            │
└───────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Temperature scales the distribution's sharpness: `0` = always take the most likely token (deterministic, repeatable); higher = flatter distribution = more surprising, more creative, more wrong. top-k keeps only the k most likely tokens before sampling; top-p (nucleus) keeps the smallest set whose probabilities sum to p. They're filters narrowing the candidate pool.

```
PATTERN — temperature reshapes the distribution
  logits:   climb ████████  hill ███  ride ██  ...
  temp=0 ─► always "climb"        (greedy, repeatable)
  temp=1 ─► sometimes "hill"      (varied)
  temp=2 ─► "ride"? "trek"?       (flat, chaotic)
```

**Move 2 — the mechanism.** At each step: take logits → divide by temperature → softmax → distribution. Apply top-k (truncate to k tokens) and/or top-p (truncate to nucleus). Sample one. At temperature 0 the divide collapses to argmax — no sampling at all, fully reproducible given the same prompt. This is why classifiers and structured extractors run at temperature 0: you want the *same* input to yield the *same* label every time.

```
MECHANISM — the decision per token
  logits ─► /temp ─► softmax ─► top-k/top-p filter ─► sample
   temp=0 │                                              │
          └──────────► argmax (skip sampling) ───────────┘
```

**Move 3 — principle.** Creativity is a feature you opt into; for facts, set temperature 0 and stop guessing why outputs drift.

## In this codebase

**Not yet exercised in flattr.** No model, no sampling. But the design intent is clear: if you narrated `routeSummary` (`features/routing/summary.ts:11`) through an LLM, you'd run it at **temperature 0**. The numbers — distance, climb, steep-edge count — are computed deterministically by the A* engine and must not wobble between runs. A user re-tapping the same route and seeing "80m of climbing" become "85m" because the sampler rolled differently would be a correctness bug, not a flavor difference. flattr's whole ethos is deterministic (see file 07); the sampling config would inherit that.

## See also
- [07 — Heuristic before LLM](07-heuristic-before-llm.md)
- [04 — Structured outputs](04-structured-outputs.md)
