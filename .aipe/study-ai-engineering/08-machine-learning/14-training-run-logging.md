# Training-Run Logging

*Industry name: experiment tracking — logging hyperparams + metrics per run for reproducibility.*

## Zoom out

```
EVERY RUN IS A RECORD
run 17 | lr=0.01 depth=6 | F1=0.81 | git=ab12 | data=v3
run 18 | lr=0.03 depth=6 | F1=0.84 | git=cd34 | data=v3  ← what changed → why better
run 19 | lr=0.03 depth=8 | F1=0.79 | git=cd34 | data=v3
```

ML is empirical: you change one knob, run, compare. Without a logged record of *what
settings produced what score*, you can't reproduce a good model or explain a regression —
you're guessing. Experiment tracking (MLflow, Weights & Biases) logs every run's
hyperparams, metrics, code version, and data version. flattr has a genuine **discipline
analog** in `bench/` — same "log every run to compare" habit, applied to deterministic
algorithm runs. New ground as *training* tracking; familiar as *run* tracking.

## How it works

### Move 1 — the mental model: a lab notebook you can diff

```
INPUT (config)        →  RUN  →  OUTPUT (metrics)
hyperparams + code +            scores + artifacts
data version                    all stamped together
   ▲ log BOTH sides so any result is reproducible from its row
```

The non-negotiable: log the *inputs* (params, code commit, data hash) alongside the
*outputs* (metrics). A metric with no recorded inputs is a number you can never reproduce.

### Move 2 — the fields, and flattr's honest analog

A training run logs:

1. **Hyperparameters** — lr, depth, regularization.
2. **Metrics** — F1, ECE, val loss.
3. **Code + data version** — git SHA + dataset hash (so "good run" is reproducible).
4. **Artifacts** — the saved weights.

flattr's `bench/` does the *structurally identical* thing for **algorithm** runs:

```
bench/report.ts  (BenchRow)        TRAINING-RUN LOG
algorithm         ◄── like ──►     model/config name
nodesExpanded, pushes, pops, ms ◄─ like ─► metrics (speed/quality)
cost              ◄── like ──►     eval score
formatTable(...)  ◄── like ──►     the comparison table
```

`bench/report.ts`'s `BenchRow` records *per-run* metrics and `formatTable` lays them in a
comparison table — exactly the "run many configs, tabulate, pick the winner" loop of
experiment tracking. The difference: flattr's runs are **deterministic** (same inputs →
same row, every time), so there's no random seed or fitted weights to log. It's the same
*discipline*, not the same *content*.

### Move 3 — the principle

**A result you can't reproduce isn't a result.** Whether you're comparing A* variants
(flattr) or training configs (ML), log the full input→output record so any number can be
regenerated and any improvement explained. flattr already practices this — which means
adopting real experiment tracking later is a content swap, not a culture change.

## In this codebase

**NOT YET EXERCISED as training-run logging — there are no training runs.** But the
analog is real and worth naming: `bench/report.ts` + `bench/run.ts` already log every
algorithm run's metrics into a comparable table. If a learned **`features/routing/cost.ts`**
ever existed, you'd extend this exact habit — add hyperparams, a data-version hash, and the
fitted-weights artifact to each row — to track training runs. Determinism means flattr's
current rows need no seed; a learned model's rows would.

`features/grade/classify.ts` is a fixed threshold table — no runs, no metrics, nothing to
track.

## See also

- `01-supervised-pipeline.md` — the train/eval stages whose runs you'd log
- `03-train-val-test.md` — the split each logged run is scored on
- `16-retraining-pipelines.md` — logging across scheduled retrains over time
</content>
