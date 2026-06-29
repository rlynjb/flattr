# Prompt Engineering — flattr

> **Honest framing up front.** flattr has **zero prompts and zero LLM
> calls** today. No `anthropic`, no `openai`, no model SDK anywhere in the
> tree. This is a pure-TypeScript grade-aware router. So this guide is not a
> tour of prompts that exist — it's a **map of the three seams where prompts
> WOULD live** if flattr grew a natural-language layer, anchored to the
> real files those prompts would attach to, and a working through of the 13
> prompt-engineering concepts using those seams as the anchor.
>
> Every concept file labels its content **future / seam**, never "present."
> Nothing here claims flattr does something it doesn't.

## The three seams (the spine of this whole guide)

```
  flattr's three prompt seams — none built, all anchored to real files

  ┌─ SEAM 1: output → prompt ───────────────────────────────────────┐
  │  features/routing/summary.ts  →  RouteSummary{distanceM,         │
  │  climbM, steepCount}  ──would be templated into──►  prompt       │
  │  ──►  LLM  ──►  "A mostly flat 3.2 km route along the water..."  │
  │  STRUCTURED OUTPUT becomes the INPUT to a prompt.                │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ SEAM 2: input → prompt ────────────────────────────────────────┐
  │  "somewhere flat near the water"  ──►  LLM parse  ──►            │
  │  structured geocode args  ──►  pipeline/geocode.ts geocode()     │
  │  FREE TEXT becomes STRUCTURED INPUT via a prompt.                │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ SEAM 3: injection boundary ────────────────────────────────────┐
  │  Nominatim display_name (attacker-influenceable OSM string)      │
  │  ──would flow into──►  any prompt at Seam 1 or 2                 │
  │  UNTRUSTED DATA crossing into a prompt = injection vector.       │
  └─────────────────────────────────────────────────────────────────┘
```

## Reading order

Operational discipline first, then the specific techniques.

| #  | File | One line |
|----|------|----------|
| 00 | [00-overview.md](00-overview.md) | The three seams, the no-prompts-today reality, the map |
| 01 | [01-anatomy.md](01-anatomy.md) | The four sections of a prompt — mapped onto Seam 1's template |
| 02 | [02-structured-outputs.md](02-structured-outputs.md) | Schema-enforced output — `RouteSummary` is already the schema |
| 03 | [03-prompts-as-code.md](03-prompts-as-code.md) | Versioned prompts — where a `prompts/` dir would live |
| 04 | [04-token-budgeting.md](04-token-budgeting.md) | Token counting — flattr's tiny payloads make this a teaching case |
| 05 | [05-eval-driven-iteration.md](05-eval-driven-iteration.md) | Evals before iteration — `fixtures.ts` is the eval substrate |
| 06 | [06-single-purpose-chains.md](06-single-purpose-chains.md) | One chain, one job — the pipeline is already this shape |
| 07 | [07-output-mode-mismatch.md](07-output-mode-mismatch.md) | JSON-vs-prose contract breaks across stages |
| 08 | [08-few-shot.md](08-few-shot.md) | Examples constrain harder than instructions |
| 09 | [09-chain-of-thought.md](09-chain-of-thought.md) | Reasoning prompts — and when they waste tokens |
| 10 | [10-self-critique.md](10-self-critique.md) | Self-critique / self-consistency for high-stakes output |
| 11 | [11-meta-prompting.md](11-meta-prompting.md) | LLMs writing prompts for other LLM calls |
| 12 | [12-prompt-injection-defense.md](12-prompt-injection-defense.md) | Seam 3 — defending the `display_name` injection vector |
| 13 | [13-forbidden-patterns.md](13-forbidden-patterns.md) | Stopping every route description sounding identical |

## Cross-links to sibling guides

- **`.aipe/study-security/`** — Seam 3 is the author-side of a trust
  boundary; the runtime-side (never let LLM output trigger side effects,
  output validation) lives there.
- **`.aipe/study-ai-engineering/`** — the production-serving seam: where
  these prompts would actually be invoked, retried, and logged.
- **`.aipe/study-agent-architecture/`** — if Seam 2 grew into a planning
  loop ("find me a flat loop that passes a coffee shop").
- **`.aipe/study-system-design/`** — the pipeline / request-flow shape the
  chains would slot into.
- **`.aipe/study-data-modeling/`** — `RouteSummary` and `Edge` are the
  structured shapes the prompts read and write.
- **`.aipe/study-testing/`** — `fixtures.ts` and the eval seam.
- **`.aipe/study-networking/`** — the Nominatim HTTP call that produces the
  untrusted `display_name`.
- **`.aipe/study-performance-engineering/`** — token cost as a latency and
  dollar budget.
</content>
</invoke>
