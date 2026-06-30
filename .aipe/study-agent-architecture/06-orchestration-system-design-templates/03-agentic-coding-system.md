# Template — agentic coding / build system

Doesn't fit flattr's runtime domain (it routes, it doesn't write code). But
the reader's portfolio has the nearest real anchor — **aipe** (per `me.md`),
the meta-tool generating this very guide: a describe → diagnose → act
layering driven by markdown specs. aipe is agent-*adjacent* and stops short
of an autonomous coding loop, which is itself the lesson.

- **The prompt:** "Design an agent that completes a coding task across a
  repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then
  execute per file) + verifier-critic (run tests / review the diff, loop on
  failure) + guardrails (scope the writable files, cap iterations).

```
  repo context → PLAN changes → EXECUTE per file → VERIFY (tests/review)
                     ▲                                   │ fail
                     └─────────── re-plan trigger ◄───────┘
                                  (cap iterations)
```

- **Data model:** repo context (file tree, retrieved relevant files), the
  plan, the diff, test results, an iteration counter.

- **Key components:** retrieval over the codebase (which files matter),
  planning, execution (edits), verification (tests/review), the re-plan
  trigger. Decision: plan-and-execute vs pure ReAct for the edit loop.

- **Scale concerns:** large repos blow the context budget (retrieval routing
  over the codebase), long tasks blow the iteration cap, cost per task.

- **Eval framing:** task success (tests pass), trajectory efficiency (edits
  + re-plans to completion), regression rate (did it break something else).

- **Common failure modes:** editing files outside scope, plan assumptions
  breaking mid-execution (re-plan), the verifier sharing the producer's blind
  spots, context loss across long tasks.

- **Applies to this codebase:** **no.** flattr is a routing engine; it
  generates no code and edits no files. The closest real instance in the
  reader's portfolio is **aipe** — markdown-as-source-of-truth, slash
  commands as the interface, a describe → diagnose → act layering. But aipe
  ships *no autonomous loop and no multi-agent system*: a slash command is a
  single guided LLM pass over a spec, not a self-directed plan→execute→verify
  agent. It's agent-adjacent and deliberately stops there — the same way
  flattr's router is a control loop that stops short of an agent.

- **How to make it apply:** for flattr specifically, this template doesn't
  apply — don't retrofit it. The transferable lesson, if asked, is the
  escalation discipline flattr *does* model: `bench/`-driven
  measure-then-escalate (Dijkstra→A*→bidirectional) is exactly the
  plan→verify→re-plan loop's instinct (verify against a metric, escalate on a
  named failure), just applied deterministically to search rather than to
  code edits.
