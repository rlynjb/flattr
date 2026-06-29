# LLM-as-Judge Bias
### industry: *automated grading* — reference material (rung 4 hazards)

## Zoom out

```
LLM-AS-JUDGE — a model grades another model's output
┌──────────────────────────────────────────────────────────────┐
│  output A ─┐                                                    │
│  output B ─┼──▶  JUDGE MODEL + rubric  ──▶  score / winner      │
│  rubric  ──┘                                                    │
└──────────────────────────────────────────────────────────────┘
        powerful when there's NO computable answer —
        but the judge is itself a fallible, biased model
```

You reach for an LLM judge only on rung 4: open-ended output where no regex or
embedding distance captures "good." It scales human judgment, but it imports the
judge's biases into your scoreboard — so you have to *eval the eval*.

## How it works

**Move 1 — the pattern: the judge is a subject with tells.**

```
KNOWN JUDGE BIASES
┌───────────────────────────────────────────────────────────┐
│ POSITION      prefers whichever option is shown first       │
│ VERBOSITY     longer answer reads as "more thorough"        │
│ SELF-PREFER   favors text in its own model's style          │
│ FORMAT        markdown/bullets score above equal plain prose │
└───────────────────────────────────────────────────────────┘
```

Mental model: an LLM judge is not a ruler, it's a *very fast, slightly drunk
grader*. Useful at scale, but it has systematic tilts you must correct for, not
trust away.

**Move 2 — countermeasures, step by step.**

```
DEBIASING MOVES
  position   → run both orders, average (swap A/B, score twice)
  verbosity  → rubric caps length; penalize padding explicitly
  self-prefer→ use a different model family as judge
  drift      → calibrate judge against a small HUMAN-labeled set
```

The last one is the keystone: you validate the judge against a human-graded sample
*before* you trust its verdicts. An uncalibrated judge is an opinion with a
confidence interval you never measured.

**Move 3 — principle.** Use an LLM judge *only when there is no oracle*. If the
correct answer is computable, an objective check beats any judge — it has zero bias
and zero cost. The judge is a last resort for genuinely subjective output, not a
default.

## In this codebase

**Not yet exercised** — and flattr is the perfect illustration of *when you do not
need a judge at all*. flattr's quality questions all have **computable oracles**.

```
flattr has an OBJECTIVE ORACLE → no judge needed
┌──────────────────────────────────────────────────────────────┐
│  bench/run.ts:53    cost = result.path.cost                    │
│  fixtures.ts:46     "Known: shortest S→G = S,A,G (200)"        │
│                                                                │
│  "Is this route good?"  →  is its cost == the optimum?         │
│                            ▲ computable. real answer. no vibes.│
└──────────────────────────────────────────────────────────────┘
```

The bench harness (`bench/run.ts`) compares dijkstra / astar / bidirectional and
reports `cost` per algorithm. Because route cost is a *ground truth you can
compute*, the "judge" is just `===` — A* must return the same optimal cost Dijkstra
does, exactly. There is nothing subjective to grade, so an LLM judge would be pure
downside: slower, costlier, and biased about a question that has a real answer.

**The contrast that matters.** Deterministic problems with oracles (flattr) sit at
the opposite pole from LLM judging. You'd only reach for a judge if flattr produced
something *without* an oracle — e.g. a narration at `summary.ts:11` whose "is this
sentence clear and natural?" has no computable answer. Even then, the lesson holds:
judge *only* the genuinely subjective slice (tone, clarity), and keep the factual
slice (climb = 5 m, distance = 200 m) on rung 1, where the oracle still rules. Most
of an LLM feature's correctness should stay objectively checkable; the judge covers
the irreducible remainder.

## See also
- `02-eval-methods.md` — where rung 4 sits and why you climb to it
- `04-llm-observability.md` — logging judge calls (cost/latency) if one existed
- `bench/run.ts` — the objective oracle (`cost`) that makes a judge unnecessary here
