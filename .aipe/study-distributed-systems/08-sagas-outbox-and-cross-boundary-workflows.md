# 08 — Sagas, Outbox, and Cross-Boundary Workflows

**Industry names:** saga pattern / compensating transactions / transactional
outbox / reconciliation / two-phase commit (and why you avoid it). **Type:**
Industry standard.

> **Status in flattr: NOT YET EXERCISED.** A saga is a multi-step *write* that
> spans services and must stay consistent when a middle step fails. flattr issues
> no writes across services — every remote call is a single, standalone, pure read
> (`03`). There is no "step 2 succeeded, step 3 failed, now undo step 1" anywhere.
> This file teaches the pattern and names the trigger. The one place flattr does
> multi-step orchestration (`buildGraph`) is a *local* pipeline, labelled below as
> the non-example.

## Zoom out, then zoom in

You know how a database transaction gives you all-or-nothing — either every write
commits or none do, and you never see a half-done state? Now take those writes and
spread them across *different services* that each have their own database. You've
lost the transaction: there's no `BEGIN`/`COMMIT` that spans a payment service and
an email service. A saga is how you get *approximately* all-or-nothing back when a
real transaction is impossible.

```
  Zoom out — where a saga would sit IF flattr had cross-service writes

  ┌─ Client / backend (you own) ──────────────────────────────────┐
  │  today: single READ calls, each standalone (03)               │
  │  ★ NO multi-step write workflow exists ★                      │ ← not yet
  └───────────────────────┬───────────────────────────────────────┘   exercised
                          │  HTTP
                          ▼
  ┌─ multiple services flattr DOES NOT HAVE ─────────────────────┐
  │  step 1: reserve  →  step 2: charge  →  step 3: notify        │
  │  if step 2 fails: COMPENSATE step 1 (the saga)               │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concepts are the **saga** (a sequence of local transactions, each with
a **compensating** action that undoes it), the **transactional outbox** (commit a
local DB write and a "publish this event" record in the *same* transaction, so the
event can't be lost), and **reconciliation** (a sweeper that finds and fixes
half-finished workflows). flattr exercises none because it has no multi-step
cross-service write.

## The structure pass

**Layers (hypothetical, the day flattr grows a write workflow).** Three: the
workflow (the ordered steps), the durability (how an intent to do step N survives a
crash), and the recovery (how a stuck workflow gets unstuck).

**Axis — trace `what happens if this step fails halfway?` across the layers.**

```
  One axis — "step fails halfway — what un-does the damage?" — across the layers

  ┌─ a single DB transaction ───────────┐
  │ failure → automatic ROLLBACK         │  → the DB un-does it for you (free)
  └──────────────────┬───────────────────┘
                     │  cross a service boundary ↓ (the answer flips)
  ┌─ multi-service workflow (a saga) ───┐
  │ failure → NO automatic rollback;     │  → YOU write a compensating action
  │ you run compensation by hand         │     for every step (undo the reserve)
  └──────────────────┬───────────────────┘
                     │  add a crash mid-workflow ↓
  ┌─ outbox + reconciliation ───────────┐
  │ failure → the intent survived (outbox)│  → a sweeper resumes/compensates
  │ a sweeper finishes or undoes it      │     the stuck workflow
  └───────────────────────────────────────┘
```

The flip is the whole lesson: a database gives you rollback for free *within* one
store; the instant a workflow crosses a service boundary, rollback becomes *your*
code (compensation), durability becomes *your* problem (outbox), and recovery
becomes *your* sweeper (reconciliation). flattr never crosses that boundary with a
write, so it owes none of this.

**Seam.** The seam that *would* matter is the commit boundary of step N — the gap
between "I committed my local write" and "I told the next service to do its part."
A crash in that gap is the bug the outbox pattern exists to close.

## How it works

### Move 1 — the mental model: local transactions + undo steps

A saga replaces one impossible distributed transaction with a *chain* of local
ones, each paired with a compensating action that semantically undoes it. You don't
get atomicity; you get **eventual consistency with explicit rollback logic**.

```
  The pattern — a saga is forward steps + compensating steps

  forward:   reserve ──► charge ──► notify
                │           │ FAILS
                │           ▼
  compensate:  └──◄── refund/release ◄── (run compensations in REVERSE)

  each forward step Tn has a compensation Cn that undoes it.
  fail at step k → run Ck-1, Ck-2, … C1 in reverse → system back to consistent.
  note: compensation is SEMANTIC undo (refund), not a rollback —
        the charge happened and is visible; you reverse its effect.
```

The kernel parts, named by what breaks without each:

- **the compensating action per step** — drop it and a mid-workflow failure leaves
  a permanent half-done state (money reserved, never charged or released). This is
  the load-bearing part.
- **the ordering / state tracking** — drop it and you can't know *which* steps ran,
  so you can't know which to compensate.
- **idempotent steps** — drop it and a retried saga step double-applies (`03`'s
  problem returns: compensation and forward steps must both be safe to re-run).

### Move 2 — outbox, reconciliation, and flattr's non-example

**The transactional outbox — closing the dual-write gap.** The classic bug: you
commit a row to your DB, then publish an event to a queue — two separate writes. If
you crash *between* them, the row exists but the event is lost forever. The outbox
fixes this by writing the event *into your own database, in the same transaction* as
the business row:

```
  The pattern — outbox makes "DB write + event publish" atomic

  ┌─ ONE local transaction ─────────────────┐
  │  INSERT order row                        │   both commit together
  │  INSERT outbox row ("OrderPlaced event") │   or both roll back — no gap
  └────────────────────┬─────────────────────┘
                       │ a separate poller reads the outbox AFTER commit
                       ▼
                publish "OrderPlaced" → queue   (at-least-once → needs idempotency, 03)
                then mark the outbox row done

  drop the outbox → dual write → crash between the two → event lost, order silently
                    never processed (the bug)
```

**Reconciliation — the sweeper that finishes stuck work.** Sagas and outboxes still
leave workflows that got stuck (a step's service was down). Reconciliation is a
periodic sweep that finds workflows in a non-terminal state past their deadline and
either resumes them or compensates them. It's the safety net under at-least-once
delivery: anything that fell through gets caught on the next sweep.

**flattr's non-example — `buildGraph` is a local pipeline, not a saga.**
`buildGraph` (`build-graph.ts:12-30`) orchestrates ordered steps: parse → split →
sample elevation → compute grades. That *looks* saga-shaped (multi-step,
sequential) but it is not a saga, and the distinction is the lesson:

```
  build-graph.ts:12-30 — multi-step, but NOT a saga

  parseOsm → splitWays → sampleElevations → computeGrades → return Graph
     │           │             │ (the only remote step)        │
     └───────────┴─────────────┴───────────────────────────────┘
  why it's NOT a saga:
   • no cross-service WRITE — it's a pure in-process transform that READS
     once (elevation) and returns a value
   • a mid-pipeline failure needs NO compensation — nothing was committed
     anywhere; the function just throws and the caller keeps last data
     (useTileGraph.ts:219) or exits (run-build.ts:54)
   • no durable intermediate state to reconcile
```

Calling `buildGraph` a saga would be the overclaim the anchoring rules forbid. A
saga is defined by *cross-service writes that must be undone on failure* — `buildGraph`
has neither writes nor a service boundary, so a failure is just a thrown exception,
not a half-committed distributed state. The difference between "a sequence of steps"
and "a saga" is exactly: does a failed middle step leave committed state on another
service that you must explicitly undo?

### Move 2.5 — current vs future: the trigger

```
  Phase A (now)                vs   Phase B (the trigger)
  ─────────────────                ──────────────────────
  every remote call = standalone    a multi-step cross-service WRITE arrives:
  READ (03)                         e.g. "save route" + "charge for premium" +
  buildGraph = local transform      "email confirmation" across 3 services
  failure = throw, keep last data   ↓
  no compensation, no outbox        saga: each step gets a compensating undo
  no reconciliation                 outbox: local commit + event publish atomic
                                    reconciliation: sweep stuck workflows
                                    + every step idempotent (03 becomes mandatory)
```

The trigger from `00`: a **multi-step write that crosses services** — book + pay +
notify, or any workflow where step 2 can fail after step 1 committed somewhere you
can't roll back. The moment that exists, you owe compensation (saga), durable
intent (outbox), and a sweeper (reconciliation) — and `03`'s idempotency stops
being free and becomes mandatory infrastructure.

### Move 3 — the principle

A database transaction gives you all-or-nothing for free, but only *within one
store*. The instant a workflow's writes span services, that guarantee is gone and
you rebuild it by hand: a saga substitutes compensating actions for rollback, an
outbox substitutes a same-transaction event record for the lost dual-write, and
reconciliation substitutes a sweeper for the recovery the DB used to do. flattr owes
none of this because its remote calls are standalone reads — and recognizing that
its multi-step `buildGraph` is a *local transform*, not a saga, is the same skill in
reverse. **A saga is not "a sequence of steps" — it's a sequence of cross-service
writes each carrying its own undo, and you only need it when a failed middle step
leaves committed state somewhere you can't roll back.**

## Primary diagram

What flattr would grow, and the non-example it already has.

```
  saga machinery (not yet exercised) vs flattr's local pipeline (exercised)

  ┌─ A SAGA (Phase B — not here) ─────────────────────────────────┐
  │  reserve ─► charge ─► notify       forward steps               │
  │     ▲          │ FAIL                                          │
  │     └─ release ◄─ refund            compensations (reverse)    │
  │  + outbox (atomic commit+publish) + reconciliation (sweeper)  │
  └────────────────────────────────────────────────────────────────┘

  ┌─ flattr's buildGraph (Phase A — here) ────────────────────────┐
  │  parse ─► split ─► sample ─► grade ─► return    LOCAL transform│
  │  failure = throw (no committed state to undo) → NOT a saga     │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Sagas come from a 1987 paper on long-lived database transactions and became the
backbone of microservice consistency precisely because two-phase commit (the
"proper" distributed transaction) is too slow and too fragile at scale — it blocks
every participant while the coordinator decides, and a coordinator crash can hang
the whole set. The industry traded 2PC's strong atomicity for the saga's eventual
consistency plus explicit compensation, accepting that intermediate states are
*visible* (a charge briefly exists before its refund) in exchange for availability.
The transactional outbox is the companion pattern that makes saga steps reliably
*emit* their events, and it's why `03`'s idempotency becomes non-negotiable in
Phase B: outbox delivery is at-least-once, so every consumer must dedup. flattr
gets to skip the whole chapter today because it never writes across a service
boundary — the cleanest way to avoid saga complexity is to not need a saga.

## Interview defense

**Q: "Does this app have any distributed transactions or sagas?"**
Verdict first: "No — every remote call is a standalone read, so there's no
multi-step write to keep consistent and nothing to compensate. The one multi-step
thing, `buildGraph`, is a local in-process transform, not a saga: a failed step
just throws, because nothing was committed on another service to undo." Then the
trigger: "Sagas arrive the day a write workflow crosses services — say save +
charge + notify. Then each step needs a compensating action, I'd use a
transactional outbox so the local commit and the event publish are atomic, and a
reconciliation sweep for stuck workflows — and idempotency stops being free." Drawing
the line between "a sequence of steps" and "a saga" is the senior signal.

```
  the sketch you draw

  sequence of steps  → just a function (buildGraph) → failure = throw
  SAGA               → cross-service WRITES → each step has a compensating undo
                       + outbox (atomic commit+publish) + reconciliation
```

**Q: "Why a saga instead of a distributed transaction (2PC)?"**
"2PC blocks every participant while the coordinator decides and hangs the whole set
if the coordinator crashes — too slow and fragile at scale. A saga trades strong
atomicity for eventual consistency: each step commits locally and carries a
compensating undo, so failures are recovered by running compensations instead of a
global rollback. The cost is that intermediate states are briefly visible." That
trade — availability over atomicity, visible intermediate state — is the fact
interviewers check.

**Anchor:** *A saga is cross-service writes each carrying its own undo — not just a
sequence of steps. flattr's calls are standalone reads, so it owes no compensation,
no outbox, no reconciliation; `buildGraph` is a local transform, not a saga.*

## See also

- `03` — idempotency: free today, mandatory the day a saga + outbox arrives.
- `04` — eventual consistency is what a saga delivers in place of atomicity.
- `06` — the outbox publishes to a queue flattr doesn't have yet.
- `07` — cross-boundary workflows need the coordination flattr also lacks.
- sibling **database-systems** — local transactions (what you lose at the service
  boundary); sibling **system-design** — workflow orchestration as architecture.
