# 01 — LLM foundations

The primitives of working with large language models, taught as study
material and then anchored to flattr's real code.

**Anchor — not present, here's the seam.** flattr has **no LLM, no
embeddings, no RAG, no trained model**. It is a hand-rolled A* router over
a grade-annotated street graph. So every LLM concept below is *not yet
exercised in flattr* — each file teaches the concept, marks it absent, and
names the precise seam where it would attach. The two recurring seams:

- **OUTPUT→PROMPT seam** — `features/routing/summary.ts:5`
  (`RouteSummary = {distanceM, climbM, steepCount}`), produced at
  `MapScreen.tsx:159`, consumed at `:368`. Where numbers would become
  prose.
- **INPUT→PROMPT seam** — `pipeline/geocode.ts:9` (geocode) /
  `MapScreen.tsx:82,:182` (autocomplete/resolve), and `userMax` at
  `MapScreen.tsx:56,:381`. Where fuzzy text/intent would enter.

The ML attach point for any learned scoring is `features/routing/cost.ts:16`
(`penalty`) — must stay ≥0 / monotone for A* admissibility, with `BLOCKED`
finite. And `features/grade/classify.ts` is a **threshold table**
(`if/else`), **not** an ML classifier — never call it ML.

## The nine files

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — an LLM is a sampled
  `tokens→tokens` function; flattr's router is the deterministic opposite.
  *Seam: the route-describe boundary at `summary.ts:5`.*
- [02-tokenization.md](02-tokenization.md) — text→integer tokens, the
  billing/context unit; flattr's only model-bound string is the tiny
  describe prompt. *Seam: `summary.ts:5` prompt; untrusted OSM
  `display_name` at `geocode.ts:27,:52`.*
- [03-sampling-parameters.md](03-sampling-parameters.md) —
  temperature/top-p/top-k; the structured route-describe call should run at
  `temperature=0`. *Seam: `summary.ts:5`.*
- [04-structured-outputs.md](04-structured-outputs.md) — schema-constrained
  JSON output so the renderer keeps a typed contract. *Seam: input schema
  is `RouteSummary` (`summary.ts:5`); output schema is new.* (pre-existing)
- [05-streaming.md](05-streaming.md) — stream vs await; describe is short
  (await fine), NL-parse must **not** stream (need the whole structured
  object). *Seams: `summary.ts:5` and the parse near `geocode.ts:9`.*
- [06-token-economics.md](06-token-economics.md) — cost ledger; the
  three-number prompt is sub-cent, and on-device (dryrun-style) makes it
  zero marginal. *Seam: `summary.ts:5`.*
- [07-heuristic-before-llm.md](07-heuristic-before-llm.md) — keep the
  deterministic path, call a model only for ambiguous parse/describe.
  flattr already lives on the heuristic side (router, `classify.ts`,
  `cost.ts:16`). *Seams: parse near `geocode.ts:9`, describe at
  `summary.ts:5`.*
- [08-provider-abstraction.md](08-provider-abstraction.md) —
  `getModel(provider)` factory; flattr has no provider layer, but
  local-first means on-device default + cloud fallback. *Seam: the call
  site at `MapScreen.tsx:159`; mirrors `geocode`'s `fetchImpl` injection
  (`geocode.ts:11`).*
- [09-user-override-locks.md](09-user-override-locks.md) — `_overridden_at`
  locks so model writes don't clobber human edits. flattr's `userMax`
  (`GradeSlider`) is already a hand-set knob. *Seam: `setUserMax` at
  `MapScreen.tsx:56,:381`.*

## Reading order

Start with `01` (what the function *is*), then `07` (why flattr correctly
uses none today). `02`/`03`/`05`/`06` are the per-call knobs; `04`/`08`/`09`
are the seams you'd build when the first call lands — all hanging off the
two seams above.
