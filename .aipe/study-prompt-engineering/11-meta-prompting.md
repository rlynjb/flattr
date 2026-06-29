# 11 — Meta-prompting

*Industry name(s): "meta-prompting," "prompt generation," "prompt
optimization," "LLM-writes-prompts." Type label: Industry standard.*

> **Seam, not present.** flattr has no prompts, so nothing generates prompts.
> But the workflow has a perfect anchor: `pipeline/config.ts` is flattr's
> "knobs a human tunes" file, and the meta-prompting workflow is exactly
> "human writes the goal → LLM drafts → human reviews → it enters the repo
> as a reviewed file." This file teaches that workflow against flattr's two
> seams.

## Zoom out — where meta-prompting sits (authoring time, not runtime)

Meta-prompting is using an LLM to *write or improve* the prompts for your other
LLM calls. Crucially it's an *authoring-time* activity — the generated prompt
enters the repo as a reviewed file (concept 03), it doesn't run live and
unreviewed.

```
  Zoom out — meta-prompting lives at authoring time

  ┌─ authoring time (human + LLM) ──────────────────────────────────┐
  │ human writes goal ─► LLM drafts prompt ─► human edits ─►         │
  │   commits to prompts/describe-route.md (concept 03)             │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼ ONLY THEN does it run
  ┌─ runtime (Seam 1 / Seam 2) ─────────────────────────────────────┐
  │ the reviewed prompt drives the actual LLM call                  │
  └──────────────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: **human writes the goal, an LLM drafts the prompt, the human
reviews and edits, the prompt enters the codebase as a reviewed file.** It
saves time on *initial drafting* of complex prompts. It does NOT help with
small tweaks or prompts under heavy iteration pressure — there, the round-trip
is slower than just editing. The risk: prompts that read like LLM output
(vague, padded) instead of like engineering specs (tight, testable).

## The structure pass

**Layers:** goal → draft → reviewed prompt.
**Axis:** *authorship* — who is responsible for what ships?
**Seam:** the draft→review boundary. The LLM authors the draft; the human
authors what *ships*. The boundary must not collapse.

```
  axis = "who is accountable for the prompt that ships?"

  ┌─ LLM draft ───┐ accountable: NO ONE — it's a suggestion
  │  ── seam ──      ◄── accountability lands ENTIRELY on review
  └─ reviewed file┘ accountable: the human who committed it
```

## How it works

### Move 1 — the mental model

You already use code generation and accept the contract: a generator (or
Copilot) drafts, *you* review and own what merges. You'd never ship generated
code unread. Meta-prompting is that contract for prompts. The LLM is a faster
first draft, not an author of record. flattr's `pipeline/config.ts` is the
human-owned knobs file — meta-prompting produces a *draft* of such a file that
a human then owns.

```
  Pattern — meta-prompting as draft-then-own

  human: "goal: describe a route in one honest sentence"
            │
            ▼
  LLM:  drafts a full system prompt + few-shot scaffold
            │
            ▼
  human: edits to a tight spec ─► commits as prompts/describe-route.md
            │
            ▼
  runtime: the REVIEWED file runs (never the raw draft)
```

### Move 2 — the workflow against flattr's seams

**Step 1 — human writes the goal, not the prompt.** For Seam 1: "I need a
prompt that turns `{distanceM, climbM, steepCount}` into one honest sentence
that always flags steep blocks." That's a spec, the human's job.

**Step 2 — LLM drafts the full prompt.** It produces the system prompt, the
few-shot scaffold (concept 08), the output contract (concept 02). For a complex
prompt this saves real time — you're editing a draft instead of staring at a
blank file.

**Step 3 — human reviews and edits (where accountability lives).** The draft
*will* be padded ("You are a helpful and knowledgeable routing assistant..."
— LLM-output smell). The human cuts it to an engineering spec. This is the
load-bearing step: the same review discipline flattr applies to every `.ts`
file applies here.

**Step 4 — it enters the repo as a reviewed file (concept 03).** The output of
meta-prompting is a committed, version-controlled, model-paired prompt file —
identical to any other source artifact. There is no "the LLM's prompt runs
unreviewed" path.

```
  Layers-and-hops — meta-prompting feeding the prompts-as-code pipeline

  ┌─ human ──────┐ goal     ┌─ drafting LLM ─┐ draft prompt
  │ writes spec  │ ───────► │ generates      │ ──────────────┐
  └──────────────┘          └────────────────┘                ▼
                                            ┌─ human review ─────────┐
                                            │ cut padding → tight    │
                                            └───────────┬────────────┘
                                                        ▼ commit
                                            ┌─ prompts/*.md (concept 03) ─┐
                                            │ reviewed, model-paired       │
                                            └──────────────────────────────┘
```

**Step 5 — when it does NOT help.** A one-word tweak to an existing prompt, or
a prompt you're iterating ten times an hour against an eval set (concept 05) —
the meta-prompt round-trip is pure overhead there. Draft new complex prompts
with it; hand-tune everything else.

### Move 2 variant — load-bearing skeleton

Kernel: **human owns the goal and the review; LLM owns only the draft**. What
breaks:

- **Skip the human review** → padded, untested prompts ship; you've outsourced
  accountability to a model. *Load-bearing — this is the whole risk.*
- **Meta-prompt a tiny tweak** → round-trip slower than editing. *Anti-pattern.*
- **Generated prompt bypasses the prompts/ pipeline** → loses versioning, model
  pairing, evals. *Load-bearing — it must enter as a reviewed file.*

### Move 3 — the principle

Meta-prompting is code generation for prompts: it accelerates the first draft
and changes nothing about ownership. The human writes the goal and owns the
review; the generated artifact enters the repo through the same gate as any
other source. The risk is forgetting that a fluent draft is still a draft.

## Primary diagram

```
  Meta-prompting workflow into flattr's prompts/ (FUTURE)

  ┌─ human: goal spec ──────────────────────────────────────────────┐
  │ "summary → one honest sentence, always flag steepCount>0"       │
  └───────────────────────────┬─────────────────────────────────────┘
                              ▼ LLM drafts
  ┌─ draft (NOT shippable) ──────────────────────────────────────────┐
  │ "You are a helpful routing assistant..." ← padding to cut        │
  └───────────────────────────┬─────────────────────────────────────┘
                              ▼ human review (accountability)
  ┌─ prompts/describe-route.md (concept 03) ─────────────────────────┐
  │ tight spec · model-paired · co-located eval · version-controlled │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

aipe (in the reader's portfolio) is the lived example: its slash commands lean
on meta-prompting under the hood — a human describes intent, the system
composes the actual prompt, and the result is a committed, reviewable artifact.
That's the workflow above, shipped. Anthropic and OpenAI both ship
prompt-generator tools that follow the same draft-then-review contract; the
discipline (human owns the review, output enters version control) is what
separates it from "let the AI write the AI." Read `03-prompts-as-code.md` for
the pipeline the generated prompt enters and `08-few-shot.md` for the scaffold
the draft produces.

## Interview defense

**Q: "Can't you just have an LLM write your prompts?"** For the first draft of
a complex prompt, yes — it's code generation for prompts and it saves real
time. But the human owns the goal and the review, and the output enters the
repo as a reviewed, version-controlled, model-paired file. The risk is shipping
a fluent draft that reads like LLM output instead of a tight engineering spec.
Small tweaks and heavily-iterated prompts: hand-tune, the round-trip is slower.

```
  complex new prompt → meta-prompt the draft, then OWN the review
  one-word tweak     → just edit it (round-trip is overhead)
```

Anchor: *"aipe already ships this — slash commands meta-prompt under the hood,
but every result lands as a committed file. flattr's `pipeline/config.ts` is
the same 'human-owned knobs' shape a generated prompt file would join."*

## See also

- [03-prompts-as-code.md](03-prompts-as-code.md) — the pipeline generated
  prompts enter
- [08-few-shot.md](08-few-shot.md) — the few-shot scaffold a draft produces
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the generated
  prompt still faces the eval gate
- [01-anatomy.md](01-anatomy.md) — the structure a draft must fill
</content>
