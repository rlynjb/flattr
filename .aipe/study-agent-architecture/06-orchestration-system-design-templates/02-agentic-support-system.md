# Template — agentic support / task system

The least-fit of the three for flattr. A support system *takes actions on a
user's behalf and escalates*; flattr computes routes and takes no actions.
The template is still worth walking — it's where flattr's one side-effect
tool and the missing guardrails matter.

- **The prompt:** "Design an agent that resolves user requests by taking
  real actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools
  (ReAct) → guardrails (input sanitize, action gating, output schema) →
  human escalation on low confidence or gated actions.

```
  user request
       ▼
  intent router → ReAct agent (tools) → guardrails → resolve
                                          │ low confidence / gated
                                          ▼
                                    human escalation
```

- **Data model:** run history with tool calls + confidence per turn,
  escalation log, tool registry, action audit trail.

- **Key components:** routing, the agent loop, guardrails, escalation gate,
  audit logging. Decision: which actions need human approval (irreversible /
  high-stakes) vs auto-execute.

- **Scale concerns:** tool-call cascade under load
  (`../03-multi-agent-orchestration/09-coordination-failure-modes.md`), cost
  per resolved request, escalation queue as the human bottleneck.

- **Eval framing:** resolution rate without escalation, tool-call accuracy,
  adversarial set (prompt injection, out-of-scope), action-safety (no
  unauthorized side effects).

- **Common failure modes:** prompt injection in user input, the agent taking
  an unsafe action directly, infinite loop on an unsolvable request,
  hallucinated tool results.

- **Applies to this codebase:** **no.** flattr takes no actions on anyone's
  behalf — it computes routes and returns them. The only side effect anywhere
  is `geocode` reading Nominatim, which is a read, not a user-facing action.
  There's nothing to gate, nothing to escalate, no action audit trail.

- **How to make it apply:** this template doesn't fit flattr's domain — and
  forcing it would be inventing a product flattr isn't. The honest answer in
  an interview: "flattr is a computation, not an actuator — the
  support-agent template's action-gating and escalation don't apply; the
  pieces that *would* transfer are the input guardrail (sanitize the address
  query before geocoding) and the output schema (validate the route),
  covered in `../04-agent-infrastructure/05-guardrails-and-control.md`." Name
  the mismatch rather than retrofit it.
