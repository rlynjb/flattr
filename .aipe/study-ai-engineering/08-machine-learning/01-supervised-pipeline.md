# The Supervised ML Pipeline

*Industry name: supervised learning lifecycle — a data → model → serving pipeline.*

## Zoom out

```
THE FIVE STAGES (each can fail independently)
┌────────┐   ┌──────────┐   ┌───────┐   ┌──────┐   ┌───────┐
│  DATA  │ → │ FEATURES │ → │ TRAIN │ → │ EVAL │ → │ SERVE │
│ labels │   │ engineer │   │  fit  │   │ test │   │ infer │
└────────┘   └──────────┘   └───────┘   └──────┘   └───────┘
     ▲                                                  │
     └──────────── feedback / retrain ◄─────────────────┘
```

Supervised ML is the discipline of learning a function `f(x) → y` from **labeled
examples** (`x` is features, `y` is the known answer). The whole field is really plumbing
around that one idea: get clean labeled data, turn it into numbers a model can fit, fit
the model, *prove* it generalizes on data it never saw, then run it in production. This is
new ground — your one shipped ML pipeline (contrl) **used** a pretrained pose model; it
never trained one, so you've never built this loop end to end.

## How it works

### Move 1 — the mental model: it's a learned lookup table

```
HAND-CODED                         LEARNED
if g <= 0: return 0           x ──► [ fitted params θ ] ──► ŷ
if g > max: return BLOCKED          θ chosen to minimize
return k1*g  ...                    error on labeled data
```

A supervised model is a hand-coded function whose **constants you didn't pick** — training
picks them by minimizing prediction error on labels. `cost.ts`'s `k1=0.4, k2=1.0` are
hand-tuned magic numbers. A learned version would set those (or far more) parameters from
data showing what penalties actually match rider behavior.

### Move 2 — walk the stages, carefully

1. **Data + labels.** You need rows of `(features, true_answer)`. For a learned cost
   model the label is hard: what *is* the "true cost" of an edge? You'd have to derive it
   from real rider GPS traces (which edges they avoided), or from comfort ratings. **flattr
   has none of this.** No traces, no ratings, no labels. This stage alone is the wall.
2. **Features.** Turn raw rows into a numeric vector (next file). flattr already has the
   columns: `gradePct`, `absGradePct`, `lengthM`, `riseM`, `kind`.
3. **Train.** Pick a model class, fit parameters by gradient descent / tree splits to
   minimize a loss. Output: a file of weights.
4. **Eval.** Measure error on a **held-out** split (file 03). A model that aces training
   data and fails here has memorized, not learned.
5. **Serve.** Load weights, run inference in the request path. For flattr that path is
   already on-device (A* runs on the phone, file 12).

### Move 3 — the principle

**Every stage is a contract with the next.** Garbage labels make training meaningless;
no held-out split makes eval a lie; a serving environment that differs from training
(file 06) makes a "good" model bad in production. The pipeline is only as trustworthy as
its weakest stage.

## In this codebase

**NOT YET EXERCISED — flattr has no supervised pipeline at all.** The closest existing
thing is `pipeline/run-build.ts`, which *is* a pipeline — but a **deterministic** one:

```
run-build.ts  (SAME WORD, NO LEARNING)
OSM fetch → split → elevation sample → compute grades → write graph.json
            ↑ every step is a fixed function; nothing is fit to data
```

Same vocabulary ("pipeline"), zero learning. If you ever replaced the hand-coded
`penalty()` in **`features/routing/cost.ts`** with a learned edge cost, you would have to
build the *entire* five-stage loop above — starting with the missing labels. And the
learned `f` would still owe the invariants: **penalty ≥ 0** (A* admissibility) and
**BLOCKED stays large-finite, not Infinity** (spec §14.4).

Note: `features/grade/classify.ts` is **not** a model output despite the name — it's a
threshold table, no training stage produced it.

## See also

- `02-feature-engineering.md` — the features the columns already give you
- `03-train-val-test.md` — why the eval stage needs a careful split
- `16-retraining-pipelines.md` — run-build.ts as the deterministic rebuild analog
</content>
