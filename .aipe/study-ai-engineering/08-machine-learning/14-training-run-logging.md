# Training-run logging — record every fit of the cost model so you can trust it

**Industry name(s):** experiment tracking / training-run logging (MLflow,
Weights & Biases). **Type:** Industry standard (reproducibility hygiene).

## Zoom out — no training runs exist yet, but a learned cost needs every fit logged

Training-run logging records the inputs and outputs of each model fit:
data version, hyperparameters, metrics, the resulting artifact. It's how
you answer "why did the model change?" months later. flattr trains
nothing, so there are no runs to log — but the moment a learned cost gets
fit, each run needs a record, especially because the model ships into an
A* invariant: you must be able to prove *which* fit produced the cost
that's serving, and that it passed the admissibility checks.

```
  Zoom out — logging wraps each fit of the cost model (none exist yet)

  data version ──┐
  hyperparams  ──┤──► [ TRAIN RUN ] ──► artifact + metrics
  features set  ─┘         │              │
                          ▼              ▼
                   training-run log   ★ cost.ts penalty()
                   (data hash, k1/k2,  (which run produced
                    metric, A*-legal?)  the serving model?)
```

The log is the audit trail. For a cost embedded in A*, it must also record
the admissibility verdict — did this fit pass monotone & finite-BLOCKED?

## Structure pass

- **Layers:** run inputs (data hash, config) → fit → run outputs (metrics,
  artifact) → run registry → the deployed artifact's provenance.
- **Axis — ephemeral vs recorded.** An unlogged fit is a result you can't
  reproduce or trust. A logged fit is one you can compare, roll back, and
  audit.
- **Seam:** the training script (would be `pipeline/cost-train.ts`). Every
  invocation emits one run record.

## How it works

### Move 1 — the mental model

A training run is an experiment, and experiments without a lab notebook
are folklore. You log so that "the model got worse" becomes a diff —
*which* data, *which* hyperparameters, *which* metric moved — instead of a
shrug. It's the same instinct as a commit message, but for a fit.

```
  Pattern — one record per fit

  ┌─ run record ──────────────────────────┐
  │ data hash · feature set · k1,k2 / GBT  │
  │ metric (held-out user MAE) · artifact  │
  │ A*-legal? (monotone ✓ / finite ✓)      │
  │ timestamp · git sha                     │
  └─────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Sub-step A — what to log for flattr's cost specifically.**

```
  flattr cost run record (beyond the generic fields)

  data version    hash of the accept/reroute event set + split seed
  split           BY-USER split ids (which users in train/val/test)
  hyperparams     k1,k2 grid point OR GBT depth/leaves/monotone flags
  metric          held-out-USER error (not held-out event — see 03)
  ADMISSIBILITY   did this fit pass assertMonotoneNonNeg + finite-BLOCKED?
  comparison      did it beat the formula penalty() baseline?
```

The two flattr-specific fields are the by-user split identity and the
admissibility verdict. Without the first you can't reproduce the metric;
without the second you might ship an A*-illegal cost.

**Sub-step B — why the admissibility verdict belongs in the log.**

```
  The log gates deployment

  run #41: metric 0.12, monotone ✓, finite ✓ → DEPLOYABLE
  run #42: metric 0.09 (better!), monotone ✗  → BLOCKED from deploy
  → the log makes "better metric but illegal" a visible, refused state
```

A run that fits better but breaks monotonicity must be *recorded as
rejected*, not silently shipped. The log is where that decision lives.

**Sub-step C — provenance for the serving model.**

```
  Which run is serving?

  cost.ts penalty() ← artifact from run #41
  log answers: what data, what split, what metric, passed checks
  rollback: re-deploy run #39's artifact if #41 misbehaves in the field
```

This ties to retraining (`16`): every scheduled or triggered retrain emits
a new run, and the log is how you compare the new fit to the live one
before promoting it.

### Move 3 — the principle

Training-run logging turns model changes from folklore into a reproducible,
auditable diff. For flattr the log carries two non-generic fields that the
A* embedding demands: the by-user split identity (so the metric is
reproducible and leak-free) and the admissibility verdict (so an
A*-illegal fit can never be silently promoted no matter how good its
metric looks). The log is both the lab notebook and the deployment gate.

## Primary diagram

```
  Training-run log for flattr's cost model (none exist yet)

  ┌─ each fit of the cost ──────────────────────────┐
  │ INPUTS:  data hash · by-user split · k1k2/GBT cfg │
  │ OUTPUTS: held-out-USER metric · artifact          │
  │ GATE:    monotone↑ ✓?  output ≥0 ✓?  finite ✓?    │
  │ COMPARE: beat formula penalty() baseline?         │
  └──────────────────────┬───────────────────────────┘
  ┌─ run registry ───────▼──────────────────────────┐
  │ run #N → artifact, metric, legal verdict, git sha │
  │ serving = which run? rollback = which prior run?  │
  └────────────────────────────────────────────────────┘
```

## Elaborate

The reason logging is more than hygiene for flattr: the metric and the
legality are *separate verdicts*, and the log is the only place they're
recorded together. A naive setup tracks the metric, picks the best, and
ships — which for flattr could ship a beautifully-accurate, non-monotone
cost that breaks A* optimality. By logging the admissibility verdict
alongside the metric, you make "best metric" insufficient for promotion;
the run must also be *legal*. That coupling — metric AND invariant in one
record — is the flattr-specific discipline. It also makes drift-triggered
retrains (`16`) auditable: every retrain is a run, every run is comparable,
and nothing reaches `penalty()` without a logged legality check.

## Project exercises

### LOG.1 — training-run record with admissibility verdict

- **Exercise ID:** LOG.1
- **What to build:** a `logRun(record)` helper and a record schema that
  captures data hash, by-user split ids, hyperparameters, held-out-user
  metric, AND the monotone/≥0/finite verdict — appended per fit.
- **Why it earns its place:** it bakes the flattr-specific gate (legality
  beside metric) into the run record so an illegal fit can't be silently
  promoted.
- **Files to touch:** new `pipeline/cost-train.ts` (emit a record per fit),
  new `pipeline/run-log.ts` (the schema + append), `run-log.test.ts`
  (assert a record missing the legality verdict is rejected).
- **Done when:** every simulated fit produces a record containing the
  metric and the admissibility verdict, and a record without the verdict
  fails validation.
- **Estimated effort:** half a day.

## Interview defense

**Q: What would you log for flattr's cost training runs?** Answer: the
generic fields — data hash, hyperparameters, metric, artifact, git sha —
plus two flattr-specific ones. First, the by-user split identity, so the
held-out-*user* metric is reproducible and provably leak-free. Second, the
admissibility verdict: did this fit pass monotone, ≥0, and finite-BLOCKED?
That second field is the deployment gate — a run with a better metric but
broken monotonicity must be recorded as *rejected*, never silently
shipped, because it'd break A* optimality. The log couples metric and
legality so "best" alone can't promote a model.

```
  log: metric AND admissibility verdict together
  → better-but-illegal fit = visible, refused state, not a silent ship
```

Anchor: *"the cost serves inside A*, so each run's log records not just
the metric but whether the fit stayed monotone and finite — legality is a
gate, not an afterthought."*

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the fit step these runs record.
- [16-retraining-pipelines.md](16-retraining-pipelines.md) — every retrain emits a run.
- [04-model-selection.md](04-model-selection.md) — the admissibility verdict each run logs.
