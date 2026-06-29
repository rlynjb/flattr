# Template — agentic coding / build system

Generic interview template (nine-bullet shape). flattr *has* a build system
(`pipeline/`), but it's a deterministic chain, not an agentic one — so this
template applies only as a contrast.

- **The prompt:** "Design an agent that completes a coding task across a
  repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then execute
  per file) + verifier-critic (run tests / review the diff, loop on failure)
  + guardrails (scope the writable files, cap iterations).

```
  retrieve repo context → PLAN → execute (edit) → VERIFY (tests)
                            ▲                          │
                            └──── re-plan on failure ──┘  (cap rounds)
```

- **Data model:** repo context (file tree, relevant files retrieved), the
  plan, the diff, test results, an iteration counter.

- **Key components:** retrieval over the codebase (which files matter),
  planning, execution (edits), verification (tests/review), the re-plan
  trigger on verification failure. Decision: plan-and-execute vs pure ReAct
  for the edit loop.

- **Scale concerns:** large repos blow the context budget (retrieval routing
  over the codebase), long tasks blow the iteration cap, cost per task.

- **Eval framing:** task success (tests pass), trajectory efficiency (edits
  and re-plans to completion), regression rate (did it break something else).

- **Common failure modes:** editing files outside scope, plan assumptions
  breaking mid-execution (re-plan), verifier sharing the producer's blind
  spots, context loss across long tasks.

- **Applies to this codebase:** **No, as an agent — but flattr has the
  deterministic skeleton of one.** flattr's build pipeline
  (`pipeline/run-build.ts`) is a *plan-and-execute chain with no model*: the
  "plan" is the fixed engineer-written stage order (osm → split → elevation →
  grade → build-graph), the "execute" is each pure transform, and the
  "verify" is the test suite (Vitest) plus the A* admissibility invariants.
  Same plan→execute→verify *shape*, zero model — which is exactly the
  chains-vs-agents point: a plan-execute structure doesn't require an agent.

- **How to make it apply:** flattr isn't a coding-agent target — the artifact
  it builds is `graph.json`, not code. The honest framing for an interview is
  the contrast: "my build pipeline is plan-execute-verify *without* a model,
  which is the deterministic baseline you should reach for before an agentic
  build system. You'd only add a model if the build steps became
  data-dependent in a way the engineer can't sequence in advance" — and
  flattr's never do (the stage order is fixed regardless of input). That "I
  used a chain because the steps were known" answer is stronger than reaching
  for an agentic builder.

## See also
- `../01-reasoning-patterns/01-chains-vs-agents.md` — the pipeline as a chain
- `../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`
- `01-multi-agent-research-assistant.md` · `02-agentic-support-system.md`
