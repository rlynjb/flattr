# 11 · Meta-prompting

> Industry name: meta-prompting / prompt generation / LLM-authored prompts · Type label: Industry standard

> **Status: seam, not feature.** flattr has no prompts, so nothing generates prompts. This file maps meta-prompting onto the authoring workflow you'd use *to write* Seam 1 and Seam 2's prompts — using a model to draft them, with `fixtures.ts` as the grounding the draft must satisfy.

## Zoom out — where this concept lives

Meta-prompting sits *upstream* of the codebase — it's a workflow for producing the prompt files that then get versioned (`03-prompts-as-code.md`). Here's where it fits:

```
  Zoom out — meta-prompting in the authoring workflow

  ┌─ Authoring (offline, human-driven) ──────────────────────────┐
  │ human writes GOAL → ★ LLM drafts the prompt ★ → human edits  │ ← we are here
  │   "describe a route from a RouteSummary, ≤2 sentences..."    │
  └─────────────────────────┬────────────────────────────────────┘
                            │ reviewed, edited
  ┌─ Source (git) ──────────▼────────────────────────────────────┐
  │ describe-prompt.ts  (now a version-controlled file, 03)      │
  └─────────────────────────┬────────────────────────────────────┘
                            │ tested against
  ┌─ Evals (fixtures.ts) ───▼────────────────────────────────────┐
  │ the drafted prompt must pass the golden set (05)             │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **use an LLM to draft or improve a prompt for another LLM call — human writes the goal, model drafts, human reviews and edits, and the edited prompt enters the codebase as source.** It saves time on initial drafting of complex prompts and wastes time on small tweaks. The risk: prompts that read like LLM output instead of engineering specs. Let me build it.

## Structure pass

**Layers.** Two: the *meta-prompt* (the goal you give the drafting model) and the *target prompt* (what it produces, which then runs in production). The human sits at the boundary as the editor — meta-prompting is human-in-the-loop by design.

**Axis — control (who authors the final prompt?).**

```
  One axis — "who controls the final prompt text?" — through the workflow

  ┌─ goal ──────────────┐  → HUMAN (you set the intent)
  └─────────────────────┘
      ┌─ draft ─────────┐  → LLM (proposes the text)
      └─────────────────┘
          ┌─ edit ──────┐  → HUMAN (you own what ships)  ← the seam
          └─────────────┘

  the seam: authorship flips back to the human at the edit step
  — skip it and you've shipped LLM output as your spec
```

**Seam.** The load-bearing boundary is *the human edit step*. Meta-prompting without the human edit is just letting a model write your production prompt unreviewed — and the failure mode is prompts that read like LLM filler ("It is important to carefully consider...") instead of tight engineering specs. The edit is where authorship returns to you.

## How it works

### Move 1 — the mental model

You already use a model to draft code you then review and edit — autocomplete proposes, you accept-and-fix. Meta-prompting is that for prompts: the model drafts the prompt, you review and tighten it, the result is yours. It's a *drafting accelerator*, not an authorship replacement — exactly like the difference between AI-assisted code and AI-authored-unreviewed code.

```
  The meta-prompting kernel — draft, edit, commit

  ┌─ human: GOAL ────────────────────────────────────┐
  │ "describe a route from {distanceM,climbM,         │
  │  steepCount}, ≤2 sentences, mention climb iff>10" │
  └────────────────────┬─────────────────────────────┘
                       │ meta-prompt
  ┌─ LLM: DRAFT ───────▼─────────────────────────────┐
  │ proposes a full system prompt + few-shot examples │
  └────────────────────┬─────────────────────────────┘
                       │ ★ human EDIT (authorship returns) ★
  ┌─ git: COMMIT ──────▼─────────────────────────────┐
  │ describe-prompt.ts — now reviewed source          │
  └──────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The workflow — human goal, model draft, human edit.** You write the *goal* precisely: for Seam 1, "produce a system prompt that turns a `RouteSummary {distanceM, climbM, steepCount}` into a ≤2-sentence route description, mentions the climb only if `climbM > 10`, never says 'flat' if `steepCount > 0`, no markdown." The model drafts a full prompt — system text plus candidate few-shot examples. Then you edit: cut the filler, tighten the contract, fix anything that misread the goal.

**Where it saves time — initial drafting of complex prompts.** A prompt with several rules, a few-shot section, and an output contract is tedious to write from a blank page. The model gets you 70% of the way — a structured first draft with the sections in place — and you spend your time on the 30% that's actually hard: the edge-case rules and the example selection. This is the genuine win, and it's real.

**Where it wastes time — small tweaks and high-iteration prompts.** If you're changing one word ("concise" → "brief") or you're mid-eval-loop iterating a prompt against `fixtures.ts` ten times a day, round-tripping through a drafting model is *slower* than just editing the text. Meta-prompting is for the cold start, not the hot loop. I've watched people meta-prompt a one-line change and it's pure ceremony.

```
  Hop — when meta-prompting pays vs when it doesn't

  cold start (new complex prompt):
    blank page ──meta-prompt──► 70% draft ──edit──► done   ✓ faster

  hot loop (eval iteration, tweaks):
    prompt ──edit one rule──► run evals ──repeat          ✓ faster
    prompt ──meta-prompt──► draft ──re-edit──► run evals  ✗ ceremony
```

**Grounding the draft in `fixtures.ts`.** The strongest version of the Seam 1 meta-prompt *hands the drafting model the golden cases*: "here are three real `RouteSummary` objects from our test graphs and the ideal sentence for each (`diamondGraph`→flat, `gradeGraph`→flat-over-steep, `directionalGraph`→directional); write a system prompt that produces outputs like these." Now the draft is grounded in real, verified examples instead of the model's guess at what a route description should sound like. The fixtures (`fixtures.ts:46`) double as the meta-prompt's grounding *and* the eval set (`05`) the result must pass — same golden set, third use.

**The risk — prompts that read like LLM output.** A model drafting a prompt produces LLM-flavored prose: hedgy, over-explained, "It is crucial to ensure that you carefully...". That's the opposite of a good production prompt, which is terse and specific. The edit step exists to strip this. A prompt that still reads like a model wrote it is a prompt nobody owned — and unowned prompts drift fastest, because no human has a mental model of why each line is there. The tell: if you can't explain why a sentence is in the prompt, the model put it there and you didn't edit hard enough.

### Move 2.5 — current state vs future state

```
  Phase A (today)            Phase B (meta-prompting in use)
  ───────────────            ───────────────────────────────
  no prompts to author       human writes goal → LLM drafts →
                             human edits → commits to git
  fixtures.ts: test data     fixtures.ts: ALSO grounds the draft
                             AND evals the result (same set, 3 uses)
```

What doesn't change: the prompt still enters the codebase as reviewed source (`03`) and still passes the eval set (`05`). Meta-prompting changes *how the first draft is produced*, not the discipline around it. The model writing a draft doesn't excuse it from review, versioning, or evals.

### Move 3 — the principle

Meta-prompting is a drafting accelerator with a mandatory human edit step. It pays for the cold start of a complex prompt and costs ceremony on small tweaks and hot iteration loops. The decisive move is grounding the draft in real examples (flattr's `fixtures.ts`) and editing until the prompt reads like an engineering spec, not LLM filler — because authorship has to return to the human or you've shipped an unowned prompt that nobody can reason about when it drifts.

## Primary diagram

The full meta-prompting workflow, grounded in fixtures, feeding the versioned source.

```
  Meta-prompting — draft grounded in fixtures, owned by the human

  ┌─ Human: goal ────────────────────────────────────────────────┐
  │ "RouteSummary → ≤2 sentences, climb iff>10, never 'flat'     │
  │  if steepCount>0" + 3 grounding examples from fixtures.ts    │
  └─────────────────────────┬────────────────────────────────────┘
                            │ meta-prompt (grounded)
  ┌─ LLM: draft ────────────▼────────────────────────────────────┐
  │ proposes system prompt + few-shot section (70% there)        │
  └─────────────────────────┬────────────────────────────────────┘
                            │ ★ HUMAN EDIT — strip filler, tighten ★
  ┌─ git: describe-prompt.ts ▼───────────────────────────────────┐
  │ reviewed source (03) → must pass fixtures.ts evals (05)      │
  └──────────────────────────────────────────────────────────────┘
   use for: cold start of complex prompts
   skip for: one-word tweaks, hot eval loops
```

## Elaborate

Meta-prompting is what aipe (from `me.md`'s portfolio) does under the hood — its slash commands lean on meta-prompting to compose templates, and it's the mature, productized form of this workflow: a tool that turns a human goal into a structured prompt artifact. The canonical references are Anthropic's prompt generator and OpenAI's "generate a prompt" tooling, both of which are meta-prompting with guardrails. The risk it surfaces — prompts reading like LLM output — is the same risk as AI-authored code that nobody reviewed: it works until it needs to be reasoned about, and then no human has the model of it. flattr makes the grounding move clean, because `fixtures.ts` is exactly the verified-example set a good meta-prompt should be anchored to.

## Project exercises

### EX-META-1 — Draft the Seam 1 prompt, grounded in fixtures

- **Exercise ID:** EX-META-1
- **What to build:** A meta-prompt that hands a model three `(RouteSummary → sentence)` pairs from `fixtures.ts` and asks it to draft the Seam 1 system prompt; then edit the draft to a terse spec and run it against the `05` eval set.
- **Why it earns its place:** Exercises the grounded-draft + human-edit workflow and proves the edited prompt (not the raw draft) is what passes evals.
- **Files to touch:** new `features/routing/meta/draft-describe.md` (the meta-prompt), output to `describe-prompt.ts`.
- **Done when:** the raw draft and the edited draft are both kept, and the edited one scores higher on `fixtures.ts` evals.
- **Estimated effort:** 2-3 hours.

## Interview defense

**Q: When does meta-prompting help and when is it ceremony?**

Helps on the cold start of a complex prompt — a model gets you a structured 70% draft. Ceremony on one-word tweaks and hot eval-iteration loops, where round-tripping through a drafting model is slower than just editing the text.

```
  cold start (complex) → meta-prompt → edit   ✓
  tweak / hot loop     → just edit          ✓ (meta-prompt = ceremony)
```

Anchor: ground the draft in flattr's `fixtures.ts` examples so the model isn't guessing what a route description should sound like.

**Q: What's the risk, and what controls it?**

Prompts that read like LLM output — hedgy, over-explained — instead of terse engineering specs. The control is the mandatory human edit step where authorship returns to you. The tell that you didn't edit hard enough: you can't explain why a given sentence is in the prompt.

## See also

- `03-prompts-as-code.md` — where the edited prompt lands as source
- `05-eval-driven-iteration.md` — the evals the draft must pass
- `08-few-shot.md` — the examples the meta-prompt is grounded in
- `01-anatomy.md` — the four sections the draft should produce
