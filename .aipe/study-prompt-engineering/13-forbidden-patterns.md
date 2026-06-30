# 13 · Forbidden patterns and rotating formulas

> Industry name: forbidden patterns / anti-repetition / rotating formulas · Type label: Industry standard

> **Status: seam, not feature.** flattr generates no text, so nothing repeats yet. But Seam 1's "describe my route" is a generative chain run *over and over for the same user* — every walk they plan gets a description — and that's exactly the setup where every output converges on the same phrasing. This file maps the anti-repetition technique onto that seam.

## Zoom out — where this concept lives

This concern only exists for generative chains run repeatedly. Seam 1 is precisely that — and it's the only seam this applies to:

```
  Zoom out — forbidden patterns, on the repeated describe chain

  ┌─ Seam 1: describe (run per route, many times per user) ──────┐
  │ route 1 → "Mostly flat, 2.1km, one short climb."            │
  │ route 2 → "Mostly flat, 3.4km, one short climb."  ← same shape│
  │ route 3 → "Mostly flat, 1.8km, one short climb."  ← AGAIN    │
  │ ★ THIS FILE: stop every description sounding identical ★     │ ← we are here
  └──────────────────────────────────────────────────────────────┘

  ┌─ Seam 2: parse / classifiers ────────────────────────────────┐
  │ output is a struct — repetition is CORRECT, not a problem    │
  │ (this technique does NOT apply here)                         │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **LLMs converge on phrasings — run the same generative chain repeatedly and every output opens the same way — so you explicitly list forbidden openings and enumerate rotating formulas to force variety.** It matters for repeated generation and is meaningless (even harmful) for one-shot classifiers and structured outputs. Let me build it.

## Structure pass

**Layers.** Two: the *forbidden list* (phrasings the model must not use) and the *rotation state* (what it used recently, so it picks something different next time). The second layer is what makes it work over a sequence — without memory of recent outputs, you can forbid openings but not rotate through alternatives.

**Axis — state (does the chain remember its prior outputs?).**

```
  One axis — "does this call know what the last call said?" — for repetition

  stateless describe:   each call independent → all converge on "Mostly flat"
  rotation-aware:       call knows recent openings → picks an unused one

  the seam: variety requires the chain to carry rotation STATE across calls
```

**Seam.** The load-bearing boundary is *between stateless and rotation-aware generation*. A stateless chain has no way to avoid repeating itself — every call independently lands on the model's favorite phrasing. Variety requires threading a small piece of state (recent openings) into each call. That's the design flip.

## How it works

### Move 1 — the mental model

You know how a `Math.random()`-free shuffle that just picks "the next item" gives you the same order every time — you need to *track what you've shown* to avoid repeats. Anti-repetition for LLM output is that: the model's untracked default is to repeat its highest-probability phrasing, so you track recent outputs and forbid them, forcing it down to its second and third choices.

```
  The forbidden-patterns kernel — forbid + rotate with memory

  ┌─ forbidden openings (constant) ──────────────────────┐
  │ never start with: "Mostly flat", "This route is",    │
  │ "Your route"                                         │
  ├─ rotating formulas (enumerated) ─────────────────────┤
  │ A: lead with distance   B: lead with the climb       │
  │ C: lead with the terrain feel                        │
  ├─ rotation state (per user, recent) ──────────────────┤
  │ last used: [A, A, C] → this call: avoid A, prefer B  │
  └──────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Why outputs converge.** A model samples high-probability continuations. For "describe a flat route," "Mostly flat" is the highest-probability opening, so absent any pressure, *every* description opens with it. The user planning their fifth walk this week reads "Mostly flat, X km, one climb" for the fifth time and the feature feels robotic. flattr's whole value is being a *companion* for repeated self-powered travel — the same user routes daily — so this is the exact usage pattern where convergence shows.

**Forbidden openings — the constant list.** In the system prompt, enumerate phrasings the model must not use: "Never open with 'Mostly flat', 'This route', or 'Your route'." This is a constant section (`01-anatomy.md`), part of the prompt's frame. It's blunt but effective — removing the model's defaults forces it to find alternatives. The boundary condition: forbid too much and you constrain the model into awkward phrasings, so the list is the few real offenders, not a thesaurus.

**Rotating formulas — enumerate the structures.** Beyond forbidding openings, give the model a *menu* of description shapes for the same `RouteSummary`:

```
  Hop — same RouteSummary, rotated through formulas

  RouteSummary {distanceM:2100, climbM:14, steepCount:1}
        │
   ┌────┼─────────────────────────────────────────┐
   │ A  │ "2.1km, mostly easy — one short climb."  │ (distance-led)
   │ B  │ "One short climb to watch, otherwise     │ (climb-led)
   │    │  flat for 2.1km."                        │
   │ C  │ "Gentle going, with a single steep       │ (terrain-led)
   │    │  stretch over 2.1km."                    │
   └────┴─────────────────────────────────────────┘
   rotation state picks a formula not used recently
```

All three describe the *same* route accurately — they differ in what they lead with. The rotation cycles the lead so consecutive descriptions feel distinct without ever being inaccurate.

**Rotation state — the memory that makes it work.** The chain carries a small per-user record of recent formulas/openings (the spec's "rotation history") and injects it: "you recently used formula A twice; use a different one." This is the state layer. flattr already has the infrastructure instinct for per-user state in `mobile/` (the app holds user context), so threading a 3-element recent-openings array into the describe call is cheap. Without this state, you can forbid the global defaults but you can't rotate — the chain has no idea what *it* said last time.

**When it matters vs when it doesn't.** Matters: any generative chain run repeatedly for the same user — Seam 1's description is the case, especially given flattr's daily-companion usage. Doesn't matter, and is actively wrong: one-shot classifiers and structured outputs. Seam 2's parse *should* produce the same struct for the same query every time — repetition there is correctness, and forbidding "repeated" outputs would be nonsensical. So this technique is scoped tightly to repeated free-text generation. Applying it to a classifier is a category error.

```
  Scope — where forbidden patterns apply

  Seam 1 describe (repeated, free text)  → APPLY (forbid + rotate)
  Seam 2 parse (classifier, struct)      → DO NOT (repetition = correct)
  one-shot generation (run once)         → DO NOT (no convergence to fight)
```

### Move 3 — the principle

Models converge on their highest-probability phrasing, so repeated generative chains need explicit anti-repetition: forbid the defaults, enumerate rotating formulas, and thread recent-output state so the chain can actually rotate. The scope is narrow and worth stating precisely — it applies only to free-text generation run repeatedly for the same user, and it's a category error on classifiers and structured outputs, where repetition is the correct behavior. flattr's daily-companion usage makes Seam 1 the textbook case; its structured Seam 2 is the textbook non-case.

## Primary diagram

The full anti-repetition setup on the repeated describe chain, all three layers and the scope boundary marked.

```
  Forbidden patterns — anti-repetition on the repeated describe chain

  ┌─ Prompt (Seam 1, constant frame) ────────────────────────────┐
  │ forbidden openings: "Mostly flat" | "This route" | "Your route"│
  │ rotating formulas:  A distance-led | B climb-led | C terrain  │
  └─────────────────────────┬────────────────────────────────────┘
                            │ + per-call rotation state
  ┌─ Per-call (rotation memory) ▼────────────────────────────────┐
  │ recent openings: [A, A, C] → "avoid A, prefer B this call"   │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Output ────────────────▼────────────────────────────────────┐
  │ each description accurate, distinct lead → no robotic sameness │
  └──────────────────────────────────────────────────────────────┘
   SCOPE: repeated free-text generation ONLY
   NOT classifiers / structured outputs (repetition = correct there)
```

## Elaborate

This is loopd's caption chain made literal (from `me.md`'s portfolio) — a caption generator run repeatedly converges, and the rotation-history mechanism is the fix. The underlying cause is sampling: a model maximizes likelihood, and the most-likely phrasing is most-likely *every time*, so without pressure the distribution collapses to one opening. The forbidden list and rotating formulas are crude but effective likelihood-shaping at the prompt level — you're manually removing the modes the model would otherwise camp on. There's a temperature lever too (higher temperature broadens sampling), but temperature alone gives you random variation, not *structured* variation across distinct, accurate formulas — which is why the enumerated-formula approach beats just turning the knob up. The scope discipline is the part people get wrong: applying anti-repetition to a structured-output chain (Seam 2) fights the exact determinism you want there.

## Project exercises

### EX-FORBID-1 — Rotating route descriptions with history

- **Exercise ID:** EX-FORBID-1
- **What to build:** A `describeRotating(summary, recentOpenings)` that injects a forbidden-openings list and a rotating-formula menu, threads a recent-openings array, and produces a distinct-leading description each call for the same `RouteSummary`.
- **Why it earns its place:** Exercises the rotation-state layer (the part that makes anti-repetition actually work over a sequence) and the scope boundary (it's wrong on Seam 2).
- **Files to touch:** new `features/routing/describe-rotating.ts`; consumes `RouteSummary` from `summary.ts`.
- **Done when:** five consecutive descriptions of the same route lead differently and all remain accurate; the same code applied to a struct output is shown to be a no-op/error.
- **Estimated effort:** 2-3 hours.

## Interview defense

**Q: Why do repeated generative outputs all sound the same, and how do you fix it?**

The model maximizes likelihood, so its highest-probability phrasing wins every time and outputs converge. Fix: forbid the default openings, enumerate rotating formulas (same content, different lead), and thread recent-output state so the chain can rotate instead of repeating.

```
  no pressure: every route → "Mostly flat..."
  + forbidden list + rotating formulas + rotation state → distinct leads
```

Anchor: flattr's daily-companion usage means the same user gets many descriptions — the exact setup where convergence shows.

**Q: Would you apply this to flattr's destination parser?**

No — category error. The parser (Seam 2) is a classifier emitting a struct; the same query *should* produce the same struct every time. Repetition there is correctness. Anti-repetition is scoped to repeated free-text generation, not structured outputs or one-shot calls.

## See also

- `01-anatomy.md` — the constant section the forbidden list lives in
- `02-structured-outputs.md` — the non-case where repetition is correct
- `10-self-critique.md` — the other selective-spend generation concern
- `05-eval-driven-iteration.md` — measuring whether rotation actually improved variety
