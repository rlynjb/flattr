# 06 · Single-purpose chains

> Industry name: single-purpose chains / LLM pipelines / one-job prompts · Type label: Industry standard

> **Status: seam, not feature.** flattr has zero LLM chains — but it has a *deterministic* pipeline built on exactly this principle: `pipeline/` is `osm → elevation → split → grade → build-graph`, one job per stage. This file maps that pattern onto the LLM chains Seam 1 and Seam 2 would form.

## Zoom out — where this concept lives

flattr's build pipeline already embodies single-purpose composition — every stage does one thing and hands off. The LLM seams would extend that same discipline:

```
  Zoom out — single-purpose chains, alongside flattr's real pipeline

  ┌─ Build pipeline (today, deterministic) ──────────────────────┐
  │  osm.ts → elevation.ts → split.ts → grade.ts → build-graph.ts│
  │  one job per stage. fails? you know WHICH stage.            │
  └──────────────────────────────────────────────────────────────┘

  ┌─ LLM chains (future, the seams) ─────────────────────────────┐
  │  Seam 2:  parse-destination (1 job) → geocode (existing)    │ ← we are here
  │  Seam 1:  routeSummary (existing) → describe (1 job)        │
  │  ★ THIS FILE: each LLM step is one chain, one job ★         │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **one chain does one job, and you compose chains into longer flows — so when something fails you know which chain failed, and you can route a classifier to a small model and a generator to a large one.** The opposite — one mega-prompt that classifies AND parses AND describes — is brittle, expensive to fail, and miserable to iterate. Let me build the composition.

## Structure pass

**Layers.** Two: the *chain* (one LLM call with one job and one output mode) and the *pipeline* (chains composed in a fixed order, code deciding the order). flattr's `run-build.ts` is the pipeline layer for the deterministic stages; the LLM version is identical in shape, just with model calls as some of the stages.

**Axis — failure (where does it originate and get contained?).**

```
  One axis — "when this breaks, where do I look?" — across the chain

  mega-prompt (anti-pattern):
    [classify + parse + describe in one call]  → fails SOMEWHERE. where?

  single-purpose chain:
    [classify] → [parse] → [describe]
        │           │          │
     fail here?  or here?   or here?  → the failing STAGE is obvious

  the seam: failure containment flips from "diffuse" to "localized"
```

**Seam.** The load-bearing boundary is *between two chains in the pipeline*. Each boundary is a place where you can inspect the intermediate output, swap the model, test in isolation, or insert a validation step (`02`). A mega-prompt has no such boundaries — it's one opaque step, so every failure is a whole-prompt debugging session.

## How it works

### Move 1 — the mental model

You already build pipelines: flattr's `osm → elevation → split → grade` is a chain of pure stages, each consuming the previous output. You'd never write one function that fetches OSM, queries elevation, splits ways, and computes grade — you split it so that when elevation 429s (a real flattr failure, per the project context), you know it's elevation, not OSM. Single-purpose LLM chains are the same instinct with model calls as some stages.

```
  The single-purpose-chain kernel — one job, composed

  ┌──────────┐   typed   ┌──────────┐   typed   ┌──────────┐
  │ chain A  │ ────────► │ chain B  │ ────────► │ chain C  │
  │ classify │  output   │ parse    │  output   │ describe │
  │ (small M)│           │ (small M)│           │ (large M)│
  └──────────┘           └──────────┘           └──────────┘
       │                      │                      │
   one job               one job                one job
   one output mode       one output mode        one output mode
```

### Move 2 — the step-by-step walkthrough

**One chain, one job — mirror the deterministic pipeline.** flattr's `pipeline/` stages each have a single responsibility: `geocode.ts` geocodes, `grade.ts` computes grade, `split.ts` splits ways. None of them does two jobs. The LLM seams inherit this: Seam 2's `parse-destination` parses free text to a struct and *nothing else* — it does not also geocode (that's `geocode.ts`'s job) and does not also route. Seam 1's `describe` turns a `RouteSummary` into prose and *nothing else* — it does not compute the summary (that's `routeSummary`'s job).

**Compose into a flow — code decides the order.** The chains run in a fixed sequence, and *code* sequences them, not a model. Seam 2's full flow:

```
  Hops — Seam 2 composed as a single-purpose chain pipeline

  ┌─ UI ─────────┐  "flat near water"  ┌─ Chain: parse ────────┐
  │ AddressBar   │ ──────────────────► │ LLM → GeocodeQuery    │ (small M)
  └──────────────┘                     └──────────┬────────────┘
                                                  │ {placeText, near, flat}
                                       ┌─ Stage: geocode ──────┐
                                       │ geocode.ts (existing) │ (no LLM)
                                       └──────────┬────────────┘
                                                  │ GeocodeResult
                                       ┌─ Stage: route ────────┐
                                       │ astar.ts (existing)   │ (no LLM)
                                       └───────────────────────┘
```

The thing to notice: only *one* stage is an LLM call. The parse is fuzzy and needs a model; geocoding and routing are deterministic and don't. Single-purpose chains let you put the LLM *only where it's needed* and keep the rest as the fast, testable, deterministic code flattr already has.

**Debugging benefit — you know which chain failed.** This is the same win as flattr's elevation-429 case. If the route is wrong, the failure is in exactly one of: parse (model misread "flat"), geocode (Nominatim wrong), or route (A\* bug). Each is independently inspectable because the intermediate outputs are typed and logged. A mega-prompt that "parses and geocodes and routes" gives you a wrong route and no idea which sub-task failed.

**Model-routing benefit — small models for small jobs.** Seam 2's *parse* is a constrained classification-ish task — a small, cheap model handles it. Seam 1's *describe* is open generation where quality matters — a larger model. Single-purpose chains make this trivial: each chain names its own model (the pairing from `03-prompts-as-code.md`). A mega-prompt forces one model for everything, so you pay large-model prices for the classification too.

```
  Model routing — each chain picks its own model

  parse-destination  → small model  (cheap, constrained, high volume)
  describe-route     → large model  (quality matters, lower volume)
  ─────────────────────────────────────────────────────────────────
  mega-prompt        → ONE model for everything → overpay on the easy part
```

**The failure mode of multi-purpose chains.** Brittleness (one instruction added for the describe-job breaks the parse-job), expensive failures (the whole call retries, including the parts that were fine), and harder iteration (you can't eval the parse separately from the describe because they're fused). Every one of these is the inverse of a pipeline-stage benefit. The mega-prompt is the prompt-engineering version of a 500-line function that does everything.

### Move 3 — the principle

One chain, one job, composed by code into a flow. The payoff is the same as any pipeline: localized failure, independent testing, per-stage model choice, and — critically — putting the LLM *only* in the stages that are genuinely fuzzy while keeping everything deterministic that can be. flattr's `pipeline/` is the proof that the reader already believes this: nobody would merge `osm → elevation → split → grade` into one function, and nobody should merge classify-parse-describe into one prompt.

## Primary diagram

The full single-purpose composition for both seams, with model routing and failure localization marked.

```
  Single-purpose chains — both seams, composed like pipeline/

  ┌─ Seam 2: NL destination ─────────────────────────────────────┐
  │ parse (LLM, small M) → geocode (det.) → astar (det.)         │
  │   ↑ fuzzy: LLM        ↑ deterministic — no LLM needed        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Seam 1: describe route ─────────────────────────────────────┐
  │ astar (det.) → routeSummary (det.) → describe (LLM, large M) │
  │                ↑ compresses path     ↑ fuzzy: LLM            │
  └──────────────────────────────────────────────────────────────┘

  shared discipline (mirrors osm→elevation→split→grade):
    • one job per stage   • code sequences, not a model
    • LLM only where fuzzy • failure localizes to one stage
```

## Elaborate

This is loopd's home turf (from `me.md`'s portfolio) — five chains, each with one job, composed into longer flows. loopd is the mature version of what flattr's seams would become: a classifier chain routing to handler chains, each independently evaluable. The connection to `02-structured-outputs.md` is tight — single-purpose chains are *enabled* by typed boundaries between stages; without the typed `GeocodeQuery` contract, you couldn't inspect or swap a stage. And the connection to flattr's actual code is the cleanest in this whole folder: the deterministic `pipeline/` is single-purpose composition that already runs in production. The seams just add model calls as some of the stages.

## Project exercises

### EX-CHAIN-1 — Compose Seam 2 as a single-purpose pipeline

- **Exercise ID:** EX-CHAIN-1
- **What to build:** `resolveDestination(text)` that composes `parseDestination` (LLM) → `geocode` (existing) → returns coordinates, with each stage's intermediate output logged and a per-stage error type.
- **Why it earns its place:** Forces the boundary between the fuzzy LLM stage and the deterministic existing code, and makes failure localization concrete.
- **Files to touch:** new `pipeline/resolve-destination.ts`; composes `parse-destination.ts` and existing `geocode.ts`.
- **Done when:** a parse failure and a geocode failure produce distinct, identifiable errors naming the failing stage.
- **Estimated effort:** 2-3 hours.

## Interview defense

**Q: Why one chain per job instead of one prompt that does everything?**

Failure localization, independent testing, and per-stage model routing. When a mega-prompt produces a wrong result you don't know which sub-task failed; with single-purpose chains, the failing stage is obvious and independently inspectable.

```
  mega-prompt:  wrong output → which sub-task? (opaque)
  chains:       parse | geocode | route → failing stage is named
```

Anchor: flattr's `pipeline/` is `osm→elevation→split→grade` — nobody merges those into one function, for the same reasons.

**Q: Where does single-purpose chaining save money?**

Model routing. A classifier/parser runs on a small cheap model; a generator runs on a large model. A mega-prompt forces one model for everything, so you pay large-model prices for the easy classification too.

## See also

- `02-structured-outputs.md` — typed boundaries that make stages swappable
- `03-prompts-as-code.md` — each chain names its own prompt+model pairing
- `07-output-mode-mismatch.md` — the bug at a chain boundary when modes disagree
- `09-chain-of-thought.md` — CoT belongs in the reasoning chain, not the classifier
