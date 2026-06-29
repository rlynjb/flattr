# Transactions, isolation, and anomalies

**Industry name(s):** ACID transactions / isolation levels / read & write
anomalies · **Type:** Industry standard.

> **Status in flattr: `not yet exercised`.** There is no multi-statement atomic
> unit anywhere in the repo, and no concurrent durable mutation. This file
> teaches the mechanism in full and names the *exact* trigger that would force it
> in — because the day flattr's storage stops being read-only, this is the first
> thing it needs.

## Zoom out, then zoom in

```
  Zoom out — transactions wrap the write path (which flattr barely has)

  ┌─ App layer ──────────────────────────────────────────────┐
  │  graph reads (RO)        elevCache.putElev (the 1 writer) │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Transaction layer ────────▼─────────────────────────────┐
  │  ★ BEGIN … COMMIT / ROLLBACK ★   ← NOT PRESENT in flattr  │ ← we'd be here
  │     (atomicity · isolation · the all-or-nothing boundary) │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  graph.json (RO) · AsyncStorage blob (single-writer)     │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. A transaction is a *boundary that makes a group of operations behave as
one* — all of them happen or none do (atomicity), and concurrent transactions
don't see each other's half-finished work (isolation). flattr needs neither today
because (a) the graph is never written at runtime and (b) the only writer, the
elevCache, is a single in-process writer that re-serializes the whole blob at once
(`02`). So there's nothing to make atomic and no one to isolate from. But that's a
property of flattr's *current* shape, not a law — and the trigger that breaks it
is concrete and named below.

## The structure pass

**Layers** (the ACID guarantees, as nested promises):
1. **Atomicity** — all-or-nothing.
2. **Consistency** — invariants hold across the boundary.
3. **Isolation** — concurrent txns don't interfere.
4. **Durability** — committed = survives a crash (owned by `07`).

**Axis traced — "if this fails halfway, what state are we left in?"**

```
  axis — "what happens on a mid-operation crash?" — flattr vs a txn DB

  ┌─ flattr elevCache write ────────────────┐
  │  setItem is ONE call → whole blob lands  │  atomic by accident (one op)
  │  crash before setItem → lose the batch   │  but no rollback, no partial state
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (the moment a write spans >1 record/store)
  ┌─ a multi-step write (hypothetical) ─────┐
  │  "add node + add its edges + reindex"    │  crash midway → CORRUPT graph
  │  without a txn: partial, inconsistent     │  with a txn: rolled back, clean
  └───────────────────────────────────────────┘
```

The axis-answer is benign today *only because every write is a single operation*.
The elevCache's whole-blob `setItem` is "atomic" the way a single assignment is
atomic — not because anything guarantees it, but because there's no second step to
be caught between. The seam is the moment a write needs **two** steps that must
both land or neither — that's when you need a real transaction, and flattr has no
mechanism for it.

## How it works

### Move 1 — the mental model

You've felt the failure this prevents. Picture a `fetch` that does two PATCHes —
update the user, then update their billing — and the second one fails. Now the
user's changed but billing isn't. Half-applied. A transaction is the wrapper that
says "treat these two PATCHes as one: if the second fails, undo the first." The
database makes that promise for *durable* state, which is far harder than undoing
two HTTP calls.

```
  the pattern — a transaction is an all-or-nothing bracket

  BEGIN
   ├─ write A   ┐
   ├─ write B   ├─ all visible together, or none at all
   └─ write C   ┘
  COMMIT   → A,B,C become durable + visible atomically
  ─────  or  ─────
  ROLLBACK / crash → A,B,C never happened (state == before BEGIN)
```

The bracket is the kernel. Everything else — isolation levels, locks, MVCC — is
about what *other* transactions see *while* this one is mid-bracket.

### Move 2 — isolation levels and the anomalies they stop

Isolation is the dial. Crank it up and concurrent transactions are more separated
but slower; crank it down and they're faster but can see each other's mess. Each
level is defined by *which anomaly it permits*.

```
  isolation levels vs anomalies (SQL standard)

  level              dirty read  non-repeatable  phantom   write skew
  ─────────────────  ──────────  ──────────────  ───────   ──────────
  READ UNCOMMITTED   ALLOWED     allowed         allowed   allowed
  READ COMMITTED     prevented   ALLOWED         allowed   allowed
  REPEATABLE READ    prevented   prevented       allowed*  allowed
  SERIALIZABLE       prevented   prevented       prevented prevented
                                                 (*Postgres MVCC stops phantoms here)
```

**Dirty read** — you read another txn's *uncommitted* write, and it then rolls
back. You acted on data that never existed.

**Non-repeatable read** — you read a row twice in one txn and get different values
because another txn committed an UPDATE in between.

**Phantom** — you run the same `WHERE` twice and the second time new rows match,
because another txn INSERTed.

**Write skew** — two txns each read an overlapping set, each decides independently,
both commit, and together they violate an invariant neither would alone. (Classic:
two doctors each go off-call after checking "someone else is on call" — both see
the other, both leave, nobody's on call.)

**Where flattr would meet these — the concrete trigger.** Today: never (single
writer, single op). The trigger is **multi-device sync writing to a shared
store** — exactly the shape you built in `buffr` (SQLite local + Supabase mirror)
and `dryrun` (GitHub-as-backend). The moment two devices write the same user's
data to one backend, every anomaly above is live:

```
  the trigger — when flattr would need isolation

  Phase A (now):                    Phase B (sync, the trigger):
  ┌─────────────┐                   ┌─────────┐     ┌─────────┐
  │ one device  │                   │ phone A │     │ phone B │
  │ one writer  │                   └────┬────┘     └────┬────┘
  │ no shared   │                        │  shared store  │
  │ durable     │                        ▼               ▼
  │ mutation    │                   ┌───────────────────────┐
  └─────────────┘                   │ writes interleave →    │
   NO anomalies                     │ dirty/lost/skew NOW    │
   possible                         │ live → need isolation  │
                                    └───────────────────────┘
```

**The one near-miss flattr has today.** The elevCache's read-modify-write has a
*lost-update shape* even single-process. `putElev` (`elevCache.ts:35`) checks
`mem.has(key)` then sets — but two concurrent `cachedElevation.sample` calls
(`useTileGraph.ts` runs one build at a time via `busyRef`, so this is *currently*
serialized) could both miss the same cell and both fetch+put. **Inference:** the
`busyRef` single-flight in `useTileGraph.ts:113` is what *prevents* this — it's a
hand-rolled mutual exclusion standing in for the isolation a transaction would
give. Remove the single-flight and you'd get duplicate elevation fetches (wasted
API calls, the exact throttling the cache exists to avoid). So flattr *does* lean
on an isolation-like guarantee — it just enforces it with an application-level
lock, not a transaction. `06` walks that lock.

### Move 2.5 — current vs future

```
  Phase A: no transactions          Phase B: real txns (post-sync / post-Postgres)

  writes: single-op, single-writer  writes: multi-row, multi-writer
  atomicity: accidental (1 op)      atomicity: BEGIN…COMMIT bracket
  isolation: app-level single-flight isolation: a chosen level (likely READ
             (busyRef)                          COMMITTED for an app like this)
  anomalies: impossible             anomalies: possible → level must be chosen
  what carries over: the graph stays read-only; only the sync/user-data path
                     needs txns. The routing engine never does.
```

The cheap insight: even after migration, flattr's *read-only graph* never needs a
transaction. Only a future *writable user-data* path (saved routes, sync) does.
Knowing which data is mutable is what tells you where transactions belong.

### Move 3 — the principle

A transaction trades throughput for the ability to *reason about partial failure
as if it can't happen.* You pick an isolation level by naming the cheapest anomaly
you can tolerate, not the strongest guarantee you can buy — SERIALIZABLE is
correct and slow; most apps run READ COMMITTED and handle the rest in application
logic. flattr needs none of this today, but recognizing *why* (single writer, no
shared durable mutation) is exactly the recognition that tells you the instant a
sync feature flips the switch.

## Primary diagram

```
  the transaction bracket and the anomaly ladder — what flattr would adopt

  ┌─ a write transaction ────────────────────────────────────────┐
  │  BEGIN ─► write ─► write ─► (COMMIT durable+atomic | ROLLBACK)│
  └──────────────────────────────┬────────────────────────────────┘
              isolation level decides what CONCURRENT txns see:
  ┌──────────────────────────────▼────────────────────────────────┐
  │ READ UNCOMMITTED → dirty reads                                 │
  │ READ COMMITTED   → non-repeatable reads        ← typical app   │
  │ REPEATABLE READ  → phantoms (mostly)                           │
  │ SERIALIZABLE     → nothing; full isolation, slowest            │
  └────────────────────────────────────────────────────────────────┘
   flattr today: none of this. Trigger = multi-device sync to a shared store.
   flattr's stand-in today: busyRef single-flight in useTileGraph (see 06).
```

## Elaborate

ACID is the relational contract; the NoSQL wave traded pieces of it for scale
(eventual consistency, `08`'s territory) and the industry has been clawing back
toward "ACID where it matters" ever since (Spanner, CockroachDB, FaunaDB offer
serializable distributed transactions). The deepest practical lesson is that
**isolation level is a per-transaction *choice*, not a database-wide setting** —
you pay for SERIALIZABLE only on the transactions that need it. Your `AdvntrCue`
Postgres instance defaults to READ COMMITTED; its session-memory writes
(`MemoRAG`) are exactly the kind of single-row write that's safe there.

The anomaly that catches senior engineers off guard is **write skew**, because
each transaction individually looks correct — it's only the *combination* that
breaks an invariant, and only SERIALIZABLE (or an explicit lock) stops it. If
flattr ever adds "max N saved routes per free user" enforced by read-then-insert,
that's a write-skew waiting to happen under concurrent inserts.

## Interview defense

**Q: "Does flattr use transactions?"**

> No — and it doesn't need them yet. The graph is read-only, and the only writer,
> the elevCache, does single-operation whole-blob writes, so there's nothing to
> make atomic and no concurrent writer to isolate from. The trigger that would
> force transactions in is multi-device sync to a shared store — the `buffr`/
> `dryrun` shape — where interleaved writes make dirty reads, lost updates, and
> write skew suddenly possible.

```
  now: single writer, single op → atomic by accident
  trigger: shared store + 2 writers → anomalies live → need BEGIN…COMMIT
```

Anchor: *flattr is transaction-free because it has no shared durable mutation;
sync is the exact feature that ends that.*

**Q: "How would you pick an isolation level for flattr-with-sync?"**

> Name the cheapest anomaly I can tolerate, not the strongest guarantee. For
> saved-route sync, READ COMMITTED is almost certainly enough — last-write-wins on
> a route is acceptable. I'd only reach for SERIALIZABLE on an invariant-enforcing
> write like a per-user quota, where write skew is real. Default low, escalate per
> transaction.

Anchor: *isolation level is a per-transaction choice keyed to the anomaly you
can't tolerate — escalate, don't default high.*

## See also

- `06-locks-mvcc-and-concurrency-control.md` — how isolation is *enforced*; the busyRef lock
- `07-wal-durability-and-recovery.md` — the D in ACID; the elevCache durability gap
- `08-replication-and-read-consistency.md` — anomalies across replicas
- `../study-system-design/` — the sync architecture that triggers all this
- `../study-distributed-systems/` — multi-writer coordination under partial failure
