# 03 · Prompts as code: versioning and observability

> Industry name: prompt versioning / prompt observability / prompts-as-source · Type label: Industry standard

> **Status: seam, not feature.** flattr has no prompts to version. But it already versions the artifact that *should* teach you the discipline: `graph.json` is a build-time output, pinned and reproducible. This file maps that same discipline onto the prompts Seam 1 and Seam 2 would introduce.

## Zoom out — where this concept lives

flattr already treats one thing exactly the way you should treat prompts: `mobile/assets/graph.json` is a static, version-controlled, reproducible artifact built by a pinned pipeline. Prompts deserve the same treatment. Here's where they'd sit:

```
  Zoom out — prompts as source, alongside graph.json

  ┌─ Source (version-controlled) ────────────────────────────────┐
  │  pipeline/*.ts          features/routing/*.ts                │
  │  describe-prompt.ts ★   parse-destination.ts ★               │ ← we are here
  │  (the prompt templates — reviewed, diffed, in git)          │
  └─────────────────────────┬────────────────────────────────────┘
                            │  build / deploy
  ┌─ Artifacts (pinned) ────▼────────────────────────────────────┐
  │  graph.json (today)     prompt@v3 + model@sonnet-4.x (future)│
  └─────────────────────────┬────────────────────────────────────┘
                            │  runtime
  ┌─ Observability ─────────▼────────────────────────────────────┐
  │  log: which prompt version + which model → which output      │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **a prompt is source code — file-per-prompt, version-controlled, reviewed in PRs, and paired with the model version it was tested against.** The pairing is the part people miss. A prompt isn't "good"; a prompt is "good *on Sonnet 4.x*." Let me build it.

## Structure pass

**Layers.** Three: the *prompt source* (the template in git), the *deployed pairing* (prompt-version + model-version, frozen together), and the *runtime log* (which pairing produced which output). flattr has the first-layer discipline already (its `.ts` files are reviewed source) — it just has no prompts in it yet.

**Axis — lifecycle (when does this change, and what changes it?).**

```
  One axis — "what triggers a change here?" — down the layers

  ┌─ prompt source ──────────────┐  → a HUMAN PR (you control it)
  └──────────────────────────────┘
      ┌─ model version ──────────┐  → a PROVIDER upgrade (you don't!)
      └──────────────────────────┘
          ┌─ runtime output ─────┐  → EITHER of the above changing
          └──────────────────────┘

  the seam: you control the top layer, the provider controls the middle
```

**Seam.** The load-bearing boundary is *between your prompt and the provider's model*. You version your prompt in git; the provider versions the model on their schedule. The output depends on *both*, but you only control *one*. That asymmetry is the whole reason prompt observability exists: when output regresses, you need the log to tell you whether *you* changed the prompt or *they* changed the model.

## How it works

### Move 1 — the mental model

You already pin dependencies in `package.json` with a lockfile so a `npm install` is reproducible. A prompt's "lockfile" is the model version it was evaluated against. `prompt@v3` alone is not reproducible; `prompt@v3 + sonnet-4.x` is. Treat the model version as a pinned dependency of the prompt.

```
  The prompt-as-code kernel — source + pinned pairing + log

  ┌─ git ──────────────┐   deploy   ┌─ frozen pairing ──────────┐
  │ describe-prompt.ts │ ─────────► │ prompt@v3 + model@sonnet  │
  │ (reviewed, diffed) │            │ (the reproducible unit)   │
  └────────────────────┘            └────────────┬──────────────┘
                                                 │ each call
                                    ┌────────────▼──────────────┐
                                    │ log: {prompt_v, model_v,  │
                                    │  input_hash, output}      │
                                    └───────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**File-per-prompt — the prompt is a module, not a string literal.** The discipline flattr already applies to `cost.ts` (a real file, reviewed, with the `penalty` function and its tunable constants exported) is exactly what a prompt file looks like. Compare:

```ts
// features/routing/cost.ts — flattr's existing "tuned-constant" file
export const DEFAULT_K1 = 0.4;   // tunable
export const DEFAULT_K2 = 1.0;   // tunable
export function penalty(g, max, k1 = DEFAULT_K1, k2 = DEFAULT_K2) { ... }
```

A prompt file is the same shape: exported template, exported tunable constants (the threshold for "mention the climb"), reviewed in a PR. `cost.ts`'s `k1`/`k2` are the moral equivalent of a prompt's knobs — you'd never paste a magic `0.4` inline, and you'd never paste a prompt inline either.

**The prompt + model pairing — the part people skip.** A prompt that scores 5/5 on Sonnet 3 can regress on Sonnet 4. So the deployable unit is the *pair*. In code, that's a frozen record:

```ts
// future: the deployable unit, not just the string
const DESCRIBE_ROUTE = {
  version: "v3",
  model: "claude-sonnet-4.x",     // ← the pinned dependency
  template: buildRouteDescriptionPrompt,
} as const;
```

The Friday-afternoon failure mode I've lived: the provider ships a model upgrade, 30% of your eval set regresses overnight, and without the pairing recorded you spend the morning asking "did someone change the prompt?" before realizing nobody did — the model moved under a prompt that never changed.

**Prompt observability — log the pairing with every output.** Each LLM call logs `{prompt_version, model_version, input_hash, output}`. flattr's `bench/` harness (`bench/run.ts`, `bench/report.ts`) is the exact analog that already exists: it records `nodesExpanded`, `pushes`, `pops` per algorithm so you can compare runs. Look at `SearchResult` in `types.ts:46` — those four fields are flattr saying "I record the metrics that let me compare two versions of the router." Prompt observability records the same kind of comparison metrics, but for prompt versions:

```ts
// features/routing/types.ts:46 — flattr already records per-version metrics
export type SearchResult = {
  path: Path | null;
  nodesExpanded: number;   // ← the "which version did better" metrics
  pushes: number;
  pops: number;
};
```

```
  Hop — runtime call to observability sink

  ┌─ Parse/Describe ─┐  output + metadata  ┌─ Log sink ──────────┐
  │ LLM call         │ ──────────────────► │ {prompt_v, model_v, │
  │ (Seam 1 or 2)    │                     │  input_hash, output,│
  └──────────────────┘                     │  schema_fail?}      │
                                           └─────────────────────┘
   ← this is what lets you answer "did WE change it or did THEY?"
```

**Diffs and PRs on prompts.** Because the prompt is a file, a prompt change is a diff. You review "added 'be concise' to the system prompt" the way flattr reviews a change to `penalty()`. And critically, the PR that changes a prompt *must* re-run the eval set (`05-eval-driven-iteration.md`) — a prompt diff without an eval diff is an unreviewed change, the same way a `cost.ts` change without running `npm test` is.

**The deployment story — how prompt changes ship safely.** Same as any code change: change the file, re-run evals, diff the outputs, ship if score improved without regressions. The model-upgrade case is the one that doesn't fit normal deploys — the model can change *without your deploy*, so you need scheduled eval runs (a cron over the golden set) to catch a provider-side regression you didn't cause.

### Move 3 — the principle

A prompt is source code with one weird dependency: the model, which the provider can upgrade without your deploy. So the unit you version is the *pair* (prompt + model), and the observability you log is whatever lets you answer "did we change it or did they." flattr already has the muscle — `graph.json` is a pinned artifact, `cost.ts` externalizes its tunables, `bench/` records comparison metrics. Prompts-as-code is applying that exact muscle to text that happens to be sent to a model.

## Primary diagram

The full prompt-as-code lifecycle, from git to runtime log, with the provider-controlled seam marked.

```
  Prompts as code — source → pinned pairing → observability

  ┌─ Source (git, reviewed) ─────────────────────────────────────┐
  │ describe-prompt.ts   parse-destination.ts                    │
  │   exports template + tunable constants (like cost.ts's k1/k2)│
  └─────────────────────────┬────────────────────────────────────┘
                            │ PR: diff + re-run evals (05)
  ┌─ Deployed pairing ──────▼────────────────────────────────────┐
  │ { prompt@v3 + model@sonnet-4.x }   ★ provider controls model ★│
  │   the reproducible unit (like graph.json being pinned)       │
  └─────────────────────────┬────────────────────────────────────┘
                            │ each runtime call
  ┌─ Observability ─────────▼────────────────────────────────────┐
  │ log {prompt_v, model_v, input_hash, output, schema_fail}     │
  │   (the SearchResult-style metrics, for prompt versions)      │
  │ + scheduled eval run → catches provider-side model upgrades  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the concept most directly exercised by aipe (from `me.md`'s portfolio) — aipe *is* markdown templates as version-controlled prompts, with frontmatter and slash commands that compose them. That's the mature form of what this file describes: prompts as files, composed by an interface, reviewed in git. flattr is the inverse case — it has the *discipline* (pinned artifacts, reviewed source, recorded metrics) without yet having prompts to apply it to, which makes it a clean place to see the discipline before the prompts arrive. The canonical reading is anything Simon Willison writes about logging every prompt/response pair, and the broader "prompts are code" framing that runs through the OpenAI cookbook's production sections.

## Project exercises

### EX-PROMPTCODE-1 — Prompt registry with model pairing

- **Exercise ID:** EX-PROMPTCODE-1
- **What to build:** A typed prompt registry where each entry is `{ version, model, template }`, plus a logging wrapper that records `{prompt_version, model_version, input_hash, output}` on every call.
- **Why it earns its place:** Forces the prompt+model pairing into the type system so you literally cannot deploy a prompt without naming the model it was tested against.
- **Files to touch:** new `features/llm/registry.ts`, `features/llm/log.ts`; reuse `bench/report.ts` patterns for the log format.
- **Done when:** changing the model field is a visible diff, and the log lets you reconstruct which pairing produced any given output.
- **Estimated effort:** 2-3 hours.

## Interview defense

**Q: Why pair a prompt with a model version?**

Because a prompt's behavior is a function of both, and the provider can change the model without your deploy. A prompt that scored 5/5 on Sonnet 3 can regress on Sonnet 4. The reproducible unit is the pair; alone, the prompt isn't reproducible — like a `package.json` with no lockfile.

```
  prompt@v3 alone        → not reproducible
  prompt@v3 + model@4.x  → reproducible (the deployable unit)
```

Anchor: flattr already pins `graph.json` and externalizes `cost.ts`'s `k1`/`k2` — same instinct, applied to prompts.

**Q: A prompt-dependent feature regresses overnight with no deploy. First move?**

Check the log. If `{prompt_version}` is unchanged but `{model_version}` moved, the provider upgraded the model under me. That's why you log the pairing and run scheduled evals — to distinguish "we changed it" from "they changed it."

## See also

- `01-anatomy.md` — the four sections that live in the prompt file
- `02-structured-outputs.md` — logging schema-fail rate as an upgrade alarm
- `05-eval-driven-iteration.md` — the eval run a prompt PR must trigger
- `11-meta-prompting.md` — keeping LLM-drafted prompts readable as source
