# Locks, MVCC, and concurrency control

**Industry name(s):** concurrency control / two-phase locking / MVCC /
optimistic vs pessimistic locking · **Type:** Industry standard.

> **Status in flattr: mostly `not yet exercised` — with one real, hand-rolled
> exception.** flattr has no database lock manager and no MVCC. But it *does* have
> an application-level mutual-exclusion lock (`busyRef` in `useTileGraph.ts`)
> standing in for the concurrency control a database would otherwise provide. This
> file teaches the database mechanisms and anchors them to that one real lock.

## Zoom out, then zoom in

```
  Zoom out — concurrency control guards the write path

  ┌─ App layer (mobile/) ────────────────────────────────────┐
  │  pan/route events fire concurrently → graph builds        │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Concurrency-control layer ▼─────────────────────────────┐
  │  ★ busyRef single-flight (REAL) ★                         │ ← we are here
  │  ✗ DB locks / MVCC version chains  (not present)          │
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  elevCache Map + AsyncStorage · merged graph (RAM)       │
  └───────────────────────────────────────────────────────────┘
```

Zoom in. Concurrency control is the mechanism that *enforces* the isolation `05`
promised — it's the "how" behind "concurrent transactions don't see each other's
mess." Two families do it: **locks** (block conflicting access — pessimistic) and
**MVCC** (let everyone read an old version, version writes — optimistic-ish).
flattr has no transactions to isolate, but it *does* have a concurrency problem in
the graph-build pipeline, and it solves it with the simplest tool in the family: a
single-flight lock. Read that lock and you understand the whole family in
miniature.

## The structure pass

**Layers** (by what's being guarded):
1. **The DB lock manager** — `not present`.
2. **The MVCC version store** — `not present`.
3. **The app-level lock** — `busyRef` (`useTileGraph.ts:113`), a boolean
   mutex serializing graph builds. **Real.**
4. **The implicit single-thread** — JS's event loop, which gives flattr a *lot*
   of concurrency safety for free.

**Axis traced — "what stops two operations from clobbering each other?"**

```
  axis — "what enforces mutual exclusion?" — across the layers

  ┌─ Postgres (reference) ──────────────────┐
  │  row locks + MVCC snapshots              │  engine-managed, per row
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (flattr has neither)
  ┌─ flattr graph build ───▼─────────────────┐
  │  busyRef boolean: "a build is running"    │  hand-rolled, whole-pipeline mutex
  └────────────────────┬─────────────────────┘
       seam ═══════════╪═══════  (below the lock, single-threaded)
  ┌─ flattr elevCache put ─▼─────────────────┐
  │  JS event loop: no true parallelism       │  no two puts run AT THE SAME instant
  └───────────────────────────────────────────┘
```

The axis-answer flips at two seams. flattr leans on the *bottom* seam hard: JS is
single-threaded, so within one synchronous block nothing else runs — `putElev`'s
check-then-set can't be torn by a parallel thread. The middle seam (`busyRef`) is
where flattr *adds* exclusion the runtime doesn't give it: across `await` points,
the event loop *can* interleave, so two async builds could overlap — `busyRef`
prevents that. That single boolean is flattr's entire lock manager.

## How it works

### Move 1 — the mental model

You know `await` yields. The instant you `await fetch(...)`, the event loop is
free to run *other* code — including a second copy of the same function triggered
by another tap. That's the only concurrency JS gives you, and it's enough to cause
a lost update if two copies read-modify-write the same state across an await. A
lock is the wall that says "second copy, wait your turn."

```
  the pattern — two concurrency-control strategies

  PESSIMISTIC (lock first):           OPTIMISTIC (check at commit):
  acquire lock ─► read ─► write       read (note version) ─► write ─► 
  ─► release                          commit IF version unchanged
       ▲ blocks others up front            ▲ no blocking; retry on conflict
  good when conflicts are common      good when conflicts are rare
```

flattr's `busyRef` is pessimistic single-flight: grab the flag, do the whole
build, release. MVCC (Postgres's default) is the optimistic-ish opposite — readers
never block writers because each sees a consistent *snapshot*.

### Move 2 — the mechanisms, one at a time

**flattr's real lock: `busyRef` single-flight.** The whole concurrency-control
story flattr actually ships:

```ts
// mobile/src/useTileGraph.ts:113, 166-227 — the hand-rolled mutex
const busyRef = useRef(false);                 // line 113: the "lock"
const pump = useCallback(() => {
  if (busyRef.current) return;                 // line 167: LOCK HELD → bail (don't start)
  // …pick corridor or view request…
  busyRef.current = true;                      // line 182: ACQUIRE
  (async () => {
    try { /* fetchOverpass + buildGraph (spans awaits) */ }
    finally {
      busyRef.current = false;                 // line 222: RELEASE
      pump();                                   // line 224: hand off to the next waiter
    }
  })();
}, []);
```

Line 167 is `tryLock` — if a build is running, the new request doesn't queue up a
parallel build, it just returns (the request was already stashed in
`pendingViewRef`/`pendingCorridorRef`, so it's not lost). Line 182 acquires, line
222 releases in `finally` (so a thrown error still unlocks — the bug that *not*
using `finally` would cause: a permanently stuck lock). Line 224 is the **fairness
mechanism**: on release, immediately `pump()` the next pending request, with the
corridor (route) prioritized over the viewport (pan). That's a tiny scheduler.

```
  busyRef as a lock + queue (one build at a time)

  tap/pan ──► pendingViewRef    ─┐
  route   ──► pendingCorridorRef ─┤
                                  ▼
                         ┌─ pump() ──────────────┐
                         │ if busyRef: return     │  ← lock check
                         │ else acquire, build,   │
                         │      release, pump next │  ← corridor first
                         └────────────────────────┘
   guarantees: exactly ONE build in flight; never two overlapping
   what it buys: no duplicate elevation fetches → stays under API throttle
```

What breaks without it: two builds for overlapping regions run at once, both miss
the same elevation cells, both hit the throttled Open-Meteo API — defeating the
cache's entire purpose (`useTileGraph.ts:6-7` comment says this explicitly: "One
network build runs at a time… to stay under the free rate limits"). The lock isn't
about data corruption here; it's about *not duplicating expensive work* — which is
one of the two classic reasons to lock.

**The lost-update flattr avoids by single-threading.** `putElev`
(`elevCache.ts:35-40`) is a read-modify-write: check `mem.has(key)`, then `mem.set`
+ flip `dirty`. In a multithreaded language this is a textbook race (two threads
both see "absent," both set, both schedule a persist). In JS it's safe because the
whole function is synchronous — no `await` inside it — so the event loop can't
interleave another `putElev` between the check and the set. **Inference:** flattr
relies on JS's single-threaded execution as an implicit lock here; it's correct,
but it's correct *by accident of the runtime*, not by a chosen mechanism. Move
`putElev` to a worker thread (Web Worker / Worklet — and note `contrl` in your
portfolio uses Worklets) and the race returns.

**Database locks (the reference flattr lacks).** A real engine guards *rows*, not
the whole pipeline. **Two-phase locking (2PL)**: a transaction acquires locks as
it touches rows (growing phase), holds them, and releases all at commit
(shrinking phase) — never re-acquiring after the first release. That ordering is
what makes serializability provable.

```
  2PL — the lock lifecycle a real DB uses (flattr has none)

  growing phase            shrinking phase
  acquire ─ acquire ─ acquire │ release ─ release ─ release
  ───────────────────────────┘ (no acquire after first release)
       ▲ this discipline is what guarantees serializable schedules
```

The cost: locks block, and blocking creates **deadlock** — txn A holds row 1 and
wants row 2, txn B holds row 2 and wants row 1. Real engines detect the cycle and
abort one. flattr's single lock can't deadlock (one lock, no cycle possible) —
which is the upside of the dead-simple design.

**MVCC (the reference flattr lacks).** Postgres's default. Instead of readers
locking, every row carries version metadata (`xmin`/`xmax` — the txn that created
and the txn that deleted it). A reader gets a *snapshot*: it sees the versions
committed as of when its transaction started, ignoring newer ones. So **readers
never block writers and writers never block readers** — only writer-writer
conflicts on the same row need resolution.

```
  MVCC — readers see a snapshot, writers append versions (flattr has none)

  row "x":  v1 (xmin=10) ──► v2 (xmin=20) ──► v3 (xmin=30)
  reader started at txn 25 → SEES v2 (latest committed ≤ 25), ignores v3
  writer creating v3 → does NOT block the reader on v2
       ▲ the cost: dead versions pile up → VACUUM must reclaim them
```

Interesting flattr parallel: the **graph itself is naturally MVCC-ish.** Because
`graph.json` is immutable, every reader sees the same consistent snapshot forever
— no versioning needed because nothing ever creates a v2. flattr gets MVCC's
"readers see a stable snapshot" guarantee *for free* by making the data read-only.
That's the deepest point in this file: **immutability is the cheapest concurrency
control there is.** No lock, no version chain, no vacuum — just never mutate.

### Move 2.5 — current vs future

```
  Phase A (now)                      Phase B (writable / sync)

  graph: immutable → free MVCC       graph user-data: mutable → real CC needed
  builds: busyRef single-flight      writes: row locks OR MVCC snapshots
  elevCache: JS single-thread safe   shared store: actual lock manager
  deadlock: impossible (1 lock)      deadlock: possible → detection needed
  carries over: the routing graph STAYS immutable; only new mutable data
                (saved routes, sync) needs locks/MVCC.
```

### Move 3 — the principle

Concurrency control is the cost you pay to let multiple writers share state safely
— and the cheapest version is to *not share mutable state at all.* flattr does
exactly that for its main dataset (immutable graph = free snapshot isolation) and
uses the smallest possible real lock (one boolean, single-flight) only where it
genuinely has overlapping async work. When you read any system, find the mutable
shared state first — that's the only place concurrency control can possibly be
needed, and if there isn't any, the absence of locks is correct, not a gap.

## Primary diagram

```
  flattr's concurrency control — real lock, free snapshot, missing engine CC

  ┌─ REAL: busyRef single-flight (useTileGraph.ts:113) ──────────┐
  │  pending requests ─► pump(): tryLock → build → unlock → next │
  │  guarantees ONE build in flight; corridor prioritized        │
  │  buys: no duplicate elevation fetches (under API throttle)   │
  └───────────────────────────────────────────────────────────────┘
  ┌─ FREE: immutable graph = snapshot isolation ─────────────────┐
  │  graph.json never mutated → every reader sees one stable view │
  │  no lock, no version chain, no vacuum needed                  │
  └───────────────────────────────────────────────────────────────┘
  ┌─ MISSING (not yet exercised): engine concurrency control ────┐
  │  ✗ 2PL row locks   ✗ MVCC version chains   ✗ deadlock detect │
  │  trigger: a writable, shared, multi-writer store (sync)      │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The lock-vs-MVCC split is the central tradeoff in concurrency control. Pure 2PL
(SQL Server's default historically) gives strong guarantees but readers and
writers block each other, killing read throughput. MVCC (Postgres, Oracle, MySQL
InnoDB) decouples them at the cost of version bloat and a vacuum process to reclaim
dead rows. Most modern engines are MVCC because read-heavy workloads dominate —
and flattr's workload is the read-heavy extreme, which is exactly why its
"immutable data = free MVCC" instinct is the right one.

Optimistic concurrency (read a version number, write only if it hasn't changed,
retry on conflict) is the other lever — it's what you'd reach for in flattr-with-
sync if conflicts are rare: each saved-route write carries a version, and a
conflicting concurrent write triggers a client-side merge/retry rather than a
server-side lock. It's the same pattern as an HTTP `If-Match` / ETag, which you've
almost certainly used — optimistic concurrency *is* ETags for the database.

## Interview defense

**Q: "Does flattr do any concurrency control?"**

> One real piece: `busyRef` in `useTileGraph.ts` is a single-flight lock that
> serializes graph builds so two overlapping async builds can't both hammer the
> throttled elevation API. It acquires before the build, releases in `finally`,
> and pumps the next pending request (corridor before viewport). Beyond that,
> flattr leans on two free guarantees: JS's single thread protects the elevCache's
> read-modify-write, and the immutable graph gives every reader a stable snapshot
> with no locking at all.

```
  busyRef: tryLock → build → finally release → pump next (one at a time)
  immutable graph: free snapshot isolation (never mutated → no v2)
```

Anchor: *immutability is the cheapest concurrency control — flattr's main dataset
needs no locks because it's never written.*

**Q: "What's the load-bearing part of that lock people forget?"**

> Releasing in `finally`. The lock is set true before an async build that can
> throw (Overpass 429, offline). If release weren't in `finally`, a thrown error
> would leave `busyRef` stuck true forever and no build would ever run again —
> a permanent deadlock from a single dropped exception. `useTileGraph.ts:222`
> puts it in `finally` exactly so a failed build still unlocks.

Anchor: *a lock's release must be exception-safe or one error wedges the whole
system — the `finally` is the part that makes the mutex correct.*

## See also

- `05-transactions-isolation-and-anomalies.md` — the isolation this enforces
- `07-wal-durability-and-recovery.md` — durability of the writes this guards
- `02-records-pages-and-storage-layout.md` — the elevCache read-modify-write
- `../study-runtime-systems/` — the JS event loop and single-flight pattern
- `../study-distributed-systems/` — optimistic concurrency / version vectors at scale
