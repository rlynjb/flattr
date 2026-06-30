# Reflexion / self-critique loop

**Industry names:** Reflexion · self-critique · self-refine. **Type:**
Industry standard. **In this codebase: Not yet implemented** (no LLM loop).

> The agent grades its own output and retries. A loop on top of a base
> pattern. flattr has a deterministic analogue worth naming: the route
> summary *checks* the path it produced (`steepCount`) — a critic step,
> but with a hard rule instead of a model.

---

## Zoom out, then zoom in

**Zoom out.**

```
  Zoom out — reflexion wraps a critic loop around a base pattern

  ┌─ base pattern (ReAct) produces a draft ───────────────────┐
  └──────────────────────────┬─────────────────────────────────┘
                             ▼
  ┌─ Critic: "correct / complete?" ───────────────────────────┐
  │        ┌──── good ────► return                            │
  │        └──── flawed ──► revise + loop (CAP the retries)   │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** A base pattern produces a draft; a critic step evaluates it;
if flawed, the agent revises and loops. The hard limit: a model
critiquing its own output shares the blind spots that produced it —
catches format/obvious errors well, subtle-reasoning errors poorly.

---

## How it works

### Move 1 — the mental model

flattr already has a deterministic critic. `routeSummary()`
(`summary.ts:11`) and the search itself compute `steepCount` /
`steepEdges` — "how many edges exceed the user's max grade?" That's a
critique of the produced route, with a *rule* (`directedGrade > userMax`,
`astar.ts:126`) instead of a model.

```
  flattr's deterministic critic (already in the code)

  search() → Path  ──► routeSummary() / summarizePath()
                          │
                          ▼
                    steepCount > 0 ?   ← the "critique"
                          │
              (today: just reported to the user)
              (reflexion: would loop — re-search with a
               looser userMax or a detour, cap the retries)
```

### Move 2 — the gap between flattr's critic and a reflexion loop

flattr *computes* the critique but doesn't *act* on it — it reports
`steepCount` to the UI (`RouteSummaryCard.tsx`) and stops. A reflexion
loop would close it: if `steepCount > 0`, revise (loosen `userMax`,
request a detour) and re-search, capping retries. The cap is the same
budget exit from `02-agent-loop-skeleton.md` — without it, a route that
*can't* go flat loops forever.

The honest limit, if the critic were a model: self-critique shares blind
spots. flattr's critic doesn't — it's a hard rule, so it catches the one
thing it checks (grade) perfectly. That's the tradeoff a model critic
loses: reliability for generality. Cost of a model critic: 2-5x tokens
for one extra reliability step.

### Move 3 — the principle

A critic loop layered on a base pattern buys reliability at 2-5x tokens —
worth it for format/obvious-error catching, weak for subtle reasoning
(shared blind spots). flattr shows the deterministic version: a rule-based
critic (`steepCount`) is perfectly reliable on its one axis but can't
generalize. Use a different model family for the critic when stakes
justify it.

---

## Interview defense

**Q: Does flattr do self-critique?**

It computes a critique deterministically — `steepCount` flags edges over
`userMax` (`astar.ts:126`) — but doesn't loop on it; it reports to the UI
and stops. A reflexion loop would close that: re-search on `steepCount>0`,
capped. The lesson flattr makes clean: a rule-based critic is perfectly
reliable on its one axis, where a model critic shares the blind spots that
made the draft.

Anchor: *"flattr's `steepCount` is a deterministic critic that reports but
doesn't loop — reflexion is that critic, made a model, wired back into a
capped retry."*

---

## See also

- `03-react.md` · `06-tree-of-thoughts.md` ·
  `../03-multi-agent-orchestration/05-debate-verifier-critic.md`
- Cross-ref: `study-prompt-engineering`'s self-critique concept (prompt
  mechanics)
