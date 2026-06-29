# 08 — Few-shot prompting

*Industry name(s): "few-shot prompting," "in-context examples,"
"demonstrations," "k-shot." Type label: Industry standard.*

> **Seam, not present.** flattr has no prompt to add examples to. But it has
> the perfect example *source*: `features/routing/fixtures.ts` already pairs
> structured inputs (graphs) with known outputs. Those pairs are exactly what
> few-shot examples are made of. This file teaches few-shot against Seam 1's
> "describe my route" prompt, with examples drawn from real fixtures.

## Zoom out — where examples sit in the prompt

Few-shot is the few input→output pairs you put in the prompt to show the model
the shape of a good answer. They sit in the prompt's example section (concept
01, section 3), between the rules and the per-call data.

```
  Zoom out — few-shot examples in the Seam 1 prompt

  ┌─ prompt ────────────────────────────────────────────────────────┐
  │ [system]   rules: one sentence, honest about steep              │
  │ [FEW-SHOT] ★ in: {d=200,climb=0,steep=0} → "Flat 0.2 km."  ★    │
  │            ★ in: {d=200,climb=9,steep=1} → "0.2 km, 1 steep." ★ │
  │ [context]  {d=3200, climb=45, steep=0}   ← this call            │
  └──────────────────────────────────────────────────────────────────┘
        examples DRAWN FROM fixtures.ts (diamond / grade graphs)
```

## Zoom in

The pattern: **show 3–5 input→output pairs and the model imitates the shape —
examples constrain output harder than instructions do.** You can write "be
concise and honest about steepness" in the system prompt all day; one example
of a steep route described honestly teaches it more reliably than the
sentence. The cost: examples eat context tokens (concept 04), so 3–5 good ones
beat 20 mediocre ones.

## The structure pass

**Layers:** instruction → example → output.
**Axis:** *constraint strength* — how hard does this pin the output shape?
**Seam:** the instruction→example boundary, where vague guidance becomes a
concrete pattern the model copies.

```
  axis = "how hard does this constrain the output?"

  ┌─ instruction ─┐ constraint: SOFT — "be concise" is interpretable
  │  ── seam ──      ◄── constraint strength JUMPS at the example
  └─ example ─────┘ constraint: HARD — model copies the exact shape
```

## How it works

### Move 1 — the mental model

You know that a Storybook story or a test fixture communicates "what good looks
like" faster than a paragraph of prop docs. A reviewer learns your component's
intended use from one good example faster than from the README. Few-shot is
that: the example is the spec. flattr's `fixtures.ts` already encodes
"what good looks like" for the router — `gradeGraph()` *is* a demonstration of
the flat-vs-steep tradeoff. Few-shot reuses that instinct for the prompt.

```
  Pattern — few-shot as imitation

  [ example_in_1 → example_out_1 ]  ┐
  [ example_in_2 → example_out_2 ]  ├─ model infers the mapping
  [ example_in_3 → example_out_3 ]  ┘
  [ real_in              → ? ]  ──► output matches the demonstrated shape
```

### Move 2 — building few-shot from flattr's fixtures

**Step 1 — pull examples from real fixtures.** The fixtures already pair a
structured situation with a known answer:

```ts
// features/routing/fixtures.ts:67-83 — EXISTS
/** Flat-vs-steep choice. Short path via H is steep; long path via L is flat. */
export function gradeGraph(): Graph { ... }
```

Run the router on it, get the `RouteSummary`, and pair it with a hand-written
ideal description. That pair is a few-shot example grounded in real flattr
behavior — not invented:

```
  // FUTURE — few-shot section, derived from fixtures
  in:  {distanceM:320, climbM:0, steepCount:0}  → "Flat 0.3 km, no climbs."
  in:  {distanceM:200, climbM:9, steepCount:1}  → "0.2 km — 1 steep block, mostly flat."
```

**Step 2 — choose examples that cover the decision boundaries.** Few-shot
quality is about *coverage*, not count. The two examples above teach the model
the most important flattr distinction: the honesty pivot at `steepCount > 0`.
Pick examples that sit on either side of the boundary you care about — exactly
why flattr's fixtures are *separate named graphs* for diamond / grade /
directional, each isolating one behavior.

**Step 3 — 3–5 good beats 20 mediocre.** Each example costs context tokens
(concept 04). More examples isn't better past a point — redundant examples
("here are five more flat routes") add tokens without adding constraint. Pick
examples that each teach something the others don't.

```
  Layers-and-hops — few-shot examples crossing into the prompt

  ┌─ fixtures.ts ─┐ run router  ┌─ RouteSummary ─┐ hand-write ideal
  │ gradeGraph()  │ ──────────► │ {d,climb,steep}│ ──────────────┐
  └───────────────┘             └────────────────┘                ▼
                                            ┌─ prompt few-shot section ─┐
                                            │ in → out (×3-5, on the    │
                                            │ honesty boundary)         │
                                            └───────────────────────────┘
```

**Step 4 — the interaction with structured output.** When Seam 2 parses NL
into `{lat,lng}` JSON (concept 02), a few-shot example *is* the structured
form: `"flat park near the lake" → {queryHint:"park", near:"lake"}`. The
example demonstrates the schema and the parse simultaneously. Few-shot +
structured output compound.

### Move 2 variant — load-bearing skeleton

Kernel: **examples that straddle the decision boundary**. What breaks:

- **No examples** → output drifts in tone and structure; "be honest" alone
  doesn't pin steepness honesty. *Load-bearing for format-sensitive output.*
- **Examples all on one side of the boundary** → model never learns the pivot;
  describes a steep route as flat. *Load-bearing — coverage, not count.*
- **20 redundant examples** → burns tokens (concept 04), no extra constraint.
  *Anti-hardening — actively worse.*

### When NOT to use few-shot

Open-ended generation where you *want* variety (concept 13's rotation) — heavy
few-shot pins the output too hard and every route sounds like the examples.
And simple structured classifiers where the schema (concept 02) already
constrains fully. Few-shot is for format-sensitive output where instructions
underspecify.

### Move 3 — the principle

An example is a stronger spec than an instruction because it removes
interpretation. Spend your few examples on the decision boundaries that matter,
not on volume — coverage beats count, and every example costs tokens.

## Primary diagram

```
  Few-shot for Seam 1, examples from fixtures.ts (FUTURE)

  ┌─ prompt ────────────────────────────────────────────────────────┐
  │ [system] one sentence; honest about steep                       │
  │ [few-shot] ←── from fixtures.ts ──→                             │
  │   {d=320,climb=0,steep=0} → "Flat 0.3 km, no climbs."           │
  │   {d=200,climb=9,steep=1} → "0.2 km — 1 steep block."  ← BOUNDARY│
  │ [context] {d=3200,climb=45,steep=0}  ← this call                │
  └───────────────────────────┬─────────────────────────────────────┘
                              ▼  output imitates the demonstrated shape
                    "Flat 3.2 km route, no steep blocks."
```

## Elaborate

Few-shot is the original "prompt engineering" technique from the GPT-3 paper
("Language Models are Few-Shot Learners") and remains the highest-leverage
move for format-sensitive output. The reader has shipped it in loopd's intent
classifier (explicit examples) — same pattern. The modern caveat: frontier
models need *fewer* examples than they used to for simple tasks, but for
honesty-on-a-boundary (flattr's steep pivot) a couple of well-chosen examples
still earn their tokens. Read `02-structured-outputs.md` for the few-shot +
schema interaction and `13-forbidden-patterns.md` for why too-strong few-shot
makes every output identical.

## Interview defense

**Q: "Instructions or examples to constrain output?"** Examples, when the
output is format-sensitive — they remove interpretation. "Be honest about
steepness" is interpretable; one example of a steep route described honestly is
not. But spend examples on the decision boundary (flattr: `steepCount>0`), not
on volume — 3–5 well-chosen beats 20 redundant, because each costs tokens.

```
  instruction "be concise"  → soft, interpretable
  example {steep=1}→"1 steep" → hard, copied. Cover BOTH sides of the pivot.
```

Anchor: *"flattr's `fixtures.ts` is a ready-made example source — run the
router on `gradeGraph()`, pair the `RouteSummary` with an ideal description,
and you have a few-shot example grounded in real behavior, sitting right on the
honesty boundary."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — examples can BE the
  schema
- [04-token-budgeting.md](04-token-budgeting.md) — examples cost context tokens
- [13-forbidden-patterns.md](13-forbidden-patterns.md) — when examples
  over-constrain
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — fixtures feed
  both evals and examples
</content>
