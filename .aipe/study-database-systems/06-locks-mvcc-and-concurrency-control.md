# Locks, MVCC, and concurrency control

**Industry name(s):** locking / MVCC / optimistic vs pessimistic concurrency ·
**Type:** Industry standard — **`not yet exercised` in this repo.** The store is
immutable and read-only at runtime, so there are no writers to coordinate.

## Zoom out, then zoom in

Verdict first: **flattr has no concurrency control because it has no concurrent
writes.** Locks and MVCC exist to let many transactions read and write the same
data without corrupting it or seeing each other's half-done work. flattr's
runtime data is immutable and read-only — every reader sees the identical
unchanging snapshot — so there is nothing to lock and no versions to manage.

```
  Zoom out — where concurrency control WOULD live (it doesn't)

  ┌─ Runtime readers (the only concurrency here) ────────────────────┐
  │  A* search · heatmap render · nearestNode · tile builds          │
  │       all READ the same immutable Graph  ──► no coordination      │
  │       needed: readers never block readers                        │
  └───────────────────────────┬──────────────────────────────────────┘
        ┌─────────────────────▼─────────────────────┐
        │  ✗ NO LOCKS · NO MVCC · NO CONFLICTS ✗     │  ← the absent layer
        └─────────────────────┬──────────────────────┘
  ┌─ Storage (immutable graph.json) ──▼──────────────────────────────┐
  │  one frozen snapshot, never mutated at runtime                   │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"when two operations touch the same data at the same
time, what keeps them from corrupting it?"* flattr's answer is "the data is
immutable, so concurrent access is automatically safe" — which is the strongest
form of concurrency control there is: **make the shared state read-only and the
problem disappears.**

## The structure pass

**Layers.** The runtime *does* have concurrency — multiple async operations run
interleaved on the JS event loop (an A* search, a debounced tile fetch, a render).
But none of them *write shared state*, so the concurrency is benign.

**The axis: state — is the shared state mutable, and who can write it?** This is
the axis that makes the absence make sense:

```
  Axis = "is the shared state mutable concurrently?"

  ┌─ Shared store (graph.json in RAM) ────────────┐
  │  read by many concurrent operations            │  → IMMUTABLE: no writer,
  │                                                 │    so concurrent reads
  │                                                 │    can't conflict
  └───────────────────────────┬─────────────────────┘
  ┌─ Per-operation state ─────▼─────────────────────┐
  │  A*'s g/came/closed maps, useTileGraph's refs    │  → MUTABLE but NOT
  │                                                 │    shared: each op owns
  │                                                 │    its own, no contention
  └───────────────────────────────────────────────────┘
```

**Seams.** The would-be seam — "two writers contend for the same row" — doesn't
exist. The *interesting* near-seam is in `useTileGraph`: it has a hand-rolled
**single-flight guard** (`busyRef`) that serializes tile *builds*. That's not
database concurrency control, but it's the same *instinct* — prevent two
expensive operations from running at once — applied to network builds rather than
data writes. Worth seeing as the closest thing flattr has to a lock.

## How it works

### Move 1 — the mental model

You know `useRef(false)` as a mutex flag — "is this thing already running?" — to
stop a double-submit. That's concurrency control at the application level. A
database's locks and MVCC are the same idea pushed down to the data: stop two
writes from clobbering each other. flattr has the app-level flag (for builds) but
not the data-level machinery, because its data never gets written concurrently.

```
  The pattern — concurrency control = coordinate access to mutable shared state

  pessimistic (locks):   acquire lock ─► write ─► release   (block others)
  optimistic (MVCC):     read version ─► write ─► check version unchanged
                                                  ↳ if changed: retry
  flattr:                no mutable shared state ─► no coordination needed
```

### Move 2 — what's here, what's absent

#### Readers never block readers (the immutability win)

The `Graph` in memory is treated as read-only by everything: A* reads
`adjacency` and `nodes`, the heatmap reads `edges`, `nearestNode` reads `nodes`.
None write. So you can run an A* search *while* the heatmap renders *while* a
nearest-node snap computes, all against the same object, with zero coordination
and zero risk. This is exactly what a database's read-only snapshot isolation
buys — except flattr gets it for free by never writing.

```
  Concurrent reads against immutable state — always safe

  A* search ──┐
  heatmap   ──┼──► read the same Graph ──► no locks, no conflicts, no MVCC
  nearest   ──┘    (immutable ⇒ no reader can observe a partial write)
```

#### The one real coordination: single-flight tile builds

`useTileGraph` runs network tile builds, and it *must not* run two at once (free-
tier rate limits + wasted work). So it uses `busyRef` as a mutex: if a build is
in flight, new requests queue instead of starting. This is pessimistic
concurrency control — at the operation level, not the data level.

```
  Single-flight guard — the closest thing to a lock

  pump() called:
    if busyRef.current: return            ← "lock held" → don't start
    busyRef.current = true                ← acquire
    ...do the build...
    finally: busyRef.current = false      ← release
             pump()                        ← drain the next queued request
       │
       └─ corridor requests take priority over viewport (a hand-coded
          scheduling policy). This serializes builds, but it guards NETWORK
          calls, not data writes — there's no shared row being protected.
```

What breaks without it: two simultaneous Overpass+elevation builds, doubling
network load and hitting the rate limit that the project memory explicitly warns
about. So the guard is load-bearing for *cost*, not for *data correctness*.

#### Why MVCC and lock conflicts are absent

MVCC keeps multiple versions of a row so readers see a consistent snapshot while
writers create new versions. flattr has exactly one version of its data, forever
(per deploy). Lock conflicts (deadlock, lock waits) require contending writers.
With zero runtime writers, there are zero conflicts. None of this machinery has
anything to do.

#### Move 2.5 — current vs future state

```
  Phase A (now): no data concurrency control   Phase B (user edits)

  immutable shared Graph                        mutable shared edge rows
  readers never block readers                   writers contend on hot areas
  busyRef guards builds (not data)              need row locks or MVCC
  no conflicts possible                         deadlocks/retries now possible
  no version field                              need a version for optimistic CC
```

The trigger is identical to file `05`: the first runtime write to shared state.
Two users editing the same neighborhood would contend, and you'd choose
pessimistic (lock the edge) or optimistic (version + retry). SQLite gives you
database-level locking; Postgres gives you row-level MVCC. The `busyRef` pattern
already in `useTileGraph` is a hint of how you think about it — but it'd move down
to the data layer.

### Move 3 — the principle

**The cheapest concurrency control is no shared mutable state.** flattr makes its
shared data immutable, so concurrent access is safe by construction — the same
reason functional programmers prefer immutable structures and React prefers
immutable state updates. The general lesson: before reaching for locks or MVCC,
ask whether the shared state needs to be mutable at all. If it doesn't,
immutability is a stronger and simpler guarantee than any lock.

## Primary diagram

The full picture: benign read concurrency, the one operation-level guard, the
absent data-level machinery.

```
  flattr concurrency — what's safe, what's guarded, what's absent

  ┌─ Runtime (JS event loop, interleaved async) ─────────────────────┐
  │                                                                   │
  │  A* / heatmap / nearest ──► READ immutable Graph ──► SAFE, no CC  │
  │                                                                   │
  │  useTileGraph.pump() ──► busyRef mutex ──► one build at a time    │
  │                          (guards NETWORK cost, not data rows)     │
  │                                                                   │
  │  ✗ no row locks  ✗ no MVCC  ✗ no version fields  ✗ no deadlocks   │
  │                                                                   │
  │  [Phase B] user edits → data-level CC (lock or MVCC) lands here   │
  └───────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Concurrency control at the *data* level: never invoked — no
writers. Concurrency control at the *operation* level: the `busyRef` single-flight
guard runs constantly while the user pans the map.

**The single-flight guard — `mobile/src/useTileGraph.ts` (lines 67, 89-129):**

```
  const busyRef = useRef(false);          ← the "lock" flag
  ...
  const pump = useCallback(() => {
    if (busyRef.current) return;          ← lock held → bail (single-flight)
    ...pick corridor over view (priority)...
    busyRef.current = true;               ← acquire the lock
    (async () => {
      try { ...fetchOverpass + buildGraph... }
      finally {
        busyRef.current = false;          ← release
        pump();                           ← drain next queued request
      }
    })();
  }, []);
       │
       └─ this serializes expensive NETWORK builds (the project memory warns the
          free elevation API 429s under load). It's pessimistic op-level CC. It
          does NOT protect any data row — there are no rows to protect. Remove it
          and you don't corrupt data; you hammer the rate limit.
```

**Proof there's no data write to coordinate — `features/routing/astar.ts` (lines 30-37):**

```
  const open = new PQueue<string>();      ← all per-search state, created fresh
  const g = new Map<string, number>();      each call, owned by this invocation,
  const came = new Map<...>();               never shared across searches
  const closed = new Set<string>();
       │
       └─ two concurrent searches each get their OWN open/g/came/closed. They
          share only the immutable Graph (read-only). So even concurrent A* runs
          need no locks — they touch no common mutable state.
```

## Elaborate

Concurrency control is the heart of a database's correctness story under load,
and it's genuinely absent here — not hidden, not implicit, just unneeded. The
disciplined move is to say so and point at the *reason* (immutability) rather than
manufacture a lock that isn't there.

The transferable lessons are two. First, immutability as a concurrency strategy:
flattr's read-only `Graph` is the same pattern as a database's MVCC snapshot or a
React component's frozen props — make the shared thing unchangeable and
concurrent access stops being dangerous. Second, the `busyRef` single-flight
pattern is real, app-level concurrency control worth recognizing: it's the same
shape as a distributed lock or a mutex, applied to throttle expensive operations.
It's just not *database* concurrency control.

What to read next: `07` — durability and recovery, where the build-write's lack
of crash-atomicity is the one concrete gap.

## Interview defense

**Q: "How does this codebase handle concurrent access to its data?"**

> The data is immutable at runtime, so concurrent access is safe by construction
> — readers never block readers, and there are no writers to coordinate. That's
> the strongest concurrency control there is: no mutable shared state. The only
> real coordination in the app is a single-flight guard in `useTileGraph` —
> `busyRef` serializes expensive network tile builds so we don't hit the
> free-tier rate limit. But that guards an operation, not a data row; there's no
> lock or MVCC on the data because there's no write to the data.

```
  immutable Graph ──► concurrent reads always safe (no CC needed)
  busyRef ──► one network build at a time (op-level guard, not data-level)
```

Anchor: *the cheapest concurrency control is no shared mutable state.*

**Q: "Two concurrent A* searches — do they need locking?"**

> No. Each search creates its own `open`/`g`/`came`/`closed` state; they share
> only the read-only `Graph`. There's no common mutable state, so no lock. That's
> a direct consequence of keeping per-search state local rather than on the shared
> object.

```
  search A: own g/came/closed ─┐
  search B: own g/came/closed ─┴─► share only immutable Graph ─► no contention
```

Anchor: *per-search state is local; only the immutable Graph is shared.*

## Validate

1. **Reconstruct:** explain why concurrent reads of the `Graph` need no locks,
   using the immutability argument.
2. **Explain:** what does `busyRef` (`useTileGraph.ts:67,90`) actually protect —
   and what would break if you removed it? (Network cost / rate limit, not data.)
3. **Apply:** design data-level concurrency control for two users editing the
   same edge. Pessimistic or optimistic, and why?
4. **Defend:** someone says "no locks means race conditions." Show, using
   `astar.ts:30-37`, why concurrent searches can't race.

## See also

- `05-transactions-isolation-and-anomalies.md` — also `not yet exercised`, same root cause
- `07-wal-durability-and-recovery.md` — the one concrete write-side gap
- `01-database-systems-map.md` — the immutability that makes all of this safe
- `.aipe/study-runtime-systems/` — the event loop the benign concurrency runs on
