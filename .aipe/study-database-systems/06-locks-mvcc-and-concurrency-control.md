# Locks, MVCC, and concurrency control

**Industry names:** lock (shared/exclusive) · pessimistic vs. optimistic
concurrency · MVCC · two-phase locking · write-skew — *type label: Industry
standard.*

**Status in flattr: not yet exercised.** There are no locks, no MVCC, no
version counters. flattr's concurrency control is *the JavaScript event
loop* — one thread, no preemption. This file teaches the mechanisms and
shows precisely why the single-threaded runtime hands flattr most of them
for free, plus the one real (benign) race that does exist.

## Zoom out, then zoom in

Concurrency control is the machinery that keeps **two writers from corrupting
shared state when they overlap.** flattr's overlap surface is almost zero:
the graph is read-only (infinite concurrent readers, no writers — the easy
case), and the cache has one logical writer. The event loop serializes
everything. So flattr replaces locks with "there's only one thread."

```
  Zoom out — the concurrency surface

  ┌─ Runtime (single-threaded JS event loop) ───────────────────┐
  │                                                             │
  │  graph reads   → many "concurrent" reads, ZERO writers      │
  │                  → no lock needed (immutable)               │
  │                                                             │
  │  ★ elevCache  ★ → putElev (sync) + persistNow (async)      │ ← the only
  │     one logical writer, serialized by the event loop        │   place to look
  │     ONE async gap (await setItem) = the only "race"         │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in. A lock answers "who may touch this row right now?" MVCC answers
"can readers proceed without waiting for writers?" Both solve problems born
of *true parallelism* — multiple threads or processes hitting the same byte
at the same instant. JavaScript has no true parallelism in this code (no
workers touching `mem`), so the problems mostly don't exist. The job here is
to know the mechanisms cold *and* to honestly locate the one cooperative-
scheduling race flattr does have.

## The structure pass

**Layers.** Two access patterns: read-only graph access (trivially safe) and
read-modify-write on the cache `Map` (the only mutable shared state).

**Axis — what serializes access here?** Trace it:

```
  Axis: "what prevents a corrupting interleave?"

  ┌─ graph reads ───────────────┐  → IMMUTABILITY (nothing to corrupt)
  └─────────────────────────────┘
  ┌─ putElev (sync) ────────────┐  → THE EVENT LOOP (runs to completion,
  │  mem.set + schedule timer   │     no preemption mid-function)
  └─────────────────────────────┘
  ┌─ persistNow (async) ────────┐  → the event loop UNTIL `await`, then a
  │  await setItem(blob)        │     yield point where mem can change
  └─────────────────────────────┘

  immutability, then cooperative scheduling, then one yield gap
```

**Seam.** The load-bearing boundary is **sync vs. async**. Synchronous code
(`putElev`, `getElev`) is uninterruptible — the event loop runs each to
completion, which is an implicit exclusive lock. The async `await setItem`
inside `persistNow` is the *one* place control yields, so it's the only
boundary where flattr's "lock" releases mid-operation. That seam is the only
concurrency subtlety in the whole repo.

## How it works

### Move 1 — the mental model

You already rely on this every day: in React, a synchronous event handler
runs to completion before any other handler — you never worry that two
`onClick`s interleave mid-function, because JS doesn't preempt. That run-to-
completion guarantee *is* an exclusive lock you didn't have to ask for.
Concurrency control in a database is what you'd need if that guarantee
*didn't* hold — if two threads could be halfway through `mem.set` at once.

```
  The concurrency-control kernel — pick one

  PESSIMISTIC (locks)              OPTIMISTIC (MVCC / version check)
  ┌──────────────────────┐         ┌──────────────────────────────┐
  │ acquire lock         │         │ read row + its version       │
  │ read-modify-write    │         │ compute new value            │
  │ release lock         │         │ write IF version unchanged   │
  │ others WAIT          │         │   else retry (others proceed)│
  └──────────────────────┘         └──────────────────────────────┘
   block to avoid conflict          assume no conflict, detect+retry

  flattr uses NEITHER — the event loop is the lock
```

### Move 2 — the mechanisms, and flattr's stance on each

**Pessimistic locking — block until it's safe.** A writer takes an exclusive
lock on a row; everyone else waits. What breaks without it under true
parallelism: two writers read the same value, both increment, one update is
lost (the lost-update anomaly). flattr never takes a lock because the event
loop already serializes the read-modify-write in `putElev`:

```ts
// features/routing/../mobile/src/elevCache.ts:35-40 — uninterruptible RMW
export function putElev(key: string, value: number): void {
  if (mem.has(key)) return;          // ┐ this whole function runs to
  mem.set(key, value);               // │ completion with NO yield point —
  dirty = true;                      // │ no await → the event loop can't
  if (!persistTimer)                 // │ interleave another putElev here
    persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS); // ┘
}
```

There's no `await` in `putElev`, so it's atomic by construction. That's a
free exclusive lock on `mem` for the duration of the function. Lost updates
are impossible here.

**Optimistic concurrency / MVCC — let readers run, version the writes.**
MVCC keeps multiple versions of a row so readers see a consistent snapshot
while a writer prepares the next version — readers never block writers.
flattr has nothing like this because it has no concurrent readers-of-writes:
the cache is read by the same single thread that writes it. The closest
flattr gets to a version is the *key* `"flattr.elevCache.v1"` — a schema
version, not a row version (`elevCache.ts:7`). What would force MVCC: a
background worker reading the cache while the main thread rewrites it — which
flattr doesn't do.

**The one real race — the async persist gap.** Here's the honest finding.
`persistNow` is `async` and yields at `await setItem`:

```ts
// mobile/src/elevCache.ts:42-57 — the only yield point in the write path
async function persistNow(): Promise<void> {
  persistTimer = null;
  if (!dirty) return;
  dirty = false;                                  // ← cleared BEFORE the await
  try {
    let entries = [...mem.entries()];             // snapshot of mem
    // … cap to MAX_ENTRIES …
    await AsyncStorage.setItem(STORAGE_KEY,        // ← YIELD: control returns to
      JSON.stringify(Object.fromEntries(entries)));//   the event loop here
  } catch {
    dirty = true;                                  // failed → mark for retry
  }
}
```

Trace the interleave at the `await`:

```
  Execution trace — putElev during an in-flight persist

  time  event                              dirty  mem        persisting?
  ────  ─────────────────────────────────  ─────  ─────────  ───────────
  t0    persistNow: dirty=false            false  {a,b}      yes (await)
  t1    putElev("c") runs (sync)           TRUE   {a,b,c}    yes
  t2    setItem(blob of {a,b}) resolves    true   {a,b,c}    no
  t3    no timer pending? putElev set one  true   {a,b,c}    scheduled
  t4    next persistNow writes {a,b,c}     false  {a,b,c}    yes
  ────────────────────────────────────────────────────────────────────
  outcome: "c" is durable after the NEXT debounce — never lost
```

The snapshot `[...mem.entries()]` is taken *before* the await, so the
in-flight write persists the old set, but `putElev` re-set `dirty = true` and
scheduled another flush — so `"c"` lands on the next cycle. **No entry is
lost; durability is just delayed by one debounce.** This is the entire
concurrency story of flattr, and it's benign by construction. The reason it's
safe: `mem` only ever *grows* (`putElev` no-ops on existing keys,
`elevCache.ts:36`), so a stale snapshot can only miss new keys, never
corrupt old ones.

**Two-phase locking, deadlock, write-skew — none present.** flattr never
holds two locks (it holds zero), so there's no lock-ordering, no deadlock, no
write-skew. Naming their absence is correct: these are problems of multiple
locks under true parallelism, and flattr has neither.

### Move 2.5 — current vs. future (the trigger)

```
  Phase A (now)                        Phase B (true parallelism arrives)
  ┌──────────────────────────────┐     ┌──────────────────────────────┐
  │ one JS thread, no workers     │     │ a Worklet / native thread     │
  │ event loop = implicit lock    │     │ touching the same store       │
  │ async gap is benign (mem grows│     │ → real data race on mem       │
  │   only)                       │     │ → need a lock or atomic store │
  │ VERDICT: nothing to add       │     │ VERDICT: lock or move to SQLite│
  └──────────────────────────────┘     └──────────────────────────────┘
```

**The trigger:** the first piece of state written from *two* JS execution
contexts at once — a `react-native-worklets` worklet (which `contrl` uses for
the vision pipeline) writing a shared store, or two processes via a shared
SQLite file. At that point the event-loop "lock" no longer covers both
writers and you need a real one. What *doesn't* change: graph reads stay
lock-free forever because the graph is immutable.

### Move 3 — the principle

Concurrency control is only necessary when **two writers can be mid-operation
on the same state at the same instant.** Single-threaded cooperative
scheduling eliminates that for synchronous code — run-to-completion is a free
exclusive lock — and immutability eliminates it for reads. flattr leans on
both. The skill is spotting the *yield points* (`await`) where the free lock
releases, and proving what can change across them. flattr has exactly one,
and it's safe because the only mutation is append.

## Primary diagram

```
  flattr's concurrency control — the event loop is the lock

  ┌─ graph (immutable) ─────────────────────────────────────────┐
  │  many concurrent reads, zero writers → no lock needed        │
  └─────────────────────────────────────────────────────────────┘
  ┌─ elevCache mem (Map) — the only mutable shared state ───────┐
  │                                                             │
  │  putElev (SYNC)  ────────────► runs to completion           │
  │    = implicit exclusive lock (no await, no interleave)      │
  │                                                             │
  │  persistNow (ASYNC) ─── await setItem ──► YIELD POINT       │
  │    │                                       │                │
  │    └─ snapshot taken BEFORE yield          └─ mem may grow  │
  │       (so stale snapshot only MISSES new keys, never loses) │
  │    dirty re-set by putElev → re-persisted next debounce     │
  └─────────────────────────────────────────────────────────────┘
       TRIGGER → a worklet/process writes mem too → real race → lock
```

## Elaborate

MVCC (Postgres's default, via row versions + visibility rules) and 2PL
(SQL Server's classic) are two answers to the same question: how do readers
and writers coexist without one blocking the other into a stall. flattr
sidesteps the question because its readers and writers are the same single
thread — there's nothing to coordinate. This is the same reason
single-threaded Redis needs no locks: serialize everything through one
executor and concurrency control collapses into ordering. The lesson that
transfers: before reaching for a lock, ask whether you can serialize the
writers instead — a single-writer design deletes the entire problem class,
which is exactly what flattr (and Redis, and an event-sourced log) do.

## Interview defense

**Q: flattr writes a cache from an async function. Is there a race?**
There's one yield point — `await setItem` in `persistNow`
(`elevCache.ts:51`) — and it's benign. The snapshot of `mem` is taken before
the await, so an in-flight persist writes the old set; but `putElev` running
during the await re-sets `dirty` and schedules another flush, so the new key
lands one debounce later. It's safe specifically because `mem` only grows
(`putElev` no-ops on existing keys), so a stale snapshot misses new entries
but never corrupts old ones. No lock needed.

```
  await setItem = the only yield; mem grows-only ⇒ stale snapshot is safe
```
*Anchor: one yield point, append-only mem — the race exists but loses
nothing.*

**Q: Why no locks or MVCC anywhere?**
Because there's no true parallelism on shared mutable state. Graph reads are
lock-free by immutability; the cache has one logical writer serialized by the
event loop, which gives synchronous code a free exclusive lock
(run-to-completion). Locks and MVCC solve problems born of two writers
mid-operation at the same instant — flattr never has that until a worklet or
second process touches the same store.
*Anchor: the event loop IS the lock; immutability covers the reads; locks
arrive with true parallelism.*

## See also

- `05-transactions-isolation-and-anomalies.md` — isolation, the sibling
  guarantee.
- `07-wal-durability-and-recovery.md` — what the persist actually guarantees.
- `study-runtime-systems` — the event loop as the execution model.
