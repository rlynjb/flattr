# Sampling parameters

**Industry name(s):** temperature / top-p (nucleus) / top-k / sampling
config. **Type:** Industry standard knob set.

## Zoom out — where this would sit in flattr

A model emits a distribution over the next token; sampling parameters
decide how you pick from it. `temperature=0` (greedy / argmax) makes
output deterministic and repeatable — the right setting for *structured*,
factual tasks. High temperature adds variety, for creative text. flattr
runs **no model**, so it sets no sampling params. But the would-be
route-describe call is a structured, factual task over three numbers — so
it should run at `temperature=0`, like a classifier. This file teaches the
knobs and names the setting the seam would want.

```
  Zoom out — the sampling knob the route-describe seam would pin

  ┌─ engine ────────────────────────────────────────────────┐
  │ routeSummary() ─► RouteSummary {distanceM,climbM,steep}  │
  └────────────────────────────┬─────────────────────────────┘
                              │ summary.ts:5
  ┌─ ★ would-be LLM call ─────▼─────────────────────────────┐
  │ describeRoute(summary)                                   │
  │   temperature = 0   ◄── deterministic, repeatable        │
  │   top_p = 1, top_k = 1 effectively                       │
  │   → "Mostly flat, 2.3 km, one steep block."              │
  └──────────────────────────────────────────────────────────┘
```

flattr has **no sampling config** because it has no model. The lesson is:
when the model exists, pick `temperature=0` here on purpose, not by
default.

## Structure pass

- **Layers:** engine (exact numbers) → LLM call (sampled text) → UI.
- **Axis — output variance:** the engine has zero variance (same path
  every time). A model at high temperature has high variance — same prompt,
  different sentences. At `temperature=0` variance collapses back toward
  zero, matching the deterministic core. The axis is *variance*, and you
  want it pinned low here.
- **Seam:** the variance knob lives on the LLM call that would sit at
  `summary.ts:5` → `MapScreen.tsx:368`. Set it wrong (high temp) and a
  factual route blurb starts inventing flair.

## How it works

### Move 1 — the mental model

You know `Math.random()` vs a fixed seed. Temperature is the dial between
them for token selection: `0` = always take the most likely token
(deterministic), higher = flatten the distribution so unlikely tokens get
picked. top-p and top-k *truncate* the distribution before sampling (only
consider the top-k tokens, or the smallest set whose probabilities sum to
p).

```
  Pattern — temperature reshapes the next-token distribution

  logits ─► softmax/temperature ─► P(next token)

  temp = 0   :  ▁▁▁█▁▁▁   pick the spike every time (deterministic)
  temp = 0.7 :  ▂▃▅█▅▃▂   some spread (a little variety)
  temp = 1.5 :  ▄▅▆█▆▅▄   flat — risky, can ramble

  top_k = 1  : keep only the single best token  (≈ temp 0)
  top_p = .9 : keep smallest token set summing to 0.9, then sample
```

### Move 2 — the walkthrough

**The task is structured, so pin variance to zero.** `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

This describe task is closer to a *classifier* than to creative writing:
the facts are fixed, you want consistent phrasing, and you want the same
input to give the same blurb so QA and caching work. That is exactly the
`temperature=0` regime.

```
  Layers-and-hops — variance pinned at the seam

  ┌─ engine ──┐ {3 numbers}   ┌─ LLM call ───────────┐
  │routeSummary│ ───────────► │ describeRoute        │
  └───────────┘               │  temperature = 0     │ ← variance ≈ 0
                              │  → same blurb each run│
                              └──────────┬───────────┘
  ┌─ UI ──────┐ text                     ▼
  │SummaryCard│ ◄──────────────────── stable, cacheable
  └───────────┘
```

**Why not higher temperature?** A nav blurb that randomly says "Brutal
climb!" one run and "Gentle rise" the next on the *same* route erodes
trust and breaks any string-based test or cache key. There's no upside to
variety in a factual summary. Reserve temperature for genuinely
open-ended generation, which flattr doesn't have.

**Where variety might legitimately enter.** If flattr ever added a
free-text NL parse ("avoid hills near the park"), the *parse* still wants
`temperature=0` (you need a stable structured result, see
[05-streaming.md](05-streaming.md) and
[04-structured-outputs.md](04-structured-outputs.md)) — the variance knob
stays low across both would-be model calls. flattr has no task that wants
high temperature.

### Move 3 — the principle

Temperature is a variance dial; structured, factual model tasks want it at
`0` so the model behaves like the deterministic code around it. Default
provider temperature is often `0.7–1.0` — wrong for this seam. Choosing
`0` is a deliberate match to flattr's exact core.

## Primary diagram

```
  Sampling parameters — the setting flattr's seam would demand

  ┌─ engine (variance = 0) ─────────────────────────────────┐
  │ RouteSummary {3 numbers}  — exact, repeatable            │
  └────────────────────────────┬─────────────────────────────┘
                            summary.ts:5
  ┌─ would-be LLM (NOT BUILT) ▼─────────────────────────────┐
  │ describeRoute  temperature=0  top_k≈1  → stable blurb    │
  │ matches the deterministic core; cacheable; testable      │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Knobs in practice: `temperature` rescales logits before softmax;
`top_k` keeps the k most likely tokens; `top_p` keeps the nucleus summing
to p. They compose — temp 0 makes top-p/top-k moot. Some providers expose
`seed` for reproducibility even at non-zero temp. For evals and caching you
want determinism, which is why classifiers, extractors, and structured
generators almost always run at temp 0 — the bucket flattr's describe task
falls into. In dryrun (on-device Gemini Nano), structured calls are pinned
the same way.

## Project exercises

### B-SP.1 — pin temperature in the stub

- **Exercise ID:** B-SP.1
- **What to build:** in the `describeRoute` stub, accept a `temperature`
  option defaulting to `0`, and a unit test asserting the same
  `RouteSummary` yields the same string (proving determinism intent).
- **Why it earns its place:** it encodes the variance decision in code so
  a future real model call inherits temp 0 by default.
- **Files to touch:** new `features/routing/describe.ts`; `summary.ts:5`
  (input type).
- **Done when:** the default is `0` and the determinism test passes.
- **Estimated effort:** 45 min.

### B-SP.2 — cache key on summary

- **Exercise ID:** B-SP.2
- **What to build:** a memoization of `describeRoute` keyed on the
  rounded `RouteSummary`, which is only sound *because* temperature is 0.
- **Why it earns its place:** it demonstrates the downstream payoff of
  zero variance — caching — at the real summary seam.
- **Files to touch:** `features/routing/describe.ts`;
  `mobile/src/MapScreen.tsx:159` (call site).
- **Done when:** identical summaries hit the cache; a test proves it.
- **Estimated effort:** 1 hr.

## Interview defense

**Q: What temperature would flattr's route-describe call use, and why?**
Answer: `temperature=0`. The task is factual and structured — three
numbers in, one consistent blurb out — so I want it deterministic,
repeatable, and cacheable, like a classifier. High temperature would let
the model invent flair and break string tests and cache keys. flattr has
no task that wants high variance.

```
  {3 numbers} → [LLM temp=0] → same blurb every run (cacheable)
```

Anchor: *"the route-describe seam is a structured task — temp 0,
deterministic, matching flattr's exact core at summary.ts:5."*

## See also

- [05-streaming.md](05-streaming.md) — why the NL-parse must not stream.
- [04-structured-outputs.md](04-structured-outputs.md) — temp 0 + schema together.
- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the distribution being sampled.
