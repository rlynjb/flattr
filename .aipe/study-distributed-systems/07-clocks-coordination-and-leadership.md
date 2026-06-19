# Clocks, coordination, and leadership
### time, ordering, leases, leader election, split-brain — `not yet exercised`
**Industry name:** logical clocks, leader election, leases, split-brain · **Type:** Industry standard

## Zoom out, then zoom in

Verdict first: **clocks, coordination, and leadership are `not yet exercised`.** These patterns exist to make *multiple nodes agree on time, order, and who's in charge* — and flattr has one node live at a time, so there's no one to agree with. No Lamport clocks, no leases, no leader election, no split-brain risk. This file teaches the vocabulary and points at the *single* place flattr makes an ordering decision (the `pump()` priority rule), which is in-process scheduling, not distributed coordination.

```
  Zoom out — where coordination WOULD live (and why it's empty)

  ┌─ Coordination layer (the phone, ONE process) ───────────────┐
  │  pump(): corridor-before-view  ← LOCAL ordering, not         │
  │          distributed coordination                            │
  │  ┌ ★ where leader election / leases WOULD sit ★ ┐            │ ← empty
  │  │   (no second node to elect a leader among)    │            │
  │  └─────────────────────────────────────────────────┘          │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK ═══ (no coordination protocol)
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  stateless public APIs — they don't coordinate with you      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: clocks answer "in what *order* did events happen across machines whose wall-clocks disagree?"; leadership answers "of N equal nodes, which one is allowed to act?"; leases answer "how does a node *prove* it's still the leader without asking everyone constantly?" flattr asks none — there's no second node, no shared mutable resource to guard, no wall-clock to reconcile. The one ordering it does care about is purely local and decided by an `if/else`.

## Structure pass

**Layers.** Producers → `pump()` ordering → worker. The whole "coordination" story fits in one process.

**The axis: control — "who's allowed to act, and how is that decided?"**

```
  One question — "who's allowed to act, and who decides order?" — traced

  ┌──────────────────────────────────────┐
  │ producers (pan / route)               │  → not allowed to run directly
  └──────────────────────────────────────┘
      ▼
  ┌──────────────────────────────────────┐
  │ pump() if/else priority               │  → decides order LOCALLY, by code.
  └──────────────────────────────────────┘    no election, no lease, no vote.
      ▼
  ┌──────────────────────────────────────┐
  │ (distributed coordinator)             │  → DOES NOT EXIST. one node, no
  └──────────────────────────────────────┘    peers to coordinate with.
```

**The seam.** No seam — and again the absence is the lesson. A coordination seam exists where ≥2 equal nodes must agree on who acts or what order events took. flattr's ordering decision (corridor > view) is made by a single process reading its own two refs; there's no agreement because there's no second party. Local scheduling ≠ distributed coordination, and conflating them is the mistake to avoid.

## How it works

#### Move 1 — the mental model

You know ordering ambiguity from merging two git branches with commits at "the same time" — wall-clocks lie, so you need a *logical* order, not a timestamp. You know leadership from "only the primary accepts writes." You know leases from a lock with a TTL that auto-expires if the holder dies.

```
  The patterns flattr does NOT have — for vocabulary

  LOGICAL CLOCK             LEADER ELECTION          LEASE
  ─────────────             ───────────────          ─────
   node A: counter=5         3 nodes, 1 leader        leader holds lock(TTL=10s)
   sends msg(ts=5) ──►       ┌ vote ┐                 must RENEW before expiry
   node B: max(my,5)+1=6     A   B   C                 dies ⇒ lease expires ⇒
   ⇒ order without clocks    └─► B wins (majority)      another node takes over
```

flattr's actual ordering is none of these — it's `if (corridor) else if (view)`, a single process choosing from its own queue.

#### Move 2 — the one ordering decision, walked honestly

**`pump()`'s priority is local scheduling, not coordination.** Bridge from a thread scheduler picking the highest-priority runnable task. `pump` orders work by a fixed rule: corridor (route) before view (pan). That's a *real* ordering decision — but here's why it's not distributed coordination:

```
  Why pump's ordering is NOT distributed coordination

  DISTRIBUTED coordination          flattr's pump ordering
  ────────────────────────          ──────────────────────
  ≥2 nodes must AGREE on order       ONE process reads its own 2 refs
  needs a protocol (Paxos/Raft,      needs an if/else
    vector clocks, a lease)
  failure ⇒ split-brain (two         failure ⇒ nothing; one decider can't
    nodes both think they lead)        disagree with itself
  wall-clock skew is a problem        no clock involved at all
```

*The tell:* there's no agreement step. A distributed ordering needs a protocol because participants can disagree; flattr's needs none because one process decides alone. Calling `pump`'s priority "coordination" in an interview would overclaim; calling it local priority scheduling is exact.

**No timestamps, no ordering-by-time anywhere.** Worth stating: flattr orders work by *arrival into a slot* and *priority*, never by a timestamp. There's no event-ordering-across-machines problem because there are no events across machines — only request/response reads. So logical clocks have nothing to order.

#### Move 2.5 — what makes this real (the trigger)

```
  Phase A (now) vs Phase B (§11 D2/E2 multi-instance server)

  NOW — one process                MULTI-INSTANCE SERVER
  ─────────────────                ─────────────────────
  no leader (no peers)             N instances; if ONE must own graph rebuilds,
                                     you need LEADER ELECTION to pick it
  no lease                         that leader holds a LEASE so a crashed leader's
                                     job is taken over (not stuck forever)
  no clock skew                    cross-instance event ordering ⇒ logical clocks
                                     or a single-writer to avoid it
  no split-brain                   two instances both thinking they're the rebuild
                                     leader ⇒ SPLIT-BRAIN ⇒ double/torn rebuilds
```

The trigger is multiple server instances sharing a mutable resource — precisely the §11 D2 server-side served graph if rebuilds are centralized. The moment two equal instances could both try to rebuild "the Seattle graph," you need exactly one to win (election), proof it's still alive (lease), and protection against both believing they won (split-brain handling). None of that exists or is needed today.

#### Move 3 — the principle

Clocks, leadership, and leases are the cost of having *multiple equal nodes that could disagree about order or authority*. flattr has one decider, so it pays nothing — its only ordering is a local `if/else`. The general lesson: **don't reach for coordination protocols until you have ≥2 nodes that must agree** — and notice that a single-writer design (one node owns all writes) *avoids* most of this entirely. flattr is the degenerate single-writer: one process, no agreement, no clocks.

## Primary diagram

The recap — what exists (local ordering) vs. the empty coordination slots.

```
  Clocks/coordination/leadership in flattr — recap

  ┌─ EXISTS ────────────────────────────────────────────────────┐
  │  pump() local priority: corridor BEFORE view (an if/else)     │
  │  ordering = by slot + priority, never by timestamp            │
  └───────────────────────────────────────────────────────────────┘

  ┌─ `not yet exercised` (empty slots) ─────────────────────────┐
  │  ✗ logical/vector clocks   ✗ leader election                 │
  │  ✗ leases / TTL locks      ✗ split-brain handling            │
  │                                                              │
  │  trigger: §11 D2 multi-instance server with centralized      │
  │           graph rebuilds (≥2 nodes sharing a mutable resource)│
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** No coordination code exists to walk. The only ordering decision is `pump`'s priority, shown here so it's clearly *not* mistaken for distributed coordination:

```
  mobile/src/useTileGraph.ts  (lines 93–103, the ordering decision)

  if (pendingCorridorRef.current) {        ← corridor (route) wins
    kind = "corridor"; ...
  } else if (pendingViewRef.current) {     ← view (pan) only if no corridor
    kind = "view"; ...
  } else { return; }
       │
       └─ this orders work, but ONE process decides from ITS OWN refs.
          no peer to agree with, no protocol, no clock. local scheduling,
          not distributed coordination. (the scheduling/execution angle
          lives in study-runtime-systems; the queue angle in 06.)
```

That's the entire surface. Everything else here is `not yet exercised`.

## Elaborate

The reason to know these patterns despite their absence: leader election and leases are the canonical "you have N nodes now" tax, and recognizing when you've *crossed* into needing them is a senior signal. The single best way to *avoid* them is the single-writer pattern — route all mutations through one owner so there's never a disagreement to resolve. flattr is the trivial single-writer (one process), which is why it's coordination-free; many production systems deliberately keep a single-writer for exactly this reason, accepting the throughput ceiling to dodge consensus.

Split-brain is the failure these patterns prevent: two nodes both believing they're the leader, both acting, producing torn or doubled state. It's `not yet exercised` here because there's no leader to be split. It becomes real at the §11 D2 multi-instance stage if graph rebuilds are centralized — at which point a lease-based leader (only the lease-holder rebuilds; a crashed holder's lease expires and another node takes over) is the standard fix. Read next: `05` (the replication that coexists with leadership) and `08` (the workflows a leader would coordinate).

## Interview defense

**Q: "How do you handle clock skew / ordering / leader election here?"**
I don't need to — and that's a design property, not a gap. There's one process live at a time, so there are no peers to agree with, no shared mutable resource to guard, and no wall-clocks to reconcile. The only ordering I make is local: `pump()` runs route corridors before viewport pans, decided by an `if/else` reading two in-process refs. That's local priority scheduling, not distributed coordination — there's no agreement step because there's no second party. I'd only need election and leases at the §11 D2 multi-instance stage, if two server instances could both try to rebuild the same graph.

```
   one process decides order from its own 2 refs  → if/else, no protocol
   "do I have ≥2 nodes that must agree?"  → no  → no clocks/election/leases
```
*Anchor: I'm the degenerate single-writer — one decider can't disagree with itself.*

**Q: "When would split-brain become a risk?"**
The instant I run ≥2 server instances that could both try to own graph rebuilds (§11 D2). Two instances both thinking they're the rebuild leader would produce torn or doubled rebuilds. The fix is a lease-based leader: only the lease-holder rebuilds, and a crashed holder's lease expires so another node takes over. Today there's exactly one node, so there's nothing to be split. *Anchor: split-brain needs ≥2 equal nodes sharing a mutable resource — I have neither.*

## Validate

1. **Reconstruct:** define logical clock, leader election, and lease in one line each. Why does flattr need none today?
2. **Explain:** give the concrete tell that `pump`'s corridor>view priority (`useTileGraph.ts:93-103`) is local scheduling, not distributed coordination.
3. **Apply:** the spec runs two server instances that both rebuild the Seattle graph (§11 D2). Describe the split-brain failure and the lease-based fix.
4. **Defend:** a reviewer wants a "distributed lock" around tile builds. Argue why `busyRef` (an in-process boolean) is sufficient at one node and what would have to be true for a *real* distributed lock to be warranted.

## See also

- `05-replication-partitioning-and-quorums.md` — the replicas a leader would coordinate (also `not yet exercised`).
- `06-queues-streams-ordering-and-backpressure.md` — the `pump()` ordering at the queue altitude.
- `08-sagas-outbox-and-cross-boundary-workflows.md` — the multi-step workflows a leader would own.
- `.aipe/study-runtime-systems/` — `pump` ordering as scheduling/execution mechanics.
