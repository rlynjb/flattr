# Swarm / handoff

**Industry names:** swarm · handoff · peer-to-peer agents. **Type:**
Industry standard. **In this codebase: Not yet implemented** (no agents,
no handoff).

> Peer-to-peer control transfer, no central boss. The model itself decides
> when to hand control to a peer specialist. Lead with the shape.

---

## Zoom out, then zoom in

**Zoom out — the topology (Move 1 shape):**

```
      ┌────────┐  "you take it"  ┌────────┐
      │agent A  │ ──────────────► │agent B  │
      └────────┘                 └───┬────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
```

**Zoom in.** No supervisor — agents hand control directly to peers. More
flexible than supervisor-worker (no central bottleneck), harder to debug
(no single point knows the whole state). It introduces a failure that
supervisor-worker doesn't: infinite handoff (A→B→A→B).

---

## How it works

### Move 1 — the mental model

Contrast with supervisor-worker (`02`): there, control always returns to
the boss. In a swarm, control moves peer-to-peer, decided by the agents
themselves. flattr has no agents and no handoff, so this is pure study
material — but the failure it introduces maps onto a flattr concept the
reader knows.

### Move 2 — infinite handoff is flattr's missing closed-set

The infinite-handoff failure (A→B→A→B forever) is *exactly* the
non-termination flattr's A* avoids structurally. flattr's `closed` set
(`astar.ts:61`) guarantees each node is expanded once, so the search can't
cycle. A swarm has no `closed` set over handoffs — so it must add one:

```
  why A* can't infinite-loop, why a swarm can

  A*:     closed set → each node expanded once → can't cycle (FREE)
  swarm:  no closed set over handoffs → A→B→A→B possible
          → mitigation: a handoff COUNTER (the engineered closed-set)
            → force stop / escalate to human at the cap
```

The handoff counter is the swarm's version of the budget exit from
`../01-reasoning-patterns/02-agent-loop-skeleton.md` — the termination
guarantee flattr gets free and a swarm must build.

### Move 3 — the principle

Swarm trades the supervisor's central control (debuggable) for
peer-to-peer flexibility — and pays with a new non-termination risk that
needs an explicit handoff counter. flattr's `closed` set is the
deterministic proof that a cycle-prevention set is what makes
graph-shaped control terminate; a swarm has to add one by hand.

---

## Interview defense

**Q: What new failure does swarm introduce, and what's the fix?**

Infinite handoff — A→B→A→B with no central point to stop it. The fix is a
handoff counter that force-stops or escalates at a cap. That's the same
job flattr's `closed` set does for free: each graph node is expanded once,
so A* can't cycle. A swarm has no closed-set over handoffs, so it
engineers the counter — the budget exit, again.

Anchor: *"infinite handoff is the cycle flattr's `closed` set prevents for
free — a swarm has no closed-set over handoffs, so it adds a handoff
counter."*

---

## See also

- `02-supervisor-worker.md` (central control) · `07-graph-orchestration.md`
- `09-coordination-failure-modes.md` (infinite handoff, in the table)
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` (the budget exit)
