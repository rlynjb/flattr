# 04 — Agents and tool use

flattr has no agents. Its route flow is a deterministic, fixed-length
chain — tap/type → geocode → nearestNode → A* → summary → render — with no
LLM, no tool-calling loop, and no per-step reasoning. These files teach
the agent patterns as study material and stay honest about the absence,
while anchoring to what flattr *does* have:

- **A fixed chain, not an agent** — every step is a function call in a
  known order (`MapScreen.tsx:155–159`).
- **Tool-shaped functions** — `geocode`, `nearestNode`, `directedAstar`
  are typed, single-purpose operations an agent *would* call as tools.
- **All-heuristic routing** — decisions come from `haversine`, the cost
  function, and threshold tables; the one ML attach point is `penalty`
  (`cost.ts:16`), bound by A* admissibility.
- **Deterministic error-shape discipline** — the real, non-agent analog of
  error recovery: throw vs `null` vs flagged-path, with a *finite*
  `BLOCKED` (`cost.ts:5`) separating "no flat route" from "no route."

## Files

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — flattr's pipeline is a
  fixed chain, not an agent loop; an added NL-parse step would still be a
  2-step chain.
- [02-tool-calling.md](02-tool-calling.md) — N/A; if an agent existed,
  `geocode`/`route` would be the tools. Their signatures are already
  tool-shaped.
- [03-react-pattern.md](03-react-pattern.md) — N/A; flattr has no LLM
  reasoning loop. A*'s search loop is algorithmic, not ReAct.
- [04-tool-routing.md](04-tool-routing.md) — flattr is 100% heuristic
  routing; the only learnable point (`penalty`) stays a cost inside
  deterministic search.
- [05-agent-memory.md](05-agent-memory.md) — N/A; flattr is stateless per
  route. The `useMemo` is input-keyed memoization, not memory.
- [06-error-recovery.md](06-error-recovery.md) — flattr's real, disciplined
  error shaping: distinct shapes per failure mode, finite `BLOCKED`
  separating two user outcomes.

## Reading order

Self-contained per concept. Straight through, the honest arc is:
agents-vs-chains (flattr is a chain) → tool-calling (the would-be tools) →
ReAct (no reasoning loop) → tool-routing (all heuristic) → agent-memory
(stateless) → error-recovery (the one with the richest real flattr
content, including the finite-`BLOCKED` trick).
