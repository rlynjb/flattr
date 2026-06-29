# Shared State, Races & Synchronization

**Industry name(s):** shared mutable state · data races · cooperative
synchronization · refs-as-mutable-cells vs state-as-snapshot. **Type:** Industry
standard.

## Zoom out, then zoom in

Real data races need two threads touching one memory location. flattr has one JS
thread per runtime, so the classic race — torn reads, lost updates, needing a
lock — **is not yet exercised**. What flattr *does* have is a subtler, very real
concurrency concern: async tasks interleaving on one thread, and a deliberate
split between mutable `useRef` cells and immutable `useState` snapshots.

```
  Zoom out — the two kinds of "shared" state in the run-time process

  ┌─ JS thread (one thread, no true parallelism) ──────────┐
  │                                                        │
  │  useRef cells (mutable, read NOW)      useState (snapshot, │
  │  ┌───────────────────────────┐         for render)         │
  │  │ busyRef, viewRef,         │        ┌──────────────────┐ │
  │  │ pendingViewRef, retryRef  │        │ view, corridor,  │ │ ← we are
  │  │ ★ the "shared" mutable    │        │ loadingStep      │ │   here
  │  │   state across async      │        │ (drives UI)      │ │
  │  │   continuations ★         │        └──────────────────┘ │
  │  └───────────────────────────┘                            │
  │  module-level: elevCache `mem` Map (shared across calls)  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the question is **what mutable state is shared across overlapping async
work, and what keeps it consistent without a lock?** The answer is the
single-threaded model plus a disciplined ref/state split — not mutexes.

## Structure pass

**Layers.** Three holders of mutable state: (1) `useRef` cells in
`useTileGraph` — read at the moment a continuation resumes, never stale; (2)
`useState` values — frozen per render, intentionally stale within a render;
(3) module-level mutable singletons — the `mem` Map in `elevCache.ts` and the
`dirty`/`loaded` flags, shared across every call.

**Axis traced — "can two pieces of work observe an inconsistent value
(guarantees)?"**

```
  One axis — "can this be observed inconsistent?" — across holders

  useRef (busyRef etc.)   → NO inconsistent read: single thread, no preemption
                            mid-statement. Race-free by construction.
  useState (view/corridor)→ "stale" by DESIGN: a render sees one snapshot;
                            that's React's model, not a bug.
  elevCache mem Map       → check-then-act (getElev → putElev) is NOT atomic
                            across awaits — but collisions only re-fetch, never corrupt.
```

**Seam — the ref/state boundary.** The same logical value (the current region)
exists twice: `viewRef.current` (mutable, for logic) and `view` (snapshot, for
render). Why both? Because the async `pump` continuation must read the *latest*
region when it resumes, but React must render a *stable* one. The axis flips here:
refs answer "what's true now," state answers "what was true when this frame
rendered." Getting this split wrong is the most likely place a real bug would
hide.

## How it works

### Move 1 — the mental model

You've hit this in React already: a `setInterval` closure that reads a stale
`count` from `useState`, fixed by stashing it in a `useRef`. Same primitive here.
A `ref` is a mutable box whose `.current` is always the live value; `state` is a
value photographed at render time. flattr uses refs for everything the async
scheduler must read *now*, and state for everything the UI must render
*consistently*.

```
  Pattern — ref (live cell) vs state (snapshot), one logical value twice

   logic path (async pump)              render path (React)
   ┌──────────────────┐                 ┌──────────────────┐
   │ viewRef.current  │  same region    │ view (snapshot)  │
   │ always LATEST    │ ◄─────────────► │ frozen per frame │
   │ read on resume   │   written       │ stable for paint │
   └──────────────────┘   together      └──────────────────┘
        used by pump()                       used by useMemo/JSX
```

### Move 2 — the walkthrough

**Part 1 — refs are the cross-continuation shared state.** `busyRef` is read and
written across the async boundary inside `pump`. Set true before the `await`,
flipped false in `finally` after it:

```ts
// mobile/src/useTileGraph.ts:166, 182, 221-224
const pump = useCallback(() => {
  if (busyRef.current) return;       // read — could be set by a prior pump()
  ...
  busyRef.current = true;            // write before awaiting
  (async () => { try { ...await... } finally {
    busyRef.current = false;         // write after awaiting (different tick!)
  }})();
```

Why this is race-free: between the read on line 167 and the write on line 182
there is **no `await`** — it's a synchronous run, and a single-threaded loop can't
interleave another task into the middle of it. No other task can squeeze a second
`busyRef = true` in. If there were an `await` between the check and the set, *that*
would be a check-then-act race even on one thread. There isn't, so it's safe.

**Part 2 — the dual write keeps ref and state in sync.** Every region update
writes both:

```ts
// mobile/src/useTileGraph.ts:199-205
if (kind === "corridor") {
  corridorRef.current = region;   // live cell — pump() reads this on next call
  setCorridor(region);            // snapshot — useMemo(graph) reads this for render
} else {
  viewRef.current = region;
  setView(region);
}
```

Read the contrast: `covers(viewRef.current, bounds)` (line 234) runs in the *logic*
path and must see the just-written region immediately — so it reads the ref. The
`graph` `useMemo` (line 132) runs in the *render* path and depends on `view` (state)
so React re-renders when it changes. Same data, two readers, two access modes. The
boundary condition: forget to write *both* and they drift — the scheduler thinks an
area is covered while the map still shows the old graph, or vice versa.

**Part 3 — the elevCache Map is a module-level singleton with non-atomic
check-then-act.** This is the closest thing to a "shared resource" across calls:

```ts
// mobile/src/elevCache.ts:11, 31-40
const mem = new Map<string, number>();     // module-global, every sample() shares it
export function getElev(key) { return mem.get(key); }
export function putElev(key, value) {
  if (mem.has(key)) return;                // check
  mem.set(key, value); dirty = true;       // ...act (not atomic across awaits)
}
```

And in `cachedElevation` (`useTileGraph.ts:43-58`), the sequence is: read all
hits from `mem`, `await p.sample(missPts)`, then `putElev` the misses. Two
overlapping builds covering the same cell could both miss, both fetch, both put.
**Is that a race?** Technically a benign one: the worst case is a duplicate
fetch, never corruption — `putElev` is idempotent (`if (mem.has) return`) and DEM
values are immutable. But note the single-flight `pump()` (file 02) makes even
this nearly impossible: only one build runs at a time, so two concurrent
`sample()` calls hitting the same cell basically don't happen.

```
  Pattern — why the only "race" is harmless

  two builds, same cell        but: pump() = single-flight
  ┌──────┐    ┌──────┐         ┌──────────────────────────┐
  │ get→ │    │ get→ │  ──X──► │ only ONE build runs at a  │
  │ miss │    │ miss │         │ time → no overlap → no    │
  │ put  │    │ put  │         │ double-put possible        │
  └──────┘    └──────┘         └──────────────────────────┘
  even IF they overlapped: put is idempotent + DEM immutable = benign
```

### Move 3 — the principle

On a single thread, "synchronization" means *don't put an `await` between a check
and the act that depends on it*. There's no lock to forget because there's no
preemption — the only way to create a race is to yield the loop mid-decision.
flattr's `busyRef` is safe precisely because its check-then-set is synchronous;
its elevCache is safe because the only check-then-act that spans an `await` is
idempotent. The discipline that replaces locks here is: keep the consistency-
critical window free of yields.

## Primary diagram

```
  All mutable state in the run-time process, by access mode

  ┌─ JS thread ─────────────────────────────────────────────────┐
  │                                                             │
  │  LIVE CELLS (useRef) — read by async logic, always latest   │
  │   busyRef ──── single-flight lock (sync check-then-set: safe)│
  │   viewRef / corridorRef ──── coverage checks in pump()      │
  │   pendingViewRef / pendingCorridorRef ──── the work slots   │
  │   retryRef / timerRef / retryCountRef ──── timer handles    │
  │            │ written together with ↓                        │
  │  SNAPSHOTS (useState) — read by render, frozen per frame    │
  │   view / corridor / loadingStep ──── drive useMemo + JSX    │
  │                                                             │
  │  MODULE SINGLETON — shared across all calls                 │
  │   elevCache mem Map ──── check-then-act benign (idempotent) │
  └─────────────────────────────────────────────────────────────┘
   no thread → no lock; safety = no await inside a check-then-act window
```

## Elaborate

The ref-vs-state split is React's answer to a problem older than React: the
difference between *current value* and *value-at-a-point-in-time*. In threaded
languages you'd reach for `volatile`, a memory barrier, or a snapshot under a
lock. React gives you `useRef` for "live" and `useState` for "snapshot" and makes
you pick per-use. flattr picks correctly throughout `useTileGraph` — refs for the
scheduler's decisions, state for what the screen shows — which is why a hook this
concurrency-heavy has no visible races.

## Interview defense

**Q: This hook runs overlapping async work. Where are the data races?**

There are none, and the reason is structural: one JS thread, and every
check-then-act that matters is synchronous. `busyRef` is checked and set with no
`await` between them (`useTileGraph.ts:167`→`182`), so no other task can
interleave into that window.

```
  the safety argument

  race needs:  check ──[YIELD]──► act   (another task slips in at YIELD)
  flattr:      check ───────────► act   (no yield → no interleave → safe)
```

Anchor: *"The one check-then-act that does span an `await` is the elevCache
miss→fetch→put, and it's deliberately idempotent — `putElev` bails if the key
exists, and single-flight `pump()` means two builds rarely overlap anyway. Worst
case is a wasted fetch, never corruption."*

**Q: Why keep both `viewRef` and `view` for the same region?**

Because the async scheduler must read the *latest* region the instant a
continuation resumes (use the ref), while React must render a *stable* region per
frame (use the state). One value, two access requirements. Write both together or
they drift.

## See also

- `02-processes-threads-and-tasks.md` — `busyRef` as the single-flight lock.
- `03-event-loop-and-async-io.md` — why single-threading removes preemption races.
- `05-memory-stack-heap-gc-and-lifetimes.md` — the elevCache Map's lifetime.
- `.aipe/study-frontend-engineering/` — the React ref-vs-state model in depth.
