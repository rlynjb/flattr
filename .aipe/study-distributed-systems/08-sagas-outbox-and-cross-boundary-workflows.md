# Sagas, Outbox & Cross-Boundary Workflows

**Status: `not yet exercised`.** flattr has no multi-step workflow that writes across more than one system, so there's nothing to compensate, no dual-write to make atomic, nothing to reconcile. This file teaches the concepts and names the trigger — a workflow that writes to a database *and* a second system in one logical operation — that would force each in.

> Per `me.md`: distributed transactions / cross-boundary workflows belong to the horizontal-scale gap. Taught honestly; the repo has no instance.

## Zoom out, then zoom in

```
  Zoom out — where a saga/outbox WOULD live (all empty)

  ┌─ Coordination layer ─────────────────────────────────────────┐
  │  every cross-boundary call is a SINGLE-STEP READ              │ ← we are here
  │   fetchOverpass · sample · geocode — one call, no follow-up   │
  │  (saga slot: EMPTY · outbox slot: EMPTY · reconcile: EMPTY)   │
  └────────────────────────┬─────────────────────────────────────┘
                           │ no write spans two systems
  ┌─ would-be multi-write tier (does not exist) ─────────────────┐
  │  [ no DB+queue dual write, no multi-service transaction ]     │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** A saga is how you do a multi-step business transaction across systems that *don't share a transaction* — you can't `BEGIN…COMMIT` across a database and a payment API and an email service, so instead you run the steps one by one, and if step 3 fails you run *compensating* actions to undo steps 1–2. The transactional outbox solves a narrower problem: writing to your DB *and* publishing a message must either both happen or neither — so you write the message into an `outbox` table *in the same DB transaction*, and a separate process relays it, guaranteeing the message goes out iff the DB write committed. Both exist because there is no distributed `COMMIT`. flattr has neither because it never writes to two systems in one operation.

## Structure pass

**Layers.** Today: single-step reads. Future: a workflow chaining writes across systems.

**The axis: `failure` — when a multi-step op fails halfway, what state are you left in?**

```
  The failure axis — partial completion

                   │ today (flattr)        │ multi-step workflow
  ─────────────────┼───────────────────────┼──────────────────────────
  steps per op     │ 1 (one read)          │ N (write A, write B, notify)
  fail halfway?    │ impossible (1 step)   │ A done, B failed → INCONSISTENT
  recovery         │ retry the one read    │ compensate A (saga) / reconcile
  atomicity        │ trivial               │ none across systems → engineered
```

**The seam that doesn't exist.** It's the second write in one logical operation. A single read can't be "halfway done." The moment an operation has two writes to two systems, a new failure state appears — *partially applied* — that single-step flattr cannot reach. That seam is what sagas and outboxes exist to manage.

## How it works

### Move 1 — the mental model

You know a DB transaction: all-or-nothing within one database. The problem sagas solve is that there's no such thing *across* databases or services. So you fake atomicity with a sequence of steps plus undo actions.

```
  Saga = forward steps + compensating (undo) steps

  forward:   [save route]──►[charge user]──►[email receipt]
                                  │ FAILS
                                  ▼
  compensate: [refund]◄──[delete route]   (run undos in reverse)

  the saga guarantees: either all forward steps complete,
  or every completed step is compensated. No middle state survives.
```

### Move 2 — the walkthrough (concept + trigger)

**Part 1 — sagas, and their trigger.** A saga is a sequence of local transactions where each step has a compensating action; an orchestrator (or a chain of events) drives it and triggers compensation on failure. flattr has zero multi-step *write* workflows today — every cross-boundary call is one read with no follow-up write. The trigger is a real business workflow:

```
  Trigger for a saga in flattr

  TODAY                          TRIGGER                       THEN
  ─────                          ───────                       ────
  geocode (1 read)          →    "save route + charge for  →   saga:
  fetchOverpass (1 read)         premium + email confirm"      step + compensate
                                 (writes across 3 systems)     per step
```

Note: the *closest thing* flattr has to multi-step is `buildGraph` (Overpass → split → elevation → grade → assemble). But that's a pure read pipeline that produces one artifact — if any step fails, nothing was written anywhere, so there's nothing to compensate. A pipeline of reads is not a saga; a saga requires committed side effects you'd need to undo.

**Part 2 — the transactional outbox, and its trigger.** The dual-write problem: you write a row to your DB and publish an event to a queue. If the DB commit succeeds but the publish fails (or vice versa), the two systems disagree. The outbox fix:

```
  Transactional outbox — make DB-write + message-publish atomic

  ┌─ ONE DB transaction ──────────────────┐
  │  INSERT route                          │
  │  INSERT into outbox (event payload)    │  ← both commit together, or neither
  └────────────────┬───────────────────────┘
                   │ (committed)
                   ▼
  relay process: poll outbox ──► publish to queue ──► mark sent
   (message goes out IFF the DB write committed — no dual-write gap)
```

flattr's trigger: the day it both saves user data to a DB *and* publishes an event (analytics, a sync notification to other devices). Until there's a DB write *and* a second system to notify in the same operation, there's no dual-write to make atomic.

**Part 3 — reconciliation, the backstop.** Even with sagas and outboxes, distributed state drifts (a compensation itself fails, a relay misses a message). Reconciliation is a periodic job that compares the systems and fixes divergence — the "eventually someone audits the books" safety net. It's the last thing you build, after you have multiple writable systems that *can* drift. flattr has one writable thing (the local cache, `04`) and it self-heals locally, so there's nothing to reconcile across a boundary.

### Move 2.5 — current vs future

```
  Phase A (now)                  Phase B (cross-system write workflow)
  ─────────────                  ─────────────────────────────────────
  single-step reads only         multi-step writes across systems
  buildGraph = read pipeline     "save + charge + notify" = saga
   (no compensation needed)      compensating actions per step
  no dual write                  DB-write + publish → outbox pattern
  no cross-system drift          periodic reconciliation job
```

The cost of Phase B is the highest in this whole guide: workflow orchestration, idempotent compensations (a refund retried must not double-refund — note this loops back to `03`), an outbox table + relay, and reconciliation. This is exactly the "distributed transactions" territory `me.md` names as the gap. It's also the most worth building once for the portfolio, because it's where idempotency (`03`), ordering (`07`), and consistency (`04`) all compound at once.

### Move 3 — the principle

There is no distributed `COMMIT`. Every pattern in this file — saga, outbox, reconciliation — is a workaround for that single hard fact: you cannot atomically change two systems that don't share a transaction. The escape is always the same shape: make each step locally atomic, make it idempotent so you can retry it, and add an undo (saga) or an atomic hand-off (outbox) so partial failure resolves to a consistent end state. flattr avoids the whole category by keeping every cross-boundary operation a single read — which is the cleanest way to not need a saga: don't have a multi-step distributed write.

## Primary diagram

```
  Sagas / outbox / reconciliation — flattr's status

  ┌─ TODAY: single-step reads ────────────────────────────────────┐
  │  fetchOverpass / sample / geocode — one call, no write, no     │
  │  follow-up. buildGraph = read pipeline (no committed effects). │
  │  saga ✗   outbox ✗   reconciliation ✗                          │
  └───────────────────────────────────────────────────────────────┘
        │ trigger: one logical op writes to 2+ systems
        ▼
  ┌─ atomicity stops being free ──────────────────────────────────┐
  │  saga:   forward steps + compensations (undo on failure)       │
  │  outbox: DB-write + message in ONE txn, relayed separately     │
  │  reconcile: periodic drift audit + repair                      │
  │  (idempotent compensations ← loops back to 03)                 │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The saga pattern comes from Garcia-Molina & Salem (1987), originally for long-lived DB transactions, revived by microservices where cross-service transactions are impossible. The transactional outbox is the standard fix for the dual-write problem in event-driven systems (often paired with change-data-capture, e.g. Debezium tailing the outbox table). Two-phase commit (2PC) is the *other* answer — a coordinator that gets all participants to prepare then commit — but it blocks on coordinator failure and doesn't scale, which is why sagas (compensation over locking) won for most use cases. flattr is `not yet exercised` here because the precondition — a multi-step write across systems — never occurs. Sibling `study-system-design` owns the orchestration-vs-choreography architecture choice; `study-database-systems` owns the outbox table and 2PC mechanics.

## Interview defense

**Q: "flattr has a `buildGraph` pipeline with several steps — is that a saga?"**
Verdict: no, and the distinction is the point.

```
  read pipeline vs saga — committed effects decide

  buildGraph: read → read → read → ONE artifact
              fail anywhere → nothing written → just retry
  saga:       write → write → write
              fail anywhere → UNDO the committed writes (compensate)
```

"No — `buildGraph` is a multi-step *read* pipeline. If a step fails, nothing has been written to any external system, so there's nothing to undo; I just retry the whole thing. A saga is specifically for multi-step *writes* across systems that don't share a transaction, where step 2 failing means I have to compensate step 1's committed effect. The trigger for a real saga here would be something like 'save route + charge for premium + email a receipt' — three writes to three systems. That's when I'd need compensating actions and probably an outbox for the DB-write-plus-publish step."

**Anchor:** *A pipeline of reads isn't a saga — sagas exist to undo committed writes, and I have none.*

**Q: "How would you make a DB write and an event publish atomic?"**
"Transactional outbox: insert the domain row and an outbox row in the *same* DB transaction, so they commit together or not at all, then a separate relay polls the outbox and publishes. That closes the dual-write gap — the event goes out if and only if the DB write committed. And I'd make the consumer idempotent, because the relay is at-least-once."

**Anchor:** *Outbox makes DB-write + publish one atomic act — no distributed commit required.*

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — compensations must be idempotent; outbox is at-least-once.
- `04-consistency-models-and-staleness.md` — reconciliation is cross-system convergence.
- `07-clocks-coordination-and-leadership.md` — workflow steps need ordering.
- sibling `study-system-design` — orchestration vs choreography.
- sibling `study-database-systems` — outbox table + 2PC mechanics.
