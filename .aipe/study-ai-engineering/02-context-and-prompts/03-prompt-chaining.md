# Prompt Chaining
*Industry name: prompt chaining · Type: multi-step decomposition pattern*

## Zoom out

```
ONE BIG PROMPT  vs  A CHAIN OF SMALL ONES
┌───────────────────────┐      ┌────────┐   ┌────────┐   ┌────────┐
│ do everything at once  │      │ step 1 │──►│ step 2 │──►│ step 3 │
│ (vague, hard to debug) │      │ extract│   │ decide │   │ phrase │
└───────────────────────┘      └────────┘   └────────┘   └────────┘
        one tangled job              each step: ONE job, inspectable output
```

Prompt chaining is splitting a task into a sequence of model calls where each
call does exactly one thing and hands a clean, structured result to the next.
The wins: every step is debuggable in isolation, you can swap a cheap model into
the easy early steps and reserve the expensive model for the synthesis at the
end, and a wrong answer tells you *which* step failed instead of "the prompt is
bad."

You already shipped this shape in loopd-style work: summarize the clip, then
caption it with tone. That's a two-link chain — extraction feeding generation.

## How it works

**Move 1 — One step, one job, one checkable output.**

```
STEP CONTRACT
input ──► [ prompt with a single objective ] ──► structured output
                                                  (JSON / typed, not prose)
              ▲ if this step is wrong, you see it HERE, not three steps later
```

Mental model: treat each link like a pure function. It takes typed input,
returns typed output, and you can write an assertion on that output before it
flows downstream. Prose-to-prose chaining hides errors; structured handoffs
expose them.

**Move 2 — Stage the chain by cost and certainty.**

```
COST-AWARE CHAIN
[ cheap/fast model ]      [ cheap model ]      [ expensive model ]
 normalize + extract  ──►  classify/route  ──►  synthesize final answer
   high volume, easy        deterministic         where quality matters
```

Step by step: (1) do mechanical work (parsing, extraction, normalization) with a
small model or even plain code; (2) make routing/decisions in the middle, cheap;
(3) spend your strongest model only on the final synthesis where phrasing and
judgment count; (4) validate each handoff so a bad early output doesn't silently
poison the expensive last call.

**Move 3 — Principle:** *decompose until each step is trivially verifiable, then
spend compute where it actually moves quality.*

## In this codebase

**Not yet exercised in flattr.** No LLM runs today, so no chain exists. But of
the three concepts in this section, chaining is the one with a genuinely
plausible attachment point — **seam 2**, the output-to-prompt path.

```
PROPOSED 2-STEP CHAIN over summary.ts:11  (not built)
RouteSummary                  step 1 (code/cheap)        step 2 (model)
{distanceM, climbM,   ──►  shape numbers into facts  ──►  narrate in a
 steepCount}               "1.2km, 80m climb, 2       tone ("encouraging",
 summary.ts:11             steep segments"            "terse")
                                  │                          │
                           assert: units correct      consumed where the
                           before narrating           card renders today
                                                       (MapScreen.tsx:159 →
                                                        RouteSummaryCard.tsx)
```

Today `routeSummary` returns the typed payload, `MapScreen.tsx:159` consumes it,
and `RouteSummaryCard.tsx` renders it as plain UI — no model in the loop. A
chain would slot step 1 as pure formatting (no model needed — it's three
numbers) and reserve a single model call for step 2's tone. Note the asymmetry:
the "extract" link is so trivial here it shouldn't be a model call at all, which
is itself the lesson — chain only where a step earns its compute. Still **not
exercised**; this is the design, not the deployment.

## See also
- `01-context-window.md` — why each short step keeps its window near-empty
- `02-lost-in-the-middle.md` — chaining sidesteps it by never building long context
- `features/routing/summary.ts:11` · `mobile/src/MapScreen.tsx:159` — the seam
