# 06 — Single-purpose chains

*Industry name(s): "single-purpose chains," "one chain one job," "pipeline
prompting," "task decomposition." Type label: Industry standard.*

> **Seam, not present.** flattr chains no LLM calls. But its `pipeline/` is
> already a single-purpose chain — `osm → split → grade → build-graph`, each
> module one job (`pipeline/` per the project context). This file teaches the
> pattern against that real pipeline and maps where LLM chains would slot in.

## Zoom out — flattr's pipeline IS the pattern

A single-purpose chain is many small steps, each doing one job, composed into
a flow — instead of one prompt that tries to do everything. flattr's build
pipeline is precisely this shape, deterministically.

```
  Zoom out — flattr's existing chain + where LLM steps would join

  ┌─ pipeline/ (EXISTS, deterministic) ─────────────────────────────┐
  │ osm.ts ─► split.ts ─► elevation.ts ─► grade.ts ─► build-graph.ts │
  │  one job   one job     one job         one job      one job      │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ a future NL flow mirrors this shape
  ┌─ future LLM chain (Seam 2) ─▼────────────────────────────────────┐
  │ parse-intent ─► geocode ─► route ─► describe                     │
  │  (LLM)          (code)     (code)    (LLM)                       │
  │  one job        one job     one job   one job                    │
  └──────────────────────────────────────────────────────────────────┘
```

The point lands without inventing anything: flattr already decomposes a
complex transform into single-job stages. An LLM chain would copy that shape.

## Zoom in

The pattern: **one chain, one job, composed into longer flows.** Each step is
independently testable, independently debuggable, and independently
model-routable — a cheap small model for a classifier step, an expensive large
one for generation. The opposite (one mega-prompt) is brittle, expensive when
it fails, and impossible to iterate on a single behavior.

## The structure pass

**Layers:** the flow → each step → the step's prompt.
**Axis:** *failure localization* — when it breaks, do you know which step?
**Seam:** the step boundary, where a typed value passes from one job to the
next. That's where you can observe, test, and swap.

```
  axis = "when output is wrong, which step failed?"

  ┌─ mega-prompt ──┐ localization: NONE — somewhere in the blob
  │  ── seam ──       ◄── decomposition into steps creates the seams
  └─ chain of steps┘ localization: EXACT — step 2 returned bad coords
```

## How it works

### Move 1 — the mental model

You know why you split a 300-line function into named helpers: not because the
computer cares, but because when it breaks you can binary-search the failure
and unit-test each piece. A chain is that refactor applied to LLM work. flattr
already did it deterministically — `grade.ts` doesn't also do geocoding; it
grades. A chain just makes some of those steps LLM calls.

```
  Pattern — chain as composed single-job steps

  input ─► [step A: one job] ─► [step B: one job] ─► [step C] ─► out
              │ typed              │ typed             │
              ▼                    ▼                   ▼
           testable             testable            testable
           swappable model      swappable model     swappable
```

### Move 2 — the steps, against flattr's pipeline and Seam 2

**Step 1 — each module owns one transform (flattr does this today).** The real
pipeline, per the project context:

```
  // EXISTS — pipeline/, build-time
  osm.ts        → fetch raw OSM ways
  split.ts      → split ways into edges
  elevation.ts  → attach elevation per node
  grade.ts      → compute signed grade per edge
  build-graph.ts→ assemble adjacency + emit graph.json
```

No module does two of these. That's the discipline. When the graph comes out
wrong, you know whether to look at `grade.ts` or `elevation.ts` — you don't
debug a monolith.

**Step 2 — model-routing: small model for classifiers, large for generation.**
The future NL chain at Seam 2 would route by step:

```
  parse-intent  → small/cheap model (classification: is this a place? a vibe?)
  describe      → larger model (generation: natural sentence)
```

You don't pay generation-tier prices to classify, and you don't trust a tiny
model with the user-facing prose. The chain makes per-step model choice
possible; a mega-prompt forces one model for everything.

```
  Layers-and-hops — model routing across chain steps (FUTURE)

  ┌─ step: parse ─┐ small model   ┌─ step: describe ─┐ large model
  │ NL → args     │ ─── coords ──►│ summary → prose  │ ─► sentence
  └───────────────┘  (cheap)      └──────────────────┘  (quality)
```

**Step 3 — the failure mode of multi-purpose chains.** A single prompt that
"parses the destination AND routes AND describes it" fails as a unit: you
can't tell which sub-task broke, every failure costs a full large-model call,
and tuning the description regresses the parsing. flattr's pipeline avoids
this by construction — and an LLM chain must too.

### Move 2 variant — load-bearing skeleton

Kernel: **typed boundaries between single-job steps**. What breaks:

- **Merge two jobs into one step** → failure localization collapses; you're
  back to debugging a blob. *Load-bearing.*
- **Untyped step boundary** → step B can't trust step A's output shape — this
  is concept 07's mismatch bug. *Load-bearing.*
- **One model for all steps** → still works, just wasteful. *Hardening (cost),
  not correctness.*

### Move 3 — the principle

Decompose LLM work the way you decompose code: one job per unit, typed
boundaries between. The win isn't elegance — it's that failures become
locatable and each behavior becomes independently iterable. flattr proves the
instinct deterministically; an LLM chain inherits it.

## Primary diagram

```
  Single-purpose chains — flattr's pipeline as the template (FUTURE LLM flow)

  ┌─ deterministic (EXISTS) ──────────────────────────────────────────┐
  │ osm ─► split ─► elevation ─► grade ─► build-graph ─► graph.json    │
  └───────────────────────────────────────────────────────────────────┘
              ║ same shape, some steps become LLM
              ▼
  ┌─ NL chain (Seam 2, FUTURE) ───────────────────────────────────────┐
  │ parse-intent(LLM,sm) ─► geocode(code) ─► route(code) ─► describe(LLM,lg)│
  │  fails? you know WHICH step. routes models per step.              │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the core idea behind LangChain's "chains" and behind every production
LLM pipeline that survives — decompose, then compose. The reader has shipped
exactly this in loopd (five chains, each one job) and in AdvntrCue's RAG
(retrieve → rerank → generate as separate steps). flattr's `pipeline/` is the
deterministic proof that the instinct is already there. Read
`07-output-mode-mismatch.md` next — the specific bug that bites at the typed
step boundaries this pattern creates.

## Interview defense

**Q: "Why not one prompt that does everything?"** Because when it fails you
can't tell which sub-task broke, every failure costs a full expensive call,
and tuning one behavior regresses another. Split into single-job steps with
typed boundaries — then failures localize and you route a cheap model to the
classifier step and an expensive one only to generation.

```
  mega-prompt fails → "somewhere in here" + full-price call
  chain fails       → "step 2, bad coords" + cheap step isolated
```

Anchor: *"flattr's `pipeline/` already does this — `grade.ts` grades, nothing
else. An LLM chain copies that: parse-intent on a small model, describe on a
large one, typed boundaries between."*

## See also

- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — the step-boundary
  bug
- [02-structured-outputs.md](02-structured-outputs.md) — typed boundaries are
  schemas
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — eval each step
  independently
- `.aipe/study-system-design/` — the pipeline / request-flow shape
</content>
