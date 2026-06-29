# Calibration

*Industry name: probability calibration — predicted scores matching real frequencies.*

## Zoom out

```
A CALIBRATED MODEL KEEPS ITS PROMISES
of all edges it called "70% too steep" ──► ~70% really were
                                            (not 40%, not 95%)
```

A model can rank well (steep edges score higher than flat ones) yet *lie about
probabilities* — saying "0.9" when the real frequency is 0.6. Calibration is the property
that a predicted probability **means** what it says, so you can threshold it, combine it, or
show it to a user as a real confidence. New ground — contrl's rep-counter never emitted a
probability to calibrate.

## How it works

### Move 1 — the mental model: reliability diagram

```
ideal:  predicted = actual  (the diagonal)
actual
freq 1│            ╱  ← ideal
      │        ╱  ●  overconfident model sits BELOW the line:
      │    ╱  ●      says 0.9, only 0.6 true
      │ ╱ ●
     0└────────────► predicted probability
```

Bin predictions (0.0–0.1, 0.1–0.2, ...). In each bin, plot *predicted* vs *actually
observed* frequency. On the diagonal = calibrated. Below = overconfident (common with
neural nets and boosted trees).

### Move 2 — measure it, fix it

1. **Measure.** Bin and plot the reliability diagram; summarize with **Expected
   Calibration Error (ECE)** = average gap between predicted and actual across bins.
2. **Fix (post-hoc, on the validation set):**
   ```
   PLATT SCALING            ISOTONIC REGRESSION
   fit a sigmoid to map     fit a free monotone map
   raw score → calibrated   raw score → calibrated
   (1 param, smooth)        (flexible, needs more data)
   ```
   Note the nice echo: **isotonic regression** shows up here for calibration *and* in file
   04 as the model class for `cost.ts` — same tool (a monotone 1-D fit), two jobs.
3. **Why it matters for flattr:** if a hypothetical model output "probability this edge is
   too steep for you," and you *showed that number* to a rider, an uncalibrated 0.9 that's
   really 0.6 erodes trust fast. Anything user-facing and probabilistic must be calibrated.

### Move 3 — the principle

**Ranking ≠ probability.** A model can order edges perfectly and still be badly calibrated.
If you only need the route ranking, calibration may not matter. The moment a number is
shown to a user or fed into a downstream decision threshold, it must be calibrated to be
honest.

## In this codebase

**NOT YET EXERCISED — flattr has no probabilistic model, so there's nothing to calibrate.**
The honest contrast: flattr deals in **costs and thresholds, not probabilities.**
`features/routing/cost.ts` returns a *cost* (meters × penalty multiplier) — a magnitude,
not a likelihood. `features/grade/classify.ts` returns a *band* by fixed cutoff, not
"P(steep) = 0.7". There is no claimed probability anywhere to check against reality.

Calibration would enter only if a learned `cost.ts` (or a steep-edge classifier) emitted
probabilities you intended to *display* or *threshold*. Even then, the ≥0/monotone
invariant (file 04) constrains the model, and an isotonic calibration map would happen to
respect monotonicity for free.

`classify.ts` thresholds are definitional, not predicted — there's no "predicted
frequency" to align with an "observed frequency."

## See also

- `04-model-selection.md` — isotonic regression as the cost model (same tool, other job)
- `08-confusion-matrices.md` — calibrated probabilities feed the threshold you tabulate
- `05-class-imbalance.md` — threshold moves under imbalance shift calibration
</content>
