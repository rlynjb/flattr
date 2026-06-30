# 07 — Clocks, Coordination, and Leadership

**Industry names:** physical vs logical clocks / Lamport & vector clocks / leases
/ leader election / split-brain. **Type:** Industry standard.

> **Status in flattr: NOT YET EXERCISED.** flattr has one client and no
> coordinating peers, so there is no "who's in charge?" question, no shared clock
> to reconcile, no lease to hold, no leader to elect, no split-brain to fear. This
> file teaches the concepts and names the trigger. The only timestamps flattr
> touches are *local* (`setTimeout` debounce/retry timers) and they coordinate
> nothing across a boundary — labelled below as the non-example.

## Zoom out, then zoom in

You know how `Date.now()` on your laptop and `Date.now()` on a server can differ
by seconds, and neither is "right"? The instant two machines need to agree on the
*order* things happened, or on *which one of them is in charge*, you've hit the
hardest problems in distributed systems — because there is no shared "now" and no
shared "who." flattr never asks either question.

```
  Zoom out — where coordination would sit IF flattr had peers

  ┌─ Client (you own) — the ONLY participant ─────────────────────┐
  │  local setTimeout timers (debounce, retry) — coordinate        │
  │  NOTHING across a boundary                                     │ ← we are here
  └───────────────────────┬───────────────────────────────────────┘
                          │  HTTP (request/response — no peer to agree with)
                          ▼
  ┌─ ★ peers / replicas flattr DOES NOT HAVE ★ ───────────────────┐
  │  who's the leader? whose write wins? did A happen before B?   │ ← not yet
  │  → leases, leader election, logical clocks                    │   exercised
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concepts are **logical clocks** (ordering events without a shared
physical clock), **leases** (a time-bounded "you're in charge" grant), **leader
election** (picking the one node that decides), and **split-brain** (the failure
where two nodes both think they're leader). flattr exercises none because
coordination needs ≥2 participants and flattr has one.

## The structure pass

**Layers (hypothetical, the day flattr grows peers).** Three: ordering (can we
agree what happened first?), leadership (who decides?), and safety (what stops two
nodes both deciding?).

**Axis — trace `who is authoritative?` as participants are added.**

```
  One axis — "who has the final say?" — as you add participants

  ┌─ today: one client ─────────────────┐
  │ THIS client is authoritative,        │  → trivial: no one to disagree
  │ trivially (no peer exists)           │
  └──────────────────┬───────────────────┘
                     │  add a second device ↓
  ┌─ two devices, shared backend ───────┐
  │ authority is now CONTESTED:          │  → need ordering: whose edit wins?
  │ which device's last write is "last"? │     (last-write-wins needs a clock you
  └──────────────────┬───────────────────┘      can't trust → logical clocks)
                     │  add replicas that take writes ↓
  ┌─ replica set ───────────────────────┐
  │ authority must be GRANTED + bounded: │  → leader election + lease;
  │ one leader, lease expires, re-elect  │     two leaders = split-brain (the bug)
  └───────────────────────────────────────┘
```

The axis exposes the progression: authority goes from trivial (one node) to
contested (two nodes, need ordering) to granted-and-bounded (replicas, need
election + leases). flattr sits at the trivial end and the absence is correct.

**Seam.** The seam that *would* matter is the lease boundary — the moment a node's
"I'm the leader" grant expires and must be renewed or surrendered. flattr has no
lease because it has no shared resource two nodes contend for.

## How it works

### Move 1 — the mental model: order without a shared clock

Physical clocks drift and can't be trusted to order events across machines (clock
skew can make a *later* event look *earlier*). **Logical clocks** solve this by
ordering events with *counters* instead of *time*: a **Lamport clock** is a single
counter each node bumps on every event and piggybacks on every message, giving a
consistent "happened-before" order without any physical time at all.

```
  The pattern — Lamport clock: order from counters, not time

  node A:  e1(1) ──► e2(2) ──msg(2)──┐
                                      ▼
  node B:  e3(1) ──► e4(2) ──► e5(max(2,4)+1 = 5)  ← on receive: bump past sender's
                                                       counter, so cause < effect always

  rule: on send, attach counter; on receive, counter = max(mine, theirs) + 1
  result: if A→B (A caused B), then clock(A) < clock(B). guaranteed ordering,
          zero reliance on a trustworthy "now".
```

A **vector clock** extends this to detect *concurrent* events (neither caused the
other) — the thing you need to spot conflicting writes in multi-leader replication.
flattr needs neither, because it has no second node generating events to order.

### Move 2 — leadership, leases, and the split-brain it prevents

**Leader election — the kernel.** When N nodes must have exactly one decision-maker
(who takes writes, who runs the cron, who's the primary), they run an election:
propose, vote, a majority agrees on one leader. What breaks without each part:

- **drop the majority requirement** → a partition can let *each side* elect its own
  leader → two leaders → **split-brain**, the canonical distributed bug where both
  halves accept conflicting writes and the data forks irreconcilably.
- **drop the lease (time bound)** → a leader that hangs or partitions never gives
  up the role, and no new leader can take over → the cluster stalls.

**Leases — the kernel.** A lease is a leadership grant that *expires*. The leader
must renew it before it lapses; if it can't (it crashed or partitioned), the lease
expires and another node can safely claim leadership — *because the old leader knows
its lease is gone and stops acting as leader.*

```
  The pattern — a lease prevents split-brain by EXPIRING

  leader holds lease ──renew──► renew ──► (network partition!) ──╳ can't renew
                                                                  │
  time ────────────────────────────────────────────► lease EXPIRES
                                                                  │
  old leader: lease gone → I STOP being leader (no split-brain)   │
  new node:   lease free → I claim it → I'm leader now ◄──────────┘

  drop the expiry → old leader keeps writing after the partition → TWO leaders
```

The split-brain-prevention property of an *expiring* lease is the part people
forget — it's why a lease is safer than a permanent lock: a permanent lock held by
a dead node is held forever; a lease held by a dead node frees itself.

**The non-example in flattr.** flattr's only timers are `setTimeout`s —
`DEBOUNCE_MS` (`useTileGraph.ts:64`), `RETRY_MS` (`:71`), the persist debounce
(`elevCache.ts:8`). These look superficially clock-ish but coordinate *nothing
across a boundary*: they're local scheduling, single-threaded, single-process. No
peer reads them, no agreement depends on them. Calling these "coordination" would
be the kind of overclaim the anchoring rules forbid — they're local timers, full
stop.

### Move 2.5 — current vs future: the trigger

```
  Phase A (now)                vs   Phase B (the trigger)
  ─────────────────                ──────────────────────
  one client, trivially            multi-DEVICE sync: same user, two phones,
  authoritative                    a shared backend
  no shared clock                  ↓
  no lease / no leader             ordering: whose edit is "latest"? last-write-wins
  local timers coordinate nothing  needs a clock you can't trust → logical/vector clocks
                                   conflict: two devices edit offline → vector clocks
                                   detect the concurrency → you resolve or merge

  add WRITE replicas →             leader election + leases → split-brain risk arrives
```

The trigger from `00`: **multi-device sync** (the same user on two devices, or any
backend that elects a primary). The moment two participants can both claim "mine is
the current state," you inherit ordering (logical clocks) and, if they take writes,
leadership (election + leases) and the split-brain failure mode.

### Move 3 — the principle

There is no shared "now" and no shared "who" across machines — physical clocks
drift and any node can be partitioned away mid-decision. So distributed systems
manufacture both: logical clocks manufacture *order* from counters, and leases
manufacture *bounded authority* from expiry. flattr needs neither because
coordination requires ≥2 participants and it has one. **The day a second device or
a write-taking replica appears, "who decides?" and "what happened first?" become
real questions with no free answer — and an expiring lease, not a permanent lock,
is what keeps a partition from producing two leaders.**

## Primary diagram

What flattr would need, by participant count.

```
  the coordination ladder (flattr is on the bottom rung)

  1 participant   → trivial authority, no clock, no lease   ◄ flattr is HERE
        │ + a second device (multi-device sync)
        ▼
  2 participants  → ordering problem → logical/vector clocks (whose write is last?)
        │ + write-taking replicas
        ▼
  N replicas      → leadership problem → leader election + LEASES
                    │ partition without expiring leases
                    ▼
                  SPLIT-BRAIN (two leaders, forked data) ← the bug leases prevent
```

## Interview defense

**Q: "Does this app have any coordination or leadership concerns?"**
Verdict first: "No — it's a single client with no peers, so there's no 'who's in
charge?' and no shared clock. The only timers are local `setTimeout`s for debounce
and retry; they coordinate nothing across a boundary, so calling them coordination
would be wrong." Then the trigger: "Coordination shows up the moment there's a
second participant — multi-device sync brings an ordering problem you'd solve with
logical or vector clocks; write-taking replicas bring a leadership problem you'd
solve with election plus expiring leases, and an *expiring* lease is what stops a
partition from producing two leaders." Naming the absence honestly *and* the
split-brain-prevention property of leases is the signal.

```
  the sketch you draw

  1 node  → no coordination (flattr)
  2 nodes → ordering   → logical clocks (no trustworthy "now")
  N nodes → leadership → lease that EXPIRES → no split-brain
```

**Q: "Why a lease instead of a lock for leadership?"**
"Because a lock held by a crashed node is held forever — the cluster stalls. A
lease *expires*, so a dead leader's grant frees itself and a new leader can safely
take over. The expiry is also what prevents split-brain: the old leader knows its
lease lapsed and stops acting as leader." That self-freeing property is the one
clock fact interviewers check.

**Anchor:** *No shared "now" and no shared "who" — flattr has one participant so it
needs neither; the day it grows a second, logical clocks manufacture order and an
expiring lease manufactures bounded authority that can't split-brain.*

## See also

- `01` — why flattr has one node.
- `04` — multi-device sync brings read-your-writes + last-write-wins conflicts.
- `05` — leader election is the missing half of replication failover.
- `08` — cross-boundary workflows need coordination flattr also lacks.
- sibling **system-design** — coordination as an architectural concern.
