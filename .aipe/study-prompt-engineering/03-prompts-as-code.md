# 03 — Prompts as code: versioning and observability

*Industry name(s): "prompts as code," "prompt versioning," "prompt
observability," "prompt registry." Type label: Industry standard.*

> **Seam, not present.** flattr has no prompts to version. But it has the
> exact engineering culture this concept demands — version-controlled
> TypeScript, co-located tests, a deterministic build. This file maps where
> a `prompts/` directory would slot into flattr's existing layout and why the
> prompt+model-version pairing matters the day a model upgrades.

## Zoom out — where versioned prompts would live

A prompt that drives production is source code. It deserves a file, a diff, a
review, and a record of which version produced which output. flattr already
treats everything else this way; here's where prompts would join.

```
  Zoom out — prompts as a peer of the existing source tree

  ┌─ source tree (exists) ──────────────────────────────────────────┐
  │  features/routing/*.ts   pipeline/*.ts   lib/geo.ts              │
  │  *.test.ts co-located    vitest.config.ts                       │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ prompts join as peers
  ┌─ prompts/ (future) ───────────▼──────────────────────────────────┐
  │  ★ describe-route.md   ★ parse-destination.md                    │
  │  each: frontmatter (model, version) + body + co-located eval     │
  └──────────────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: **file-per-prompt, version-controlled, reviewed in PRs, paired
with the model version it was tuned against, and logged so you know which
prompt version produced which production output.** The load-bearing word is
*paired*: a prompt is only correct relative to a model. The prompt that scored
4.6/5 on Sonnet 3 can score 3.8 on Sonnet 4 with zero code changes.

## The structure pass

**Layers:** prompt file → deployed prompt → logged invocation.
**Axis:** *traceability* — can I reconstruct what ran?
**Seam:** the deploy boundary, where "the file in git" becomes "the bytes that
ran in prod," and the model-version pairing must travel with it.

```
  axis = "can I reconstruct exactly what ran?"

  ┌─ git ──────────┐ traceable: yes — diff, blame, PR
  ├─ deploy ───────┤ traceable: only if you stamp version+model
  │  ── seam ──       ◄── pairing must cross here
  └─ prod log ─────┘ traceable: only if each call logs (prompt_v, model_v)
```

## How it works

### Move 1 — the mental model

You already do this with database migrations. A migration is a numbered,
reviewed, immutable file; production records which migrations have run; you
never edit a shipped migration, you add a new one. A prompt is a migration for
behavior. `describe-route.md` v1 ships; you don't silently edit it, you ship
v2; production logs which version ran on each request. The reader has shipped
exactly this with Drizzle in AdvntrCue — same discipline, different artifact.

```
  Pattern — a prompt's lifecycle, mirroring a migration

  write prompt file ──► PR review ──► merge (v1) ──► deploy
                                                      │
                          ┌───────────────────────────┘
                          ▼
  every prod call logs (prompt_id, prompt_v=1, model_v="sonnet-4")
                          │
            model upgrades │  ──► re-run evals on v1 (concept 05)
                          ▼
              regressed? ──► author v2, repeat. NEVER edit v1 in place.
```

### Move 2 — the pieces, against flattr's actual conventions

**Piece 1 — file-per-prompt with frontmatter.** flattr's pipeline already
uses a config module (`pipeline/config.ts`) and typed modules. A prompt file
extends that culture:

```
  // FUTURE — prompts/describe-route.md
  ---
  id: describe-route
  version: 2
  model: claude-sonnet-4          ← the PAIRING, in the file
  eval: prompts/describe-route.eval.ts
  ---
  You describe self-powered routes. One sentence...
```

The frontmatter `model` field is the whole point: the file records what it was
tuned against. This is exactly aipe's own encoding — the reader has shipped
markdown-templates-as-prompts with frontmatter and slash commands. flattr
would borrow that shape wholesale.

**Piece 2 — co-located eval, mirroring co-located tests.** flattr puts
`*.test.ts` next to source. A prompt gets `describe-route.eval.ts` next to it.
Same instinct: the contract lives beside the thing it constrains.

**Piece 3 — the prompt+model pairing, enforced.** The one that bites in
production:

```
  // FUTURE — refuse to run a prompt against an unexpected model
  if (runtime.model !== prompt.frontmatter.model) {
    log.warn("prompt/model mismatch", {prompt: prompt.id, expected: prompt.frontmatter.model, got: runtime.model})
    // re-run evals before trusting this combo
  }
```

I have lived the Friday-afternoon version of this: a platform team bumped the
default model, 30% of an eval set regressed overnight, and the only reason we
caught it before customers did was that every call logged its model version
and the dashboard lit up.

**Piece 4 — observability: log (prompt_v, model_v, output).** Every prod
invocation records which prompt version and model produced which output. When
a user reports a bad route description, you pull the exact prompt version that
ran. Without it, you're guessing.

```
  Layers-and-hops — the pairing traveling from git to prod log

  ┌─ git ────────┐ describe-route.md (v2, model=sonnet-4)
  │              │ ──── deploy stamps version+model ────┐
  └──────────────┘                                       ▼
  ┌─ runtime ────┐ call: prompt_v=2, model_v=sonnet-4   ┌─ log store ─┐
  │              │ ───────────────────────────────────► │ (v2,model,  │
  │              │                                       │  output)    │
  └──────────────┘                                       └─────────────┘
```

### Move 2.5 — current state vs future state

```
  Phase A (now)                 Phase B (prompt layer added)
  ───────────────               ─────────────────────────────
  TS modules, *.test.ts         + prompts/*.md with frontmatter
  pipeline/config.ts            + per-prompt model pairing
  vitest, git, PRs              + co-located *.eval.ts
  deterministic — no            + prod log: (prompt_v, model_v)
    versioning needed             reuses git, PRs, vitest culture
```

What doesn't have to change: the git workflow, the PR review habit, the
co-located-test convention. The prompt layer slots into the *existing*
discipline. That's the payoff of studying it before building it.

### Move 3 — the principle

A prompt is only correct relative to a model version. Treat the pair as the
atomic unit: version it, review it, log it, and re-evaluate it whenever either
half changes.

## Primary diagram

```
  Prompts as code — full lifecycle in flattr's culture (FUTURE)

  ┌─ authoring ─────────────────────────────────────────────────────┐
  │ prompts/describe-route.md  ─frontmatter: model=sonnet-4, v=2─    │
  │        │ PR review (same as any .ts)                             │
  └────────┼─────────────────────────────────────────────────────────┘
           ▼
  ┌─ CI (extends vitest) ───────────────────────────────────────────┐
  │ run describe-route.eval.ts  ─ gate merge on score (concept 05)   │
  └────────┼─────────────────────────────────────────────────────────┘
           ▼ deploy stamps (v, model)
  ┌─ runtime ───────────────────────────────────────────────────────┐
  │ assert runtime.model == prompt.model ─ else warn + re-eval       │
  │ log every call: (prompt_v, model_v, output)                     │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is exactly what aipe (in the reader's portfolio) encodes: markdown
templates as version-controlled prompts, frontmatter carrying metadata, slash
commands composing them. flattr would adopt the same shape. The
prompt-observability angle — logging which version produced which output —
is the prompt-world equivalent of structured request logging, and it's the
single highest-leverage thing you can add before a model upgrade. Read
`05-eval-driven-iteration.md` next: versioning gives you the *what ran*; evals
give you the *was it good*. Together they're how prompt changes ship safely.

## Interview defense

**Q: "Why version a prompt — it's just a string?"** Because it's a string
whose behavior is defined relative to a model that changes underneath it. The
prompt+model pair is the atomic unit. I've watched a default-model bump
regress 30% of an eval set with zero prompt edits — the only reason we caught
it was every call logged its model version.

```
  prompt_v2 × sonnet-3  = 4.6/5
  prompt_v2 × sonnet-4  = 3.8/5   ◄── same prompt, model moved
```

Anchor: *"flattr already version-controls every `.ts` and co-locates tests. A
`prompts/` dir with frontmatter model-pairing and co-located `.eval.ts` is the
same discipline applied to the one artifact whose correctness depends on an
external version."*

## See also

- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the eval that
  gates a prompt PR
- [04-token-budgeting.md](04-token-budgeting.md) — version the budget too
- [11-meta-prompting.md](11-meta-prompting.md) — generated prompts still enter
  the repo as reviewed files
- `.aipe/study-ai-engineering/` — the production-serving / logging seam
</content>
