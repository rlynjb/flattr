# 06 — Orchestration system design templates

**Anchor:** the studied codebase (flattr) reframed as interview templates.

Three generic "design an agentic X" prompts, each with a standard
architecture and a nine-bullet breakdown. They use the nine-bullet template
shape (prompt / standard architecture / data model / key components / scale
concerns / eval framing / common failure modes / applies to this codebase /
how to make it apply) — **not** the per-concept template (no Zoom out, How
it works, etc.).

All three appear regardless of flattr's shape. The generic bullets are
generic; the **"Applies to this codebase"** and **"How to make it apply"**
bullets are answered about flattr only — and since flattr has no agent, they
honestly say `no` / `partially` and name the concrete refactor.

## Files

1. `01-multi-agent-research-assistant.md` — best fit: the "plan a flat
   afternoon, 3 coffee stops" feature is exactly this shape (`partially`).
2. `02-agentic-support-system.md` — least fit (`no` — flattr takes no
   actions on a user's behalf).
3. `03-agentic-coding-system.md` — `no` — but the closest meta-anchor is
   aipe (per `me.md`), which generates this very guide.
