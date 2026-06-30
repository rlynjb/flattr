# Debate / verifier-critic

**Industry names:** debate · verifier-critic · producer-critic. **Type:**
Industry standard. **In this codebase: Not yet implemented** (no agents).
flattr's deterministic critic — `steepCount` — is the rule-based cousin
(see `../01-reasoning-patterns/05-reflexion-self-critique.md`).

> Agents argue or critique to refine quality. Lead with the shape.

---

## Zoom out, then zoom in

**Zoom out — the two flavors (Move 1 shape):**

```
  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A  │◄─►│agent B  │         │ producer │──►│ critic   │
  │(propose)│   │(counter)│         │          │◄──│(approve/ │
  └────────┘   └────────┘          └──────────┘   │ reject)  │
       │            │                              └──────────┘
       └─────┬──────┘                    loop until approved
             ▼                           (cap the rounds)
        judge picks
```

**Zoom in.** A second perspective catches errors a single pass misses.
Earns its overhead for high-stakes outputs. Every round is a full agent
turn — and two agents from the same model family share blind spots.

---

## How it works

### Move 1 — the mental model

flattr already runs a verifier — deterministically. `search()` produces a
route (the producer); `summarizePath` verifies it against `userMax`,
flagging `steepEdges` (the critic, `astar.ts:126`). The difference from a
real verifier-critic loop: flattr's critic is a *rule*, and it doesn't
loop — it reports.

### Move 2 — the same-blind-spot failure, and why flattr's critic avoids it

The named failure mode: two agents from the same model family share blind
spots, so the critic rubber-stamps the producer's errors. The mitigation —
use a *different* model family for the critic — is the same self-preference
bias from LLM-as-judge (cross-ref `study-ai-engineering`).

```
  blind-spot risk by critic type

  model critic, same family   → shares producer's blind spots (rubber-stamp)
  model critic, diff family   → catches more (the mitigation)
  flattr's rule critic        → zero shared blind spots — checks grade
                                exactly, but ONLY grade (can't generalize)
```

flattr's grade rule has *no* shared blind spot — it's not a model — but it
only checks one axis. That's the tradeoff a verifier-critic loop trades
the other way: generality for reliability.

### Move 3 — the principle

A second perspective earns its per-round cost for high-stakes outputs, but
only if the critic doesn't share the producer's blind spots — use a
different model family when stakes justify it. flattr's rule-based critic
is the zero-shared-blind-spot extreme: perfectly reliable, perfectly narrow.

---

## Interview defense

**Q: What's the failure mode of a verifier-critic loop?**

The critic sharing the producer's blind spots — same model family,
rubber-stamp. Mitigation: a different model family for the critic. flattr's
analogue avoids it entirely because its critic is a rule (`steepCount`
against `userMax`), not a model — zero shared blind spots, but it only
checks grade. That's the trade: a rule critic is reliable and narrow; a
model critic is general and risks the shared blind spot.

Anchor: *"flattr's `steepCount` critic has no shared blind spot because
it's a rule — a model critic trades that reliability for generality, which
is why you cross model families for high stakes."*

---

## See also

- `../01-reasoning-patterns/05-reflexion-self-critique.md` (single-agent critic)
- `06-swarm-handoff.md` · `09-coordination-failure-modes.md`
- Cross-ref: `study-ai-engineering`'s LLM-as-judge file (self-preference bias)
