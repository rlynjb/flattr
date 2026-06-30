# 10 · Self-critique and self-consistency

> Industry name: self-critique / self-refine / self-consistency (majority vote) · Type label: Industry standard

> **Status: seam, not feature.** flattr runs no model output through a review step — but Seam 1's route description is exactly the kind of output where a wrong word ("flat" when `steepCount` was 3) misleads a user on a hill. This file maps self-critique and self-consistency onto that seam, with `penalty()`/`routeSummary` as the ground truth to check against.

## Zoom out — where this concept lives

Self-critique and self-consistency are reliability layers you add *after* a chain produces output, before you trust it. Here's where they'd wrap Seam 1:

```
  Zoom out — reliability layers wrapping Seam 1's description

  ┌─ Chain: describe ────────────────────────────────────────────┐
  │ routeSummary → LLM → "Mostly flat, 2.1km" (draft)            │
  └─────────────────────────┬────────────────────────────────────┘
                            │ before trusting it
  ┌─ Reliability layer (SEAM) ▼──────────────────────────────────┐
  │ ★ THIS FILE ★                                               │ ← we are here
  │ self-critique: "does this match steepCount=1?" → revise      │
  │ self-consistency: run N times, vote on the answer            │
  │ cost: 2-5x tokens for one step of reliability                │
  └─────────────────────────┬────────────────────────────────────┘
                            │ trusted output
  ┌─ UI ────────────────────▼────────────────────────────────────┐
  │ RouteSummaryCard shows the description                        │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. Two related patterns: **self-critique** — ask the model to evaluate its own output against criteria and revise — and **self-consistency** — run the same prompt N times and vote on the answer. Both buy reliability for 2-5x the token budget, both have a sharp limit: a model critiquing itself shares the blind spots that produced the error. Let me build them.

## Structure pass

**Layers.** Two: the *generation* (the draft) and the *verification* (critique or vote). The key question is whether the verification has *independent ground truth* or just re-asks the same model. flattr supplies real ground truth — `routeSummary` and `penalty` are deterministic facts the critique can check against.

**Axis — trust (can the verifier catch what the generator missed?).**

```
  One axis — "does the check have independent signal?" — across the layers

  self-critique vs ITSELF:   same model, same blind spots
    → catches surface errors, misses its own systematic ones

  self-critique vs GROUND TRUTH (routeSummary facts):
    → "you said 'flat' but steepCount=1" → catches the real error

  the seam: trust flips when the verifier has signal the generator lacked
```

**Seam.** The load-bearing boundary is *between self-reference and external reference*. A model checking its own work against itself has diminishing returns (its blind spots produced the error and persist into the critique). A model checking its output against *deterministic facts it didn't generate* — flattr's `steepCount`, `climbM` — has real signal. That flip is the whole design decision.

## How it works

### Move 1 — the mental model

You know code review catches more when the reviewer wasn't the author — a second set of eyes sees what the first missed. Self-critique is the model reviewing its own PR: better than nothing, but it shares the author's blind spots. Self-consistency is running the flaky test five times and trusting the majority result. Both are familiar reliability moves; the LLM versions cost tokens instead of CI minutes.

```
  The two kernels — critique loop and consistency vote

  self-critique:                 self-consistency:
  ┌─ generate draft ─┐           ┌─ run N times ────────────┐
  │                  │           │ out1 out2 out3 out4 out5 │
  ┌─ critique it ────┐           └──────────┬───────────────┘
  │ vs criteria/facts│                      │ majority vote
  ┌─ revise ─────────┐           ┌─ pick the modal answer ──┐
  │                  │           │                          │
  └──────────────────┘           └──────────────────────────┘
   1 gen + 1-2 critique          N gens (N=3..5 typical)
```

### Move 2 — the step-by-step walkthrough

**Self-critique — ask the model to evaluate, then revise.** Step one: generate the draft description. Step two: a second call asks "does this description accurately reflect the route? Check it against these facts." Step three: revise based on the critique. For Seam 1, the *facts* are the gift flattr provides — `routeSummary` already computed the ground truth:

```ts
// features/routing/summary.ts:5 — the ground truth the critique checks against
export type RouteSummary = {
  distanceM: number;    // critique: does the prose's distance match?
  climbM: number;       // critique: if climbM>10, did it mention the climb?
  steepCount: number;   // critique: did it say "flat" while steepCount>0?  ← the catch
};
```

The critique isn't the model second-guessing its vibes — it's the model checking its prose against *deterministic numbers it didn't make up*. "You wrote 'flat' but `steepCount` is 1" is a real, grounded correction. That's self-critique with external signal, which is the version that works.

```
  Hop — self-critique against routeSummary ground truth

  ┌─ draft ──────────┐  "Flat, 2.1km"  ┌─ critique call ────────┐
  │ describe (LLM)   │ ──────────────► │ check vs {steepCount:1}│
  └──────────────────┘                 │ → "MISMATCH: said flat,│
                                       │    steepCount=1"       │
                                       └──────────┬─────────────┘
                                                  │ revise
                                       ┌─ corrected ────────────┐
                                       │ "Mostly flat, 2.1km,   │
                                       │  one short climb"      │
                                       └────────────────────────┘
```

**Self-consistency — run N times, vote.** For a *decision* (not prose) — say Seam 2's parse of an ambiguous query, or the climb-warning decision from `09` — run the same prompt 3-5 times at nonzero temperature and take the majority answer. The intuition: a correct answer is a stable attractor; errors scatter. If 4 of 5 runs say `preferFlat: true`, that's your answer. This works for discrete answers (the votes have to be comparable) and not for prose (no two descriptions are identical to vote on).

**Cost — 2-5x token budget.** Self-critique is roughly 2-3x (generate + critique + revise). Self-consistency is Nx (N full generations). You're buying one step of reliability with a multiple of your token spend, so you apply it *selectively*.

**When the extra cost is worth it.** High-stakes outputs (the description that sends someone up a hill they wanted to avoid — flattr's whole point is grade safety), low-trust classifiers (an ambiguous parse where a wrong `preferFlat` ruins the route), and content hard to manually review at volume. flattr's spec even has the analog: `BLOCKED` is large-finite specifically so "no flat route" stays *honest and distinct* — the system already cares about not lying about grade. A description that says "flat" about a steep route violates that same value, which is exactly where the critique-against-`steepCount` step earns its tokens.

**The diminishing-returns limit — shared blind spots.** A model critiquing its own output has the same blind spots that produced it. If the model systematically under-weights short steep stretches, it'll under-weight them in the critique too. This is why the *external ground truth* matters so much here: self-critique against `routeSummary`'s deterministic numbers escapes the shared-blind-spot trap, because the numbers came from `penalty()` and the graph, not from the model. Pure self-critique (model vs its own judgment, no external facts) catches sloppy surface errors and misses systematic ones — useful, but bounded.

```
  The diminishing-returns boundary

  model critiques itself, no facts:   catches typos, misses its biases
  model critiques vs routeSummary:    catches "flat" when steepCount>0
                                      (external signal breaks the loop)
  → always give the critique ground truth it didn't generate
```

### Move 3 — the principle

Self-critique and self-consistency buy reliability for a multiple of token spend, and you spend it only where the output is high-stakes or hard to review. The decisive design choice is whether the verifier has *independent signal*: a model checking itself shares its blind spots, but a model checking its prose against deterministic facts it didn't generate (flattr's `routeSummary`, `penalty`) escapes that trap. The lesson generalizes: self-critique is only as good as the ground truth you hand the critic. When you have real facts, ground the critique in them; when you don't, expect diminishing returns and prove the gain with evals (`05`).

## Primary diagram

The full reliability layer at Seam 1, both patterns, with the ground-truth grounding marked.

```
  Self-critique + self-consistency at Seam 1

  ┌─ Generate ───────────────────────────────────────────────────┐
  │ describe(routeSummary) → draft prose                         │
  └─────────────────────────┬────────────────────────────────────┘
            ┌───────────────┴───────────────┐
  ┌─ Self-critique ─────────┐     ┌─ Self-consistency ───────────┐
  │ check draft vs          │     │ (for DECISIONS, not prose)   │
  │ routeSummary facts:     │     │ run N times → vote           │
  │  steepCount, climbM     │     │  e.g. preferFlat: 4/5 → true │
  │ ★ external ground truth │     │  cost: N×                    │
  │   → escapes blind spots │     └──────────────────────────────┘
  │ → revise                │
  │ cost: 2-3×              │
  └─────────────────────────┘
            │ trusted output
  ┌─ UI ────▼────────────────────────────────────────────────────┐
  │ RouteSummaryCard — now safe to claim "flat"                  │
  └──────────────────────────────────────────────────────────────┘
   apply selectively: high-stakes (grade safety) only
```

## Elaborate

Self-consistency comes from Wang et al.'s "Self-Consistency" paper (sample diverse reasoning paths, marginalize over the answer); self-critique/self-refine from Madaan et al.'s "Self-Refine." The production nuance the papers underplay is the shared-blind-spot ceiling — which is why the strongest version in practice grounds the critique in external signal (a validator, a retrieval check, or here, deterministic domain facts). flattr is an unusually clean teacher because the ground truth is *already computed and sitting right next to the seam*: `routeSummary` and `penalty` are facts the model didn't generate, so a critique against them has real teeth. This connects forward to agentic patterns (`study-agent-architecture`) where the "critic" becomes a tool that checks output against the world.

## Project exercises

### EX-CRITIQUE-1 — Ground-truth self-critique for descriptions

- **Exercise ID:** EX-CRITIQUE-1
- **What to build:** A `describeWithCheck(summary)` that generates a description, runs a critique call comparing it against `summary.steepCount`/`climbM`, and revises on mismatch — logging how often the critique caught a "flat"-but-steep error.
- **Why it earns its place:** Demonstrates self-critique *with external ground truth*, the version that escapes shared blind spots, using facts flattr already computes.
- **Files to touch:** new `features/routing/describe-checked.ts`; uses `RouteSummary` from `summary.ts`.
- **Done when:** an injected wrong description ("flat" for a steepCount=2 route) is caught and corrected by the critique step.
- **Estimated effort:** 3-4 hours.

## Interview defense

**Q: What's the limit of self-critique?**

Shared blind spots — a model critiquing its own output has the same biases that produced it, so it catches surface errors and misses systematic ones. The fix is to ground the critique in external signal: deterministic facts the model didn't generate.

```
  critique vs self          → bounded (shared blind spots)
  critique vs routeSummary  → real signal ("flat" but steepCount=1)
```

Anchor: flattr's `routeSummary` gives the critique ground truth (`steepCount`, `climbM`) the model didn't make up — that's what makes the check work.

**Q: When is 2-5x the token cost worth it?**

High-stakes outputs, low-trust classifiers, content hard to review at volume. flattr's grade-safety mission is the case: a description that says "flat" about a steep route is the exact failure the whole product exists to prevent, so the critique-against-`steepCount` step earns its tokens.

## See also

- `05-eval-driven-iteration.md` — proving the reliability gain is real
- `09-chain-of-thought.md` — the cheaper reliability step below this one
- `02-structured-outputs.md` — the critique's verdict as a structured field
- `13-forbidden-patterns.md` — the other selective-cost generation concern
