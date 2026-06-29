# Clocks, Coordination & Leadership

**Status: `not yet exercised`.** flattr has no second node to order events against, no leader to elect, no lease to hold, no split-brain to fear. There's one process. This file teaches the concepts and names the trigger — multi-device sync of user data — that would force each one into the design.

> Per `me.md`: consensus/leadership/coordination-at-scale is part of the named horizontal-scale gap. Taught here honestly, not claimed from the repo.

## Zoom out, then zoom in

```
  Zoom out — where clocks/coordination WOULD live (all empty)

  ┌─ Single node ───────────────────────────────────────────────┐
  │  one process, one wall clock, one writer (the user)          │ ← we are here
  │  ordering of events: trivial (local program order)           │
  │  (leadership slot: EMPTY · lease slot: EMPTY · clock-sync     │
  │   slot: EMPTY — no other node to disagree with)              │
  └──────────────────────────────────────────────────────────────┘
        │ trigger: a SECOND writer appears (phone B, a server)
        ▼
  ┌─ would-be multi-writer tier (does not exist) ────────────────┐
  │  [ no logical clocks, no leader election, no consensus ]      │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** In one process, "what happened before what" is free — it's program order, one clock, one thread of truth. The moment two nodes both make changes, that free ordering evaporates: wall clocks drift and disagree, so you can't trust timestamps to say which write won; you need *logical* clocks (Lamport, vector) that order events by causality, or a single elected *leader* that serializes all writes so there's one authority. Leadership brings its own hazard — split-brain, where two nodes both think they're leader — which leases and consensus exist to prevent. flattr needs none of this because it has exactly one writer.

## Structure pass

**Layers.** Today: one writer, one clock. Future: multiple writers needing an ordering authority.

**The axis: `control` — who decides the order of writes?**

```
  The control axis — who orders writes?

                  │ today (flattr)        │ when a 2nd writer appears
  ────────────────┼───────────────────────┼──────────────────────────
  # of writers    │ 1 (the user, local)   │ 2+ (phone A, phone B, server)
  ordering source │ program order (free)   │ logical clock OR a leader
  authority       │ implicit (one thread) │ elected leader / consensus
  failure to fear │ none                   │ split-brain (two leaders)
```

**The seam that doesn't exist yet.** It's the boundary between "one writer" and "many." flattr never crosses it. Cross it and ordering flips from free to the single hardest problem in distributed systems — agreeing on order without a shared clock.

## How it works

### Move 1 — the mental model

You know program order from any single-threaded code: line 2 happens after line 1, no question. Now imagine two phones editing the same saved-routes list offline, then both come online. Whose edit is "later"? Their wall clocks disagree by seconds. Timestamps lie. That's the entire problem.

```
  Why wall clocks can't order distributed writes

  phone A clock: 10:00:05  ──edit X──►┐
  phone B clock: 10:00:03  ──edit Y──►┤  both sync to server
                                      ▼
  "Y is older" by timestamp — but B's clock is just SLOW.
  X may have causally happened first. Wall time ≠ causal order.

  fixes:
   • logical clock (Lamport): a counter that increments on each event,
     so ordering follows CAUSALITY not wall time
   • single leader: one node assigns the order; no clock comparison needed
```

### Move 2 — the walkthrough (concept + trigger)

**Part 1 — logical clocks, and their trigger.** A Lamport clock is a per-node counter bumped on every event and on every message received (`max(local, received) + 1`), giving a consistent "happened-before" order without synchronized wall clocks. Vector clocks go further: they detect *concurrent* writes (true conflicts) vs causally-ordered ones.

```
  Trigger for logical clocks in flattr

  TODAY                          TRIGGER                      THEN
  ─────                          ───────                      ────
  one device, one writer    →    saved routes sync across  →  need to order
  (program order = truth)        2+ devices, offline edits     concurrent edits
                                                                → Lamport/vector
                                                                  or last-writer-wins
```

The honest framing: flattr's *base* data (the graph) never needs this — it's read-only, built once. Only *user-generated* state (saved routes, preferences) edited on multiple devices would. That's the same trigger as replication's write (`05`) — these two files share a trigger because writes-across-nodes is the root cause of both.

**Part 2 — leadership, and why a single leader is often the simpler answer.** Instead of every node reasoning about clocks, elect *one* node as leader; all writes go through it, it assigns the order, followers replicate. Simpler to reason about — but now you must handle the leader dying (re-elect) and the nightmare of *two* nodes both believing they lead.

```
  Leader-based ordering vs the split-brain hazard

  HAPPY PATH                          SPLIT-BRAIN (the failure)
  ┌────────┐                          ┌────────┐    ┌────────┐
  │ leader │◄── all writes            │leader? │    │leader? │
  └───┬────┘                          └───┬────┘    └───┬────┘
   replicate                          both accept writes → divergent state
  ┌───▼────┐ ┌────────┐               (network partition made each think
  │follower│ │follower│                the other died)
  └────────┘ └────────┘               FIX: lease (time-bounded leadership)
                                            + consensus (Raft/Paxos) to agree
                                            on exactly one leader
```

**Part 3 — leases and consensus, why they're far off.** A *lease* is time-bounded leadership: you're leader only until the lease expires, so a partitioned old leader stops acting before a new one starts — no overlap, no split-brain. *Consensus* (Raft, Paxos) is the protocol a cluster uses to agree on one leader and one log order despite failures. flattr is multiple triggers from this: it needs multiple writers first, then enough nodes that you'd elect a coordinator. Don't reach for Raft before you have a cluster.

### Move 2.5 — current vs future

```
  Phase A (now)                  Phase B (multi-device user data)
  ─────────────                  ───────────────────────────────
  1 writer, program order        2+ writers, offline edits
  wall clock fine (display only)  wall clock UNTRUSTWORTHY for ordering
  no leader (no cluster)         either: server-as-leader (simple)
  no consensus                          or: CRDT/vector clocks (leaderless)
                                  split-brain becomes a real risk
```

The decision at Phase B is the classic one: **leader-based** (server orders all writes — simple, but the server is a bottleneck and SPOF until you add consensus) vs **leaderless** (CRDTs / vector clocks merge concurrent edits — no SPOF, but harder to reason about). For flattr's likely scale, server-as-leader is the pragmatic call.

### Move 3 — the principle

Time is the lie at the heart of distributed systems: you cannot trust a wall clock to tell you what happened before what, because clocks drift and there is no global "now." The two escapes are logical clocks (order by causality, not time) and a single leader (one node defines the order). flattr sidesteps the whole problem by having one writer — and that's the right call until a second writer exists. The moment user data lives on two devices, ordering stops being free and you must choose: a leader, or logical clocks.

## Primary diagram

```
  Clocks / coordination / leadership — flattr's status

  ┌─ TODAY: one writer ───────────────────────────────────────────┐
  │  program order = truth · wall clock used only for display      │
  │  logical clock ✗   leader ✗   lease ✗   consensus ✗            │
  └───────────────────────────────────────────────────────────────┘
        │ trigger: 2nd writer (multi-device sync of saved routes)
        ▼
  ┌─ ordering stops being free ───────────────────────────────────┐
  │  wall clocks disagree → can't order writes by timestamp        │
  │  choose:                                                       │
  │    leader-based  → server serializes writes (simple, SPOF)     │
  │    leaderless    → CRDT / vector clocks (no SPOF, complex)     │
  │  guard split-brain → leases + consensus (Raft) once clustered  │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

Lamport's 1978 "Time, Clocks, and the Ordering of Events" is the foundational paper — the happened-before relation and logical clocks. Vector clocks (Fidge/Mattern) extend it to detect concurrency. Raft (Ongaro 2014) is the readable modern consensus protocol for leader election + log replication; Paxos is its harder ancestor. The "wall clocks lie" lesson is why Google built TrueTime (bounded clock uncertainty with atomic clocks) for Spanner — they spent hardware to make timestamps trustworthy because the alternative is so painful. flattr is `not yet exercised` here for the cleanest possible reason: a single writer needs no agreement about order. Sibling `study-system-design` owns the leader-vs-leaderless architecture decision; this guide owns why the decision becomes mandatory.

## Interview defense

**Q: "If flattr synced saved routes across a user's phone and laptop, how would you order conflicting edits?"**
Lead with why timestamps fail, then the two real options.

```
  wall clock lies → choose an ordering authority

  phone (clock +3s) edit  ─┐
  laptop (clock -2s) edit  ─┤─► can't trust timestamps
                           ▼
   option A: server-as-leader (serializes writes)  ← I'd pick this
   option B: CRDT / vector clocks (leaderless merge)
```

"I would *not* order them by wall-clock timestamp — the two devices' clocks drift and disagree, so 'later timestamp' doesn't mean 'happened later.' Two real options: make a server the leader so all writes get serialized through one authority — simplest, and fine for this scale even though the server is a SPOF until I add consensus — or go leaderless with CRDTs / vector clocks that merge concurrent edits by causality. For flattr I'd pick server-as-leader; the data is small and a single ordering authority is far easier to reason about than conflict-free merge types."

**Anchor:** *Wall clocks lie about order — pick a leader or a logical clock; never trust the timestamp.*

**Q: "Why nothing here today?"**
"One writer. Program order is the truth when there's a single thread of changes. Ordering only becomes a problem with a second writer — that's the trigger, and flattr hasn't crossed it."

**Anchor:** *One writer means order is free; the problem starts at writer number two.*

## See also

- `05-replication-partitioning-and-quorums.md` — shares the trigger (writes across nodes); replicas need this ordering.
- `04-consistency-models-and-staleness.md` — read-your-writes across devices needs this.
- `08-sagas-outbox-and-cross-boundary-workflows.md` — multi-step workflows need ordering too.
- sibling `study-system-design` — leader-vs-leaderless as an architecture choice.
