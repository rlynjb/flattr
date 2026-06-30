# Retraining pipelines — scheduled, drift, and performance triggers for the cost model

**Industry name(s):** retraining pipeline / continuous training (CT).
**Type:** Industry standard production-ML practice.

## Zoom out — a learned cost decays, so retraining is the loop that keeps it current

A retraining pipeline is the automation that re-fits a model on fresh data
and safely promotes the new version. flattr has no model and no
retraining, so none exists — but if a learned cost shipped, it would need
this loop: collect new accept/reroute events, re-fit, re-verify the A*
invariants, compare to the live model, and promote only if it's better
*and* legal. It's where cold-start (`11`), drift (`15`), and run-logging
(`14`) come together into one cycle.

```
  Zoom out — the retraining loop around the cost model (none exists)

  fresh accept/reroute events
        │  trigger: schedule | drift (15) | perf drop
        ▼
  re-fit ─► RE-VERIFY admissibility ─► compare to live ─► promote?
   │              (monotone, finite)        │              │
   │                                        │              ▼
   └──────── log every run (14) ────────────┘     ★ cost.ts penalty()
                                                    (new artifact, or
                                                     keep old / formula)
```

The loop's flattr-specific gate: a re-fit can only be promoted if it
*still passes* monotone & finite-BLOCKED. A better metric isn't enough.

## Structure pass

- **Layers:** trigger → data refresh → re-fit → invariant re-verify →
  shadow/compare → promote-or-reject → log.
- **Axis — when to retrain.** Three trigger types: scheduled (calendar),
  drift-based (PSI fires, `15`), performance-based (live metric drops).
  Each has a different cost/freshness trade.
- **Seam:** `penalty()` (cost.ts:16) — the promotion target. Promotion
  swaps the artifact behind this signature; rejection keeps the live one
  (or the formula).

## How it works

### Move 1 — the mental model

A deployed model is a perishable good. Retraining is restocking — but you
don't restock blindly; you restock when a *trigger* says the shelf is
stale, and you check the new stock before putting it out. The three
triggers are calendar, drift, and dropping performance.

```
  Pattern — three triggers, one safe-promotion gate

  trigger ──► re-fit ──► gate ──► promote
  ─────────              ────
  schedule (e.g. monthly)   metric better than live? AND
  drift fired (PSI>0.25)    admissibility ✓ (monotone, finite)?
  perf dropped (live MAE↑)  → yes: promote │ no: keep live/formula
```

### Move 2 — the walkthrough

**Sub-step A — the three triggers, for flattr.**

```
  When flattr would retrain the cost

  SCHEDULED   monthly re-fit on the last N days of events
              (simple, predictable, may waste compute if stable)
  DRIFT       PSI(grade) or accept-rate shift fires (15)
              (fits only when the world actually moved)
  PERFORMANCE live held-out-user error climbs past a bound
              (reactive — model already degrading)
```

Drift-triggered is the most efficient (retrain only when needed);
scheduled is the simplest to operate; performance-triggered is the
last-resort backstop.

**Sub-step B — the safe-promotion gate (flattr's non-negotiable).**

```
  Promotion gate — TWO conditions, both required

  candidate fit
    ├─ metric: beats live model on held-out USER? ──┐
    └─ legality: monotone↑ ✓, ≥0 ✓, finite BLOCKED ✓ ┤
                                                      ▼
        both YES → promote to penalty()
        legality NO → REJECT regardless of metric (A* would break)
        metric NO   → keep live model
```

This is where retraining differs from generic CT: the legality check
(`assertMonotoneNonNeg` + finite over-max, from `04`/`14`) is a *hard*
gate. A retrain that fits better but loses monotonicity is rejected,
logged as rejected, and the live model stays.

**Sub-step C — shadow before promote, fall back when unsure.**

```
  De-risk the swap

  shadow:   run candidate cost alongside live, compare routes offline
  promote:  swap artifact behind penalty() (signature unchanged)
  rollback: keep prior artifact; revert if field metrics regress
  fallback: if no candidate is legal AND better → serve formula (11)
```

### Move 3 — the principle

A retraining pipeline keeps a perishable model fresh, on a trigger, behind
a safe-promotion gate. flattr's version threads the whole production stack:
drift (`15`) is the smart trigger, run-logging (`14`) records every fit,
and the admissibility check is a *hard* promotion gate so no retrain — no
matter how accurate — can ship an A*-illegal cost. And the formula
penalty is always the floor: if no candidate is both better and legal, you
serve the drift-proof formula rather than a bad model.

## Primary diagram

```
  Retraining pipeline for flattr's cost (none exists yet)

  ┌─ TRIGGER ───────────────────────────────────────┐
  │ scheduled | drift fired (15) | live perf dropped │
  └──────────────────────┬───────────────────────────┘
  ┌─ RE-FIT on fresh by-user data ─▼────────────────┐
  │ same pipeline as 01/03; log the run (14)         │
  └──────────────────────┬───────────────────────────┘
  ┌─ GATE (both required) ─▼────────────────────────┐
  │ beats live on held-out USER?  AND               │
  │ monotone↑ ✓ · ≥0 ✓ · finite BLOCKED ✓?          │
  └──────────────────────┬───────────────────────────┘
  ┌─ ACTION ─────────────▼──────────────────────────┐
  │ both yes → promote to penalty()                  │
  │ legality no → REJECT · neither → keep live/formula│
  └────────────────────────────────────────────────────┘
```

## Elaborate

The reason the legality gate sits *inside* the retraining loop, not just at
first deploy: retraining is exactly where an A*-illegal model sneaks in.
The first model you hand-check; the 12th monthly retrain you don't — it
promotes automatically if the metric clears. Without an automated
monotone/finite check in the promotion gate, a drift-triggered retrain on
a weird month's data could quietly ship a non-monotone cost and break
routing for everyone, with a *better* offline metric hiding the bug. So
the property test from `04`/`14` isn't a one-time launch check — it's a
permanent fixture in the retraining gate. And the formula fallback means
the worst case of "no good candidate" is a safe, A*-legal degrade, not an
outage.

## Project exercises

### RETRAIN.1 — promotion gate with hard legality check

- **Exercise ID:** RETRAIN.1
- **What to build:** a `shouldPromote(candidate, live)` function that
  returns true only if the candidate beats the live model on a held-out-
  user metric AND passes the monotone/≥0/finite-BLOCKED check; otherwise
  it keeps live (or signals formula fallback).
- **Why it earns its place:** it makes the legality check a permanent,
  automated gate so no retrain can silently ship an A*-illegal cost.
- **Files to touch:** new `pipeline/retrain.ts` (the gate, reusing
  `assertMonotoneNonNeg` from MODEL.1 and the run log from LOG.1),
  `retrain.test.ts` (a better-but-non-monotone candidate is REJECTED; a
  better-and-legal one is promoted).
- **Done when:** the test proves a higher-accuracy non-monotone candidate
  is rejected and only a better-and-legal candidate promotes.
- **Estimated effort:** half a day.

## Interview defense

**Q: How would you keep flattr's learned cost current, and what stops a
retrain from breaking routing?** Answer: a retraining pipeline on three
triggers — scheduled, drift-based (PSI fires, the efficient one), and
performance-based as a backstop. The key is the promotion gate: a
candidate promotes only if it beats the live model on a held-out *user*
AND still passes the A* legality check — monotone in grade, ≥0, finite
BLOCKED. That legality check is a *hard* gate inside the automated loop,
not just at first launch, because retraining is exactly where an illegal
model sneaks in with a better metric. If no candidate is both better and
legal, I serve the drift-proof formula. Better-but-illegal is rejected and
logged.

```
  triggers: scheduled | drift | perf
  gate: better-on-held-out-user AND monotone+finite → promote
  legality NO → reject (no matter the metric); none → formula fallback
```

Anchor: *"the legality check lives *inside* the retraining gate, not just
at launch — automated promotion is where a non-monotone cost would
otherwise sneak in and break A*."*

## See also

- [15-drift-detection.md](15-drift-detection.md) — the smart trigger for retraining.
- [14-training-run-logging.md](14-training-run-logging.md) — every retrain is a logged run.
- [04-model-selection.md](04-model-selection.md) — the legality check the gate enforces.
- [11-cold-start.md](11-cold-start.md) — formula fallback when no candidate is fit to promote.
