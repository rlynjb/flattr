# 04 · Agents & Tool Use

> **flattr is a deterministic pipeline, not an agent — control flow is
> code-decided, never model-decided.**

Every concept here is **study material**. flattr has no LLM, no agent loop, no
tool-calling, no model. That makes it the cleanest possible *counterexample*: the
contrast between "code decides the next step" and "a model decides the next step"
is visible in every file, because flattr always sits on the code-decided side.

```
THE ONE AXIS THIS SECTION TURNS ON
┌──────────────────────────────────────────────────────────┐
│  who decides the next step / which tool / when to stop?    │
│                                                            │
│   CODE  ◀───────────────────────────────────────▶  MODEL  │
│   flattr lives here                       agents live here │
│   (fixed pipeline + A*)              (LLM loop + tools)     │
└──────────────────────────────────────────────────────────┘
```

The one honest bridge: flattr's pure functions are **tool-shaped** — `geocode`
(`pipeline/geocode.ts:9`), `routeSummary` (`features/routing/summary.ts:11`), and the
router (`features/routing/astar.ts`) all have typed I/O and no hidden state. They'd
make clean tools. Nothing calls them as tools. That's the seam, stated honestly —
no agent overclaim.

## The six

| # | File | One-line |
|---|------|----------|
| 01 | [agents-vs-chains](01-agents-vs-chains.md) | Chain = you fix the steps; agent = model fixes them. flattr is neither — fixed pipeline + fixed A*. |
| 02 | [tool-calling](02-tool-calling.md) | Model emits `{tool,input}`; your code runs it. flattr's pure fns are already tool-shaped — none are called as tools. |
| 03 | [react-pattern](03-react-pattern.md) | Thought→Action→Observation. N/A — flattr's only loop is A*'s PQ expansion, proven not learned. |
| 04 | [tool-routing](04-tool-routing.md) | Heuristic-front vs LLM-back dispatch. flattr is all-front, no LLM router. |
| 05 | [agent-memory](05-agent-memory.md) | Short-term context + long-term retrieval. flattr is stateless; only `userMax` persists (a pref, not memory). |
| 06 | [error-recovery](06-error-recovery.md) | Tool error→retry→max-iter stop. flattr's `BLOCKED=1e9` sentinel is the deterministic analog of graceful degradation. |

## Real seams (verified)
- **output→prompt** — `features/routing/summary.ts:11` (`routeSummary` → narration)
- **input→prompt** — `pipeline/geocode.ts:9` (natural-language destination parsing)
- **injection vector** — `pipeline/geocode.ts:27,52,69` (OSM `display_name` is untrusted)
- **degradation analog** — `features/routing/cost.ts:5,18` (`BLOCKED=1e9`, spec §14.4)
