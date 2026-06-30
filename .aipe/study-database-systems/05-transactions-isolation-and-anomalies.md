# Transactions, isolation, and anomalies

**Industry names:** transaction · atomicity · ACID · isolation level ·
anomaly (dirty/non-repeatable/phantom) — *type label: Industry standard.*

**Status in flattr: not yet exercised.** There is no transactional boundary
anywhere in the repo. This file teaches the mechanism against its absence
and names the exact trigger that would make it relevant.

## Zoom out, then zoom in

A transaction is the promise that **a group of writes happens all-or-nothing
and doesn't interleave badly with other writers.** flattr has neither
property to protect: the graph never writes, and the cache writes one key at
a time with one writer. So there's no transaction. But the *seam* where one
would appear is visible — it's the cache write — and that's worth putting on
the map.

```
  Zoom out — where a transaction WOULD live (but doesn't)

  ┌─ Storage layer ─────────────────────────────────────────────┐
  │                                                             │
  │  in-memory graph   → read-only → no writes → no txn needed  │
  │                                                             │
  │  ★ elevCache write ★  putElev → debounced setItem          │ ← the only
  │     ONE key, ONE writer → "transaction" = one setItem      │   candidate seam
  │     no multi-write atomicity (none needed today)            │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. The reason to study this *now*, before flattr needs it: the moment
the app grows a second piece of persistent state that must stay consistent
with the first — say, a list of saved routes plus an index of them — you
inherit the atomicity problem instantly. Knowing the shape now means you
recognize the trigger when it arrives instead of shipping a half-write bug.

## The structure pass

**Layers.** Two write surfaces, neither transactional: the graph (never
writes) and the cache (one key, one `setItem`).

**Axis — what's the unit of atomicity?** Trace it:

```
  Axis: "what's guaranteed all-or-nothing?"

  ┌─ graph ─────────────────────┐  → nothing writes → N/A
  └─────────────────────────────┘
  ┌─ elevCache.persistNow ──────┐  → ONE setItem of the whole blob
  │  one key overwrite          │     (atomic by the KV store, not by flattr)
  └─────────────────────────────┘
  ┌─ (hypothetical) saved routes┐  → would need MULTI-write atomicity
  │  route row + index entry    │     = the first real transaction
  └─────────────────────────────┘

  the unit is "one key" today; the trigger is "two keys that must agree"
```

**Seam.** The load-bearing boundary is **single-write vs. multi-write
durability**. Below it (one key), atomicity is whatever AsyncStorage gives
you for one `setItem` — effectively atomic, no transaction logic in flattr.
Above it (two keys that must agree), you need a transaction and flattr has no
primitive for one. The seam is currently on the safe side. The trigger moves
it.

## How it works

### Move 1 — the mental model

You know optimistic UI updates: you mutate local state, fire the request,
and roll back if it fails. A transaction is that rollback made a *guarantee*
at the storage layer — either every write in the group lands, or none does,
and a reader never sees the half-done middle. flattr's cache write is the
degenerate case: a group of size one, so "all-or-nothing" is automatic.

```
  The transaction kernel — what every txn is

  BEGIN
    write A   ┐
    write B   │  ← either ALL of these commit…
    write C   ┘
  COMMIT  ────► durable, visible together
     │
     └─ on failure → ROLLBACK → none of A/B/C ever happened

  flattr today: the group is {write the blob} — size 1, trivially atomic
```

### Move 2 — the parts, and where flattr stands on each

**Atomicity — all-or-nothing.** The guarantee that a multi-write group can't
partially apply. flattr's only write is one blob overwrite
(`elevCache.ts:53`, a single `setItem`), so there's no group to make atomic.
What breaks without atomicity, *if* you had two writes: a crash between them
leaves the store inconsistent (route saved, index not updated → orphan).
flattr can't hit this because it never issues two related writes.

**Consistency — invariants hold across the txn.** The data satisfies its
rules before and after. flattr's graph invariants (adjacency matches edges,
grades signed correctly) are enforced at *build time* in `pipeline/`, not at
write time — because there are no runtime writes to violate them. The
invariant is frozen into the artifact.

**Isolation — concurrent txns don't see each other's middle.** flattr is
single-threaded JS (file `06`), and the only writer is the debounced
`persistNow`. Two `persistNow` calls can't truly interleave mid-write
because JS doesn't preempt. So isolation is *free* — there's effectively one
serial writer. The one subtlety: `persistNow` is `async`, and between its
`await setItem` and completion, another `putElev` can mutate `mem`
(`elevCache.ts:35-40`). That's the closest flattr comes to an isolation
concern, and it's benign because `putElev` only *adds* keys and the next
debounce re-persists. (Walked in `06`.)

**Durability — committed writes survive a crash.** Covered in `07`. flattr's
durability is best-effort and debounced, not a committed-means-safe
guarantee.

**The anomalies (the reader people forget).** Isolation levels exist to
trade safety for speed by *permitting* specific anomalies:

```
  The anomaly ladder — what each isolation level permits

  READ UNCOMMITTED  → dirty read     (see another txn's uncommitted write)
  READ COMMITTED    → non-repeatable  (same row, two reads, two values)
  REPEATABLE READ   → phantom         (a range gains/loses rows mid-txn)
  SERIALIZABLE      → (none)          (as if txns ran one at a time)

  flattr permits ALL of them vacuously — there are no concurrent txns
  to produce any anomaly. The ladder is empty because the workload is.
```

flattr sits *above* SERIALIZABLE for free, not because it's careful but
because it has one serial writer and no readers of in-flight writes. Naming
this honestly is the point: flattr isn't solving isolation well, it's
*avoiding* the problem by design.

### Move 2.5 — current vs. future (the trigger)

```
  Phase A (now) — no transaction        Phase B (saved routes ship)
  ┌──────────────────────────────┐      ┌──────────────────────────────┐
  │ one writer (persistNow)      │      │ save route = TWO writes:     │
  │ one key (the cache blob)     │      │   1. route record            │
  │ group size 1 → atomic free   │      │   2. routes-index entry      │
  │ no anomaly possible          │      │ crash between → orphan/drift │
  │ VERDICT: no txn needed       │      │ VERDICT: need atomicity NOW  │
  └──────────────────────────────┘      └──────────────────────────────┘
```

**The trigger is concrete:** the first time flattr persists two pieces of
state that must agree (saved routes + an index of them, or user prefs + a
schema version). At that point you either adopt a store with transactions
(SQLite via `expo-sqlite` gives you `BEGIN/COMMIT`) or you hand-roll
all-or-nothing by writing one combined blob (the cache's current trick,
which scales to "everything in one key" but no further). What *doesn't*
change: the read store. The graph stays immutable and transaction-free
forever.

### Move 3 — the principle

A transaction is **insurance against partial failure across multiple
writes.** You pay for it (locks, logs, latency) only when you have multiple
writes that must agree. flattr has exactly one write, so it correctly pays
nothing. The skill isn't "always use transactions" — it's recognizing the
*instant* your write count crosses from one to two-that-must-agree, because
that's when the insurance stops being optional.

## Primary diagram

```
  flattr's transaction story — empty, by design

  ┌─ READ STORE (graph) ────────────────────────────────────────┐
  │  no writes → no txn → invariants frozen at build time        │
  └─────────────────────────────────────────────────────────────┘
  ┌─ WRITE STORE (elevCache) ───────────────────────────────────┐
  │  ┌─ "transaction" = one setItem ──────────────────────────┐ │
  │  │ persistNow → JSON.stringify(mem) → setItem(key, blob)  │ │
  │  │ group size 1 → atomic (by the KV store)                │ │
  │  │ isolation: free (single serial writer)                 │ │
  │  │ anomalies: none possible (no concurrent txns)          │ │
  │  └─────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────┘
       TRIGGER → second piece of state that must stay consistent
                 → first real BEGIN/COMMIT (reach for expo-sqlite)
```

## Elaborate

ACID was invented for exactly the failure flattr doesn't have: many writers
hitting shared mutable state, where a crash or a bad interleave corrupts
invariants. The reason a read-mostly app like flattr can skip it entirely is
the same reason CRDTs and event logs are popular — *if you never update in
place, you never need a transaction to protect the update.* flattr's graph
is immutable (append-nothing, update-nothing); its cache is
insert-only-then-overwrite. Both dodge the in-place-update that makes
transactions necessary. When you read about isolation levels, anchor them to
this: every level is a different answer to "what may another writer see
mid-update?" — and flattr's answer is "there is no other writer."

## Interview defense

**Q: flattr persists an elevation cache. Does it need transactions?**
No — and naming *why* is the signal. There's exactly one writer
(`persistNow`) and it writes exactly one key (the whole cache blob in one
`setItem`). A transaction protects multi-write atomicity across concurrent
writers; flattr has neither multiple writes-that-must-agree nor concurrent
writers. It sits above SERIALIZABLE for free because the workload is empty,
not because it's careful.

```
  group size 1 + one serial writer → atomicity & isolation are free
```
*Anchor: no transaction because there's no multi-write group and no second
writer — the trigger is the first two-keys-that-must-agree.*

**Q: When would you add transactions, and how?**
The moment two persistent things must stay consistent — saved routes plus an
index, say. A crash between the two writes orphans one. I'd move that state
into `expo-sqlite` and wrap the pair in `BEGIN/COMMIT`, or keep the
cache's trick of writing everything in one key so the group stays size one.
The read store never changes — the graph stays immutable and txn-free.
*Anchor: trigger = two keys that must agree; fix = SQLite BEGIN/COMMIT or
one combined blob.*

## See also

- `06-locks-mvcc-and-concurrency-control.md` — why isolation is free here.
- `07-wal-durability-and-recovery.md` — the durability half of ACID.
- `study-data-modeling` — the schema that a saved-routes feature would add.
