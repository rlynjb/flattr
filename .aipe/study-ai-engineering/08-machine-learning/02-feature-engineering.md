# Feature Engineering

*Industry name: feature engineering — turning raw signals into model inputs.*

## Zoom out

```
RAW WORLD ──────► FEATURE VECTOR ──────► MODEL
two node           [ gradePct,           f(x) → ŷ
elevations,         absGradePct,
a polyline          lengthM, riseM,
                    kind_onehot... ]
```

A model never sees the world — it sees a vector of numbers you chose. **Feature
engineering is choosing those numbers.** Good features make a weak model strong; bad
features make a strong model useless. This is the stage where domain knowledge (here:
"downhill is free, uphill is what hurts") gets baked in. flattr is unusually lucky here:
**the feature columns already exist** as hand-crafted edge fields, even though nothing
learns from them.

## How it works

### Move 1 — the mental model: features encode your hypothesis

```
HYPOTHESIS                        FEATURE THAT ENCODES IT
"steepness, not slope, hurts"  →  absGradePct  (sign stripped)
"direction matters uphill"     →  gradePct     (signed)
"long edges cost more"         →  lengthM
"surface type matters"         →  kind (categorical)
```

Each feature is a guess that *this number carries signal*. `cost.ts` already commits to
two of these: `gradeCostAbs` uses `absGradePct` (symmetric), `gradeCostDirected` uses the
signed directed grade (asymmetric). That choice — which feature to trust — is exactly what
a learned model would otherwise have to discover.

### Move 2 — the standard moves, on flattr's edge

Look at the real type (`features/routing/types.ts`):

```ts
type Edge = { lengthM; riseM; gradePct; absGradePct; kind? ... }
```

A learned cost model would consume these and apply textbook transforms:

1. **Numeric scaling.** `lengthM` ranges 0–~90m; `gradePct` ranges -40..40. Trees don't
   care, but a neural net or linear model does — you'd standardize each to mean 0 / std 1
   so big-magnitude features don't dominate.
2. **Encode categoricals.** `kind` ("sidewalk" | "footway" | ...) → one-hot columns. A
   model can't multiply a string.
3. **Derived / interaction features.** `riseM` is literally `gradePct × lengthM / 100` —
   redundant for a tree, but a useful interaction term for a linear model.
4. **Sign decomposition.** Keep BOTH `gradePct` (direction) and `absGradePct`
   (magnitude) — they answer different questions, and the model can weight each.
5. **No leakage.** Never engineer a feature from the label. If your label were "rider
   avoided this edge," you must not feed in "edge was on the avoided route."

### Move 3 — the principle

**Features are where you spend your domain expertise, not your compute.** flattr's authors
already did the expensive part — deciding that *signed grade* and *absolute grade* are the
load-bearing signals. A learned model inherits those columns; it doesn't have to rediscover
that elevation delta over length is the thing that matters.

## In this codebase

**NOT YET EXERCISED as model inputs — but the feature table is RIGHT THERE.** This is
flattr's best concrete anchor for the whole ML section:

```
features/routing/types.ts  ──►  features/routing/cost.ts
  gradePct, absGradePct,         penalty(g, max)  ← HAND-CODES the weighting
  lengthM, riseM, kind            (k1=0.4, k2=1.0)
       ▲ feature columns exist     ▲ nothing LEARNS the weights yet
```

The hand-coded `penalty()` *is* a manual feature-to-cost mapping. Swapping it for a learned
model means feeding these same columns into a fitted `f`. The catch (recurring across this
section): the learned `f` must stay **monotone in steepness and non-negative** so A*'s
heuristic stays admissible, and **BLOCKED stays large-finite** (spec §14.4).

`pipeline/grade.ts` is where these features get *computed* (the `MAX_GRADE_PCT=40` clamp is
itself a feature-cleaning decision — it strips coarse-DEM noise). That's feature
engineering on the raw side, done by hand today.

## See also

- `01-supervised-pipeline.md` — where features sit in the loop
- `04-model-selection.md` — why the invariants pick the model that eats these features
- `06-domain-gap.md` — features trained on one city's grade distribution
</content>
