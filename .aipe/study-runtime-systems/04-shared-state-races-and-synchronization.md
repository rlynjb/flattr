# Shared state, races, and synchronization

*Shared mutable state, locks, atomics, channels, and ownership.*
**Type:** Industry standard (single-thread cooperative coordination).

## Zoom out, then zoom in

There are no threads (`02-`), so there are no *memory* races — no torn
reads, no need for `Atomics` or mutexes-for-correctness. But there's still
a coordination problem, and it's a real one: in the app, **multiple async
tasks want to run a graph build at the same time**, and only one network
build should run at a time (rate limits). flattr solves this with one
hand-rolled object: the `pump()` single-flight gate in `useTileGraph`.
That gate is the entire synchronization story.

```
  Zoom out — the one coordination point, on the runtime map

  ┌─ RUN process · JS thread ────────────────────────────────┐
  │  pan event ──┐                                            │
  │  route set ──┼──► ★ useTileGraph.pump() single-flight ★   │ ← we are here
  │  zoom event ─┘     busyRef lock + 2 pending slots          │
  │                                                            │
  │  (everything else: no shared mutable state worth guarding) │
  └──────────────────────────────────────────────────────────┘

   no Atomics, no SharedArrayBuffer, no locks-for-memory-safety
   — `not yet exercised` (can't exist without threads)
```

Zoom in: the question is *what mutable state is shared between concurrent
async tasks, and how does flattr keep two tasks from stepping on each
other?* The answer is a cooperative lock built from React refs — not
because JS has races, but because the *network* has rate limits and the
*UI* has consistency requirements.

## Structure pass

**Layers.** The coordination nests like this:

```
  Layered decomposition — "what's shared, and who guards it?"

  ┌───────────────────────────────────────────────┐
  │ outer: React state (view, corridor)            │ → guarded by render model
  └───────────────────────────────────────────────┘   (setState → re-render)
      ┌─────────────────────────────────────────┐
      │ middle: the pump() gate (busyRef + slots) │ → guarded by single-flight
      └─────────────────────────────────────────┘    (the explicit "lock")
          ┌─────────────────────────────────────┐
          │ inner: a single in-flight build       │ → guarded by being alone
          └─────────────────────────────────────┘    (only one ever runs)

  "who guards this?" — React / the gate / nothing-it's-alone
```

**Axis — state ownership.** Trace "who can mutate this, and when?" React
*state* (`view`, `corridor`) is owned by React: you mutate it only via
`setState`, and reads are snapshots-per-render. The *refs* (`busyRef`,
`pendingViewRef`, `corridorRef`) are owned by `useTileGraph` and mutated
synchronously, *outside* React's model — that's deliberate, and it's the
crux of why the gate works.

**Seam.** The load-bearing boundary is **React state ↔ refs**. State is
async and batched (a `setState` doesn't take effect until the next
render). Refs are synchronous and immediate. The gate is built on refs
*precisely because* it needs to read "am I busy?" synchronously, the
instant an event fires — `state` would be stale.

## How it works

### Move 1 — the mental model

You know single-flight from request deduplication: if a call is already
in progress, don't start a second one — either reject it or remember it
for when the first finishes. That's exactly `pump()`. It's a mutex with a
one-slot queue per kind of work. The "lock" is a boolean ref; the "queue"
is two `pending` ref slots; "fairness" is a fixed priority (corridor beats
view).

```
  Pattern — single-flight gate with a 1-deep priority queue

   request ──► pump() ──► busy?  ──yes──► stash in pending slot, return
                            │
                            no
                            ▼
                   set busy=true, run the build
                            │
                            ▼ (build finishes)
                   busy=false ──► pump() again ──► drain next pending
                                  (corridor slot checked before view slot)

   only ONE build runs at a time; newer requests overwrite the
   pending slot (last-write-wins), they don't queue up unboundedly
```

### Move 2 — walk the gate

**The lock is a single boolean ref.** `busyRef.current` is the entire
mutex. `pump()`'s first line is `if (busyRef.current) return;` — if a
build is running, the new request doesn't start one; it just leaves its
bbox in a pending slot and bails. This is a *ref*, not state, so the
check is synchronous and current — no stale-snapshot race.

```
  Skeleton — the single-flight kernel

  [ busyRef ] is the lock + [ pendingViewRef / pendingCorridorRef ]
  are the 1-deep queue + [ pump() re-call in finally ] is the drain

  remove busyRef:        two concurrent fetches → rate-limit ban
  remove the finally pump: queue never drains → second request lost
  remove the priority:   a pan can starve a pending route
```

**The queue is two slots, last-write-wins.** There's a `pendingViewRef`
and a `pendingCorridorRef`. A new viewport request *overwrites* whatever
was in the view slot — you only ever care about the *latest* viewport, so
older pending pans are correctly discarded. This is bounded by
construction: at most two requests can be pending, ever.

```
  Execution trace — pan, pan, route while a build runs

  step  event            busyRef  pendingView   pendingCorridor
  ────  ───────────────  ───────  ────────────  ───────────────
  1     pan A → pump()    true     —             —     (build A runs)
  2     pan B → pump()    true     bboxB         —     (busy: stash)
  3     pan C → pump()    true     bboxC ◄over—   —     (overwrite B)
  4     route → pump()    true     bboxC         corr  (stash corridor)
  5     build A done      false    bboxC         corr  (finally → pump)
  6     pump() drains     true     bboxC         —     (corridor FIRST)
  7     corridor done     false    bboxC         —     (pump → drain view)

  note step 3: pan B was silently dropped — correct, you only want latest
  note step 6: route beat the pending pan — priority, so routing isn't starved
```

**Priority is a fixed if/else, not a real scheduler.** `pump()` checks the
corridor slot *before* the view slot. A pending route always wins over a
pending pan, so panning around can't starve a route you asked for. That's
the whole fairness policy — two lines.

**Why refs, not state?** This is the subtle part. If `busyRef` were React
state, the check `if (busy) return` would read a *stale snapshot* — the
value from the last render, not the live value. Two events firing in the
same tick would both see `busy === false` and both start a build. Refs
mutate synchronously and read live, so the gate is correct under
back-to-back events in one tick.

```
  Comparison — why a ref, not useState, for the lock

  useState lock:   event1 reads busy=false (stale) ─┐ BOTH start
                   event2 reads busy=false (stale) ─┘ → 2 fetches → ban

  useRef lock:     event1 sets busy=true (live)  ──┐ event2 sees
                   event2 reads busy=true (live)  ─┘ true → stashes
                                                     → 1 fetch ✓
```

**The "result" of a build is the only thing that goes back into state.**
When a build finishes, `setView`/`setCorridor` fire — *that's* the React
state update that triggers a re-render and re-stitches the merged graph
(`useTileGraph.ts:72-85`). So refs do the coordination; state does the
rendering. Clean ownership split.

### Move 3 — the principle

On a single thread, "synchronization" isn't about memory safety — it's
about **policy under concurrent async tasks**: which one runs, which waits,
which gets dropped. flattr's gate encodes a real policy (one network build
at a time, route beats pan, keep only the latest) in ~40 lines of refs.
The lesson that transfers: when you need a synchronous, race-free flag in
React, reach for `useRef`, not `useState` — state is for rendering, refs
are for coordination.

## Primary diagram

The full gate — the lock, the two-slot queue, the priority drain, and the
ref/state split.

```
  pump() single-flight gate — full picture

  EVENTS (async, may fire same tick)
   pan ─┐   route ─┐   zoom ─┐
        ▼          ▼         ▼
  ┌─────────── pump() ──────────────────────────┐
  │  if busyRef.current → stash & return          │ ← the lock (ref, sync)
  │  else pick: pendingCorridor ?? pendingView    │ ← priority drain
  │       busyRef = true; run build (async I/O)   │
  └───────────────────────┬───────────────────────┘
                          │ finally:
                          ▼
            busyRef = false; pump()  ◄── re-drain next pending
                          │
                          ▼ on success
            setView / setCorridor  ──► React re-render ──► stitch merged graph

  REFS (coordination, synchronous):  busyRef, pendingViewRef,
                                     pendingCorridorRef, corridorRef, viewRef
  STATE (rendering, async):          view, corridor, loadingStep
```

## Implementation in codebase

**Use cases.** The gate is reached for on every map interaction that could
trigger a build: a pan (`onRegionDidChange` → view slot), a route
(`ensureBbox` → corridor slot), and the chained drains when a build
finishes. It exists because Overpass and Open-Meteo are rate-limited and a
burst of pans would otherwise fire a burst of builds.

The lock-check and priority-drain, the heart of the gate:

```
  mobile/src/useTileGraph.ts  (lines 89-104)

  const pump = useCallback(() => {
    if (busyRef.current) return;                 ← THE LOCK (sync ref read)
    let kind: "corridor" | "view";
    let bbox: Bbox;
    if (pendingCorridorRef.current) {            ← corridor checked FIRST
      kind = "corridor";
      bbox = pendingCorridorRef.current;
      pendingCorridorRef.current = null;         ← consume the slot
    } else if (pendingViewRef.current) {         ← view second (lower priority)
      kind = "view"; bbox = pendingViewRef.current;
      pendingViewRef.current = null;
    } else { return; }                            ← nothing pending: idle
    busyRef.current = true;                       ← TAKE THE LOCK
    ...
        │
        └─ corridor-before-view is the entire fairness policy: a pending
           route can't be starved by panning. Take the lock synchronously
           so two same-tick events can't both pass the `if (busyRef)` guard.
```

The drain-on-finish — the part that makes the queue actually empty:

```
  mobile/src/useTileGraph.ts  (lines 121-128)

      } catch {
        // Overpass failed — keep the last region; a later pan retries.
      } finally {
        busyRef.current = false;                  ← RELEASE THE LOCK
        setLoadingStep(null);
        pump();                                    ← DRAIN next pending (corridor first)
      }
        │
        └─ the recursive pump() in finally is load-bearing: without it, a
           request stashed while busy would sit in its slot forever. The
           catch swallows failures so a 429 doesn't break the drain chain.
```

And the two `covers()` short-circuits that keep the gate from even being
engaged when the data's already loaded:

```
  mobile/src/useTileGraph.ts  (lines 141-146, 160)

  if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;  ← base covers it
  if (covers(viewRef.current, bounds)) return;                    ← view covers it
  ...
  if (covers(corridorRef.current, bbox)) return true;             ← corridor covers it
        │
        └─ these read refs (live, sync) to decide "do I even need a build?"
           before touching the gate — cheapest possible path is no build at all.
```

## Elaborate

Single-flight / request-coalescing is the same pattern as SWR's
deduplication, React Query's in-flight tracking, and `golang.org/x/sync`'s
`singleflight` — collapse N concurrent requests for the same resource into
one. flattr's twist is the priority queue (corridor over view) and the
last-write-wins slots, which together encode "I only care about the latest
viewport, but never drop a route." The deeper runtime lesson is the
`useRef`-as-mutex idiom: React state is the *wrong* tool for coordination
because it's intentionally async and batched; refs give you the
synchronous, immediate, race-free flag that coordination needs. Read `07-`
for how this same gate is also flattr's entire backpressure story.

## Interview defense

**Q: "There are no threads — so why is there a lock?"**

Because the *network* is the shared resource, not memory. Overpass and
Open-Meteo are rate-limited; firing a build per pan-event would get me
throttled. `busyRef` ensures one network build runs at a time
(`useTileGraph.ts:90`). It's a coordination lock over an external
resource, not a memory-safety mutex — there are no data races to prevent
on one thread.

```
  many pan events ──► [ busyRef gate ] ──► one fetch at a time ──► no ban
```

Anchor: *"The lock guards the rate limit, not the heap."*

**Q: "Why `useRef` for the lock instead of `useState`?"**

State reads are stale within a tick — two events firing back-to-back would
both read `busy === false` and both start a build. Refs mutate
synchronously and read live, so the second event sees `busy === true` and
stashes instead (`useTileGraph.ts:90,104`). State is for rendering; refs
are for coordination.

```
  useState: both events see stale false → 2 builds (race)
  useRef:   event2 sees live true → stash → 1 build ✓
```

Anchor: *"State is async-by-design; a lock has to be synchronous — so it's
a ref."*

## Validate

**Reconstruct.** Draw the gate from memory: the lock, the two pending
slots, the priority order, the drain-in-finally. Name what breaks if each
is removed. (No lock → concurrent fetches → ban; no finally-pump → pending
lost; no priority → route starved by pans.)

**Explain.** Why does a third pan during a build silently discard the
second pan's bbox? (View slot is last-write-wins; you only want the latest
viewport — `useTileGraph.ts:146` overwrites `pendingViewRef`.)

**Apply.** A teammate rewrites `busyRef` as `useState(false)`. What
concurrency bug appears? (Two same-tick events both read the stale
`false`, both start a build, you hit the rate limit — the exact case refs
prevent.)

**Defend.** Argue that corridor-over-view priority is correct, not
arbitrary. (A route is an explicit user request that must complete to show
a path; panning is exploratory and its result is disposable. Starving the
route to service pans would break the core feature — `useTileGraph.ts:93`.)

## See also

- `02-processes-threads-and-tasks.md` — why there are no memory races
- `03-event-loop-and-async-io.md` — the async tasks the gate coordinates
- `07-backpressure-bounded-work-and-cancellation.md` — the gate as backpressure
- [`.aipe/study-frontend-engineering/`](../study-frontend-engineering/) — refs vs state in React
