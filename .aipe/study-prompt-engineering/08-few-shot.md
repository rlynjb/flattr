# 08 · Few-shot prompting

> Industry name: few-shot prompting / in-context examples · Type label: Industry standard

> **Status: seam, not feature.** flattr has no prompts to put examples in — but it has the perfect *source* of examples: `features/routing/fixtures.ts` produces routes with known, hand-checkable outputs. This file maps few-shot onto Seam 1 and Seam 2, drawing examples from those golden graphs.

## Zoom out — where this concept lives

Few-shot examples live in the constant section of the prompt (`01-anatomy.md`), between the system prompt and the per-call context. Here's where they'd sit and where they'd come from:

```
  Zoom out — few-shot examples, sourced from fixtures.ts

  ┌─ Source: fixtures.ts (golden graphs) ────────────────────────┐
  │ diamondGraph → known path  gradeGraph → flat path            │
  │ → compute real RouteSummary → hand-write ideal sentence      │
  └─────────────────────────┬────────────────────────────────────┘
                            │ baked into the prompt (deploy-time)
  ┌─ Prompt (Seam 1) ───────▼────────────────────────────────────┐
  │ system │ ★ FEW-SHOT: 2-3 (RouteSummary → sentence) pairs ★   │ ← we are here
  │        │ context (this call's route) │ user                  │
  └─────────────────────────┬────────────────────────────────────┘
                            │ HTTP
  ┌─ Provider ──────────────▼────────────────────────────────────┐
  │ LLM matches the example FORMAT more tightly than instructions │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **examples constrain output more tightly than instructions do — show the model two or three ideal input→output pairs and it copies the format, where a prose instruction would be interpreted loosely.** 3-5 good examples beat 20 mediocre ones, and they cost context tokens, so you pick them deliberately. Let me build it.

## Structure pass

**Layers.** Two: the *example source* (where the pairs come from — for flattr, computed from `fixtures.ts`) and the *example slot* (the constant section they live in). The quality of layer 1 determines everything; bad examples teach bad format faster than instructions could.

**Axis — control (what shapes the output more, instructions or examples?).**

```
  One axis — "what controls the output format?" — instructions vs examples

  instruction only:  "return one concise sentence"
    → model interprets "concise" loosely, format drifts

  + 3 examples:      {dist:1200,climb:8} → "Flat, 1.2km."
                     {dist:2100,climb:14}→ "Mostly flat, 2.1km, one climb."
    → model COPIES the format. control flips from prose→demonstration

  the seam: examples out-constrain instructions for format-sensitive output
```

**Seam.** The load-bearing boundary is *between instruction-controlled and example-controlled output*. For format-sensitive tasks (classifiers, fixed output shapes), examples win — the model pattern-matches the demonstration more reliably than it parses an adjective like "concise."

## How it works

### Move 1 — the mental model

You know that a unit test communicates intent better than a doc comment — `expect(sum([1,2])).toBe(3)` pins behavior more precisely than "adds the numbers." A few-shot example is that, for an LLM: a worked input→output pair pins the format more precisely than an instruction. The model is a pattern-matcher; show it the pattern.

```
  The few-shot kernel — demonstrations pin the format

  ┌─ examples (constant) ──────────────────────────────┐
  │ in: {distanceM:1200, climbM:8,  steepCount:0}       │
  │ out: "Flat, 1.2km — easy ride."                    │
  │ in: {distanceM:2100, climbM:14, steepCount:1}       │
  │ out: "Mostly flat, 2.1km, one short climb you flagged."│
  └────────────────────────────────────────────────────┘
              │ then the real input
  ┌─ this call ▼───────────────────────────────────────┐
  │ in: {distanceM:3400, climbM:2, steepCount:0}        │
  │ → model copies the format → "Flat, 3.4km."          │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Why examples beat instructions.** An instruction is a description of the output; an example *is* the output. "Be concise" is an adjective the model interprets; `"Flat, 1.2km."` is a format the model copies. For Seam 1's description, the difference is whether every route comes out in the same clean shape or whether the model wanders into "Well, this route is fairly flat and spans about..." Examples nail the register.

**Where flattr's examples come from — `fixtures.ts` is the source.** This is the part that makes flattr a good teacher. The golden graphs produce *real, verifiable* routes:

```ts
// features/routing/fixtures.ts:70-83 — gradeGraph: flat-vs-steep
// known: short path via H is steep; long path via L is flat
export function gradeGraph(): Graph { ... }
```

Run A\* over `gradeGraph`, call `routeSummary` (`summary.ts:11`), and you get a *real* `{distanceM, climbM, steepCount}` for a route you understand. Hand-write the ideal sentence for it. Do that for `diamondGraph` (flat, simple) and `directionalGraph` (one steep edge flagged) and you have three examples that each demonstrate a different case — flat, steep-flagged, directional. That's a deliberately *diverse* example set, not three near-duplicates.

```
  Hop — fixtures.ts as the few-shot source

  ┌─ fixtures.ts ─┐  A* + routeSummary  ┌─ real RouteSummary ─┐
  │ gradeGraph()  │ ──────────────────► │ {dist, climb, steep}│
  └───────────────┘                     └──────────┬──────────┘
                                                   │ hand-write ideal output
                                        ┌─ few-shot pair ─────┐
                                        │ struct → sentence   │ → into prompt
                                        └─────────────────────┘
```

**When to use vs when not.** Use few-shot for format-sensitive tasks: Seam 2's *parse* (classifiers love examples — "flat near water" → `{preferFlat:true, near:"water"}` as a demonstrated pair) and Seam 1's *describe* if you need a consistent register. Don't bother for open-ended generation where you *want* variety, or for a task already pinned by a tight schema (`02`) — if the output is schema-constrained JSON, the schema does the format work and examples mostly add token cost.

**Cost — examples consume context tokens.** Every example is in the constant section, billed every call (unless prefix-cached — see `04`). So examples trade tokens for reliability. The rule: 3-5 *good, diverse* examples beat 20 mediocre ones. Twenty examples that are all the flat case teach the model "everything is flat"; three examples covering flat / steep-flagged / directional teach it the actual decision boundary. flattr's three fixtures are *already* the diverse set — they were hand-built to probe three different behaviors.

```
  Quality over quantity — diversity is the lever

  20 examples, all flat routes:    model learns "flat" is the only answer
   3 examples, one each:
     diamondGraph  → flat
     gradeGraph    → flat-chosen-over-steep
     directionalGraph → directional climb
   → model learns the DECISION BOUNDARY, at 1/6 the token cost
```

**The interaction with structured output.** A few-shot example can *be* the structured form itself. For Seam 2, the example pair is `("flat near water" → {placeText, near:"water", preferFlat:true})` — the output side is the literal JSON struct. This teaches the model both the format *and* the schema simultaneously, and it's the most reliable way to get clean structured output from a model that doesn't have native schema mode: demonstrate the JSON shape as an example.

### Move 3 — the principle

Examples out-constrain instructions for format-sensitive output, because a model is a pattern-matcher and an example is the pattern. The discipline is *diverse and few*: 3-5 examples that each probe a different case beat 20 that repeat one. flattr hands you the example source for free — `fixtures.ts` is a hand-built, behavior-diverse golden set, the same set you'd use for evals (`05`). The example set and the eval set come from the same place, which is the tell that you've built it right.

## Primary diagram

The full few-shot setup for Seam 1, from `fixtures.ts` source to the model's format-copying behavior.

```
  Few-shot at Seam 1 — diverse examples from fixtures.ts

  ┌─ Source (fixtures.ts) ───────────────────────────────────────┐
  │ diamondGraph→flat  gradeGraph→flat-over-steep  directional→climb│
  │   A* + routeSummary → real structs → hand-written sentences   │
  └─────────────────────────┬────────────────────────────────────┘
                            │ 3 diverse pairs (deploy-time, cacheable)
  ┌─ Prompt (Seam 1) ───────▼────────────────────────────────────┐
  │ system │ FEW-SHOT: 3 (struct→sentence) pairs ║ context │ user │
  │        │  ↑ pins format > instructions       ║ this route     │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Provider ──────────────▼────────────────────────────────────┐
  │ LLM copies the demonstrated format → consistent route prose   │
  └──────────────────────────────────────────────────────────────┘
   cost: examples bill every call (unless prefix-cached, 04)
   rule: 3-5 diverse > 20 mediocre
```

## Elaborate

Few-shot is the oldest technique in this folder (it predates structured-output modes), and its role has shifted: where the output is schema-constrained, the schema now does much of what examples used to do, so few-shot's strongest remaining use is *format register* (the describe seam) and *teaching the schema by demonstration* on models without native schema mode. The interaction with structured output (`02`) is the modern nuance — the example's output side *is* the JSON. The canonical source is the original GPT-3 few-shot paper and the OpenAI cookbook's classification recipes. flattr's `fixtures.ts` is an unusually clean example source because it was built for a different reason (router tests) and happens to be exactly the diverse, verified, behavior-probing set few-shot wants.

## Project exercises

### EX-FEWSHOT-1 — Build the example set from fixtures

- **Exercise ID:** EX-FEWSHOT-1
- **What to build:** `describeExamples()` that runs A\* over `diamondGraph`/`gradeGraph`/`directionalGraph`, computes each `RouteSummary`, and pairs it with a hand-written ideal sentence — three diverse few-shot pairs.
- **Why it earns its place:** Demonstrates that the example source and the eval source are the same golden set, and forces the diversity discipline (one pair per behavior).
- **Files to touch:** new `features/routing/few-shot.ts`; uses `fixtures.ts`, `astar.ts`, `summary.ts`.
- **Done when:** the three pairs each probe a distinct case (flat / steep-flagged / directional) and feed directly into the Seam 1 prompt.
- **Estimated effort:** 2 hours.

## Interview defense

**Q: Why do examples constrain output better than instructions?**

Because the model is a pattern-matcher and an example is the pattern. "Be concise" is an adjective it interprets loosely; `"Flat, 1.2km."` is a format it copies. For format-sensitive output, demonstrations beat descriptions.

```
  instruction "concise" → loose interpretation, drift
  3 examples            → model copies the demonstrated format
```

Anchor: flattr's `fixtures.ts` produces three behavior-diverse routes — the ideal few-shot source, one pair per case.

**Q: 20 examples or 3?**

Three diverse beats twenty mediocre. Twenty examples of the same case teach the model that case is the only answer; three covering the decision boundary (flat / steep / directional) teach the actual distinction, at a fraction of the token cost.

## See also

- `01-anatomy.md` — the constant section examples live in
- `02-structured-outputs.md` — the example output can be the JSON schema itself
- `04-token-budgeting.md` — examples cost tokens; prefix caching offsets it
- `05-eval-driven-iteration.md` — same golden set, different use
