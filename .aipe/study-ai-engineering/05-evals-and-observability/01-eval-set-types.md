# Eval Set Types
### industry: *eval datasets* — reference material (golden / adversarial / regression)

## Zoom out

```
EVAL SETS — three jobs, three shapes
┌───────────────────────────────────────────────────────────┐
│  GOLDEN      input → KNOWN-GOOD output     "did it work?"   │
│  ADVERSARIAL nasty input → must-not-fail   "can I break it?"│
│  REGRESSION  past bugs frozen as cases     "did it re-break?"│
└───────────────────────────────────────────────────────────┘
                          │
                          ▼
              one curated set per job, version-controlled,
              run on every change — the test suite for AI output
```

An eval set is a *dataset*, not an assertion. You curate inputs paired with
expectations, then run a method (next file) to score outputs against them. The
three types differ by what they're *for*: golden proves the happy path, adversarial
hunts failure, regression nails shut bugs you already paid for once.

## How it works

**Move 1 — the pattern: a fixture is an input/expectation pair.**

```
ONE EVAL CASE
┌──────────────┐        ┌──────────────────────┐
│  input       │  ──▶   │  expectation         │
│  "S → G"     │        │  path = S,A,G  cost=200│
└──────────────┘        └──────────────────────┘
        the set is just MANY of these, chosen on purpose
```

Mental model: a golden set is a frozen answer key. The art is *curation* — which
inputs earn a slot. You want cases that are representative (cover real usage),
discriminating (a regression actually flips them), and stable (the expectation
doesn't drift with irrelevant changes).

**Move 2 — building each type, step by step.**

```
GOLDEN        pick representative inputs → capture trusted output → freeze
ADVERSARIAL   brainstorm attacks/edge inputs → assert it degrades safely
REGRESSION    every shipped bug → add the failing input + its fixed output
```

For deterministic code the "trusted output" is *the exact value*. For LLM output
it's a *property* of the output (contains the climb figure, ≤ 2 sentences, no
hallucinated street), because the exact string is non-deterministic — that's the
whole reason LLM evals are a different discipline (file 02).

**Move 3 — principle.** A golden set is the unit of trust. Without one, "it got
better" is a vibe; with one, it's a diff. The set is a product artifact you grow
forever — every escaped bug becomes a regression case so it can never escape twice.

## In this codebase

**Not yet exercised** — flattr has no LLM, so no LLM eval set. But the *shape* is
already here for deterministic code, and it's worth seeing clearly.

```
flattr's golden-set analog (DETERMINISTIC)
┌─────────────────────────────────────────────────────────────┐
│  features/routing/fixtures.ts                                 │
│    diamondGraph()    → "Known: shortest S→G = S,A,G (200)"    │  golden
│    gradeGraph()      → short-steep vs long-flat choice        │  golden
│    directionalGraph()→ uphill X→Y vs flat detour              │  adversarial-ish
│    makeGridGraph(n)  → bench inputs (interior pairs only)     │  perf set
└─────────────────────────────────────────────────────────────┘
              ▲ exact expected path baked into the comment + test
```

These are *golden-set-shaped*: a hand-built input with a known-good answer, paired
with an exact assertion in the co-located `*.test.ts`. `directionalGraph()` even
leans adversarial — it deliberately forces the detour edges flat (fixtures.ts:99)
to trap a router that ignores travel direction.

**The gap an LLM feature opens.** If a narration were added at
`features/routing/summary.ts:11` (turning the `RouteSummary` into a sentence), the
fixtures above stop being enough. You'd need a *new* golden set:
`route → expected-sentence-properties` — e.g. "mentions the 5 m climb, names no
street not in the path, ≤ 2 sentences." Same curation discipline, but the
expectation flips from an exact string to a checkable property, because the model's
exact wording is non-deterministic. flattr has the curation muscle; it has never
had to point it at a non-deterministic output.

## See also
- `02-eval-methods.md` — how you *score* against these sets (and why LLM forces fuzzy)
- `features/routing/fixtures.ts` — the real golden-shaped fixtures
- `features/routing/summary.test.ts` — exact-match assertions over a fixture
