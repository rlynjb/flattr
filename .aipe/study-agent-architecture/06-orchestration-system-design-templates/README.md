# 06 — Orchestration system design templates

Three generic interview templates, generated for every guide regardless of
shape. The standard-architecture bullets are generic; the **Applies to this
codebase** and **How to make it apply** bullets are answered about flattr
only, using the nine-bullet template shape (not the per-concept template).

| File | Applies to flattr? |
|------|--------------------|
| [`01-multi-agent-research-assistant.md`](01-multi-agent-research-assistant.md) | **No** — flattr has one read-only source, no corpus, no model |
| [`02-agentic-support-system.md`](02-agentic-support-system.md) | **Partially** — this is flattr's one real agent seam (planner over router tools) |
| [`03-agentic-coding-system.md`](03-agentic-coding-system.md) | **No** — but flattr's pipeline is a plan-execute-verify *chain* (the deterministic contrast) |

Start with `02` — it's the closest to flattr's actual seam and names the
concrete refactor that would turn the router's tool-shaped functions into an
agent's tools.
