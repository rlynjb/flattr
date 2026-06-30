# Prompt Engineering — flattr study guide

13 concepts in a working-AI-engineer voice, anchored to real flattr files. Generated per `study-prompt-engineering.md`.

> **Read `00-overview.md` first.** It states the load-bearing honesty up front: **flattr has no prompts and no LLM calls.** This guide maps the three future *seams* where prompts would attach, anchored to real, tested code. Everything is labeled seam/future, not present. Nothing is invented.

## The three seams (every file references these)

| Seam | Direction | Anchor | What it would do |
|---|---|---|---|
| **1 — describe my route** | output → prompt | `features/routing/summary.ts:5` (`RouteSummary`) + `types.ts:36` (`Path.steepEdges`) | template a structured route summary into a prompt for a natural-language description |
| **2 — NL-destination parse** | input → prompt | `pipeline/geocode.ts:9` (`geocode(query)`) | parse free text ("flat near the water") into structured geocode input via an LLM |
| **3 — injection defense** | trust boundary | `pipeline/geocode.ts:27` (`display_name`) | defend against attacker-edited OSM place names interpolated into a prompt |

## Reading order

Operational discipline first, then specific techniques. New to the discipline? Read top to bottom.

### Operational foundations (read first)

| # | File | One line |
|---|---|---|
| 00 | `00-overview.md` | The honesty, the three seams, the real anchors |
| 01 | `01-anatomy.md` | A prompt is four sections with two lifetimes — constant vs per-call |
| 02 | `02-structured-outputs.md` | Declare schema → provider enforces → you validate → retry (Seam 2) |
| 03 | `03-prompts-as-code.md` | Version the prompt+model *pair*; log which produced which (like `graph.json`) |
| 04 | `04-token-budgeting.md` | The `Edge.geometry` polyline trap; `routeSummary` is the compressor |
| 05 | `05-eval-driven-iteration.md` | `fixtures.ts` is a golden set; iterate against it, not vibes |

### Composition

| # | File | One line |
|---|---|---|
| 06 | `06-single-purpose-chains.md` | One chain, one job — like `osm→elevation→split→grade` |
| 07 | `07-output-mode-mismatch.md` | JSON-vs-prose mismatch at a chain boundary breaks the parser |

### Techniques

| # | File | One line |
|---|---|---|
| 08 | `08-few-shot.md` | Examples out-constrain instructions; source them from `fixtures.ts` |
| 09 | `09-chain-of-thought.md` | `penalty()`-shaped multi-step decisions; reasoning in a thinking field |
| 10 | `10-self-critique.md` | Check the description against `routeSummary` ground truth |
| 11 | `11-meta-prompting.md` | Use a model to draft prompts; human edit returns authorship |
| 12 | `12-prompt-injection-defense.md` | `display_name` is attacker-editable; hierarchy + delimiters + schema cage |
| 13 | `13-forbidden-patterns.md` | Stop every route description sounding identical (repeated generation only) |

## Real anchors used as teaching substrate

These exist today and do real work; the files borrow them honestly:

- `features/routing/summary.ts:5` — `RouteSummary {distanceM, climbM, steepCount}` → Seam 1, few-shot, CoT, self-critique
- `features/routing/types.ts:10,31,36` — `Edge`/`Path`/`steepEdges` → token trap, output-mode contracts
- `pipeline/geocode.ts:9,27` — `geocode(query)` / `display_name` → Seam 2, injection (Seam 3)
- `features/routing/fixtures.ts:46` — golden graphs → eval set + few-shot source + meta-prompt grounding
- `features/routing/cost.ts:16` — `penalty(g, max, k1, k2)` → CoT multi-step decision shape

## Cross-links to sibling guides

- `study-ai-engineering` — runtime serving side of these seams (where the LLM call executes, retries, streams)
- `study-agent-architecture` — if Seam 2's parse grows into a tool-calling loop
- `study-security` — the runtime-side trust-boundary audit that Seam 3 complements
- `study-system-design` — where these seams sit in flattr's pipeline/runtime split
- `study-testing` — the eval seam (`05`) as the AI-correctness counterpart to flattr's Vitest suite
- `study-data-modeling` — the `Graph`/`Edge`/`Path` types these seams contract against

## A standing reminder

Every concept here is **future/seam, not present**. flattr ships a router, not a prompt. The value of the guide is showing exactly *where* and *how* a prompt would attach to this real code — so when the feature lands, the discipline is already understood.
