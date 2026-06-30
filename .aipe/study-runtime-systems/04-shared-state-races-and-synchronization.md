# Shared State, Races, and Synchronization — the single-flight "lock"

**Industry name:** concurrency control / single-flight / cooperative mutual exclusion — *Industry standard*.

## Zoom out, then zoom in

With one JS thread (`02`) and no preemption (`03`), flattr can't have a *data* race — two
threads writing one variable at the same instant simply can't happen. But it absolutely has
a *logical* concurrency problem: multiple async builds racing to be the "current" graph.
Here's where the synchronization lives.

```
  Zoom out — shared mutable state and its guard

  ┌─ UI ─────────────────────────────────────────────────────────┐
  │  pan, route → fire async work concurrently                   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ both want to mutate ↓
  ┌─ Shared state (useTileGraph refs) ───────────────────────────┐
  │  busyRef · pendingViewRef · pendingCorridorRef · viewRef     │ ← we are here
  │  ★ pump() = the single-flight guard over all of it ★         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ produces
  ┌─ Derived state (useMemo graphs) ─────────────────────────────┐
  │  merged graph + display graph (recompute on ref change)      │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"what's shared and mutable, and what keeps concurrent async
tasks from corrupting it?"** flattr's answer is a hand-rolled single-flight pattern built
from `useRef` flags — `busyRef` plays the role of a lock, but it isn't one. It works
*because* of the event loop, not because of any atomic primitive. That dependency is the
whole lesson.

## Structure pass — layers, one axis, the seams

**The layers:** UI events (concurrent sources) → mutable refs (shared state) → the `pump()`
guard → derived `useMemo` graphs. **The axis: "who can be mid-write when another task
starts?"**

```
  Axis: "can a second task interleave with a write?"  — traced down

  ┌─ UI events ──────────────────────────────────┐
  │  pan + route fire whenever                    │  → YES, concurrent SOURCES
  └────────────────────────────────────────────────┘
      ┌─ ref writes (busyRef = true, etc.) ──────┐
      │  set synchronously, no await between them │  → NO — runs to completion,
      └────────────────────────────────────────────┘    can't be interleaved (no preempt)
          ┌─ the async build body ───────────────┐
          │  await fetch / await build            │  → YES — yields, so a SECOND
          └────────────────────────────────────────┘    pump() could start... unless guarded
```

The answer flips between the *synchronous* ref-setting (safe by construction) and the
*async* build body (the real hazard — it yields, so re-entrancy is possible). The guard
sits exactly at that flip.

**The seam — `pump()`'s entry check:**

```
  The single-flight seam — busyRef gates re-entry

  call pump() ──► busyRef.current?  ──yes──► return (drop this call)
                       │ no
                       ▼
                  busyRef = true  ═╪═►  [async build yields here, but re-entry is blocked]
                       │
                  finally: busyRef = false ─► pump() again (drain next)
```

That one boolean check is the entire mutual-exclusion mechanism. Hand off to How it works.

## How it works

### Move 1 — the mental model

You've written this exact guard without calling it concurrency control: the
`if (loading) return;` at the top of a submit handler so a double-click doesn't fire two
requests. That `loading` flag *is* a single-flight lock. flattr's `busyRef` is the same
idea, scaled to a queue: one build runs at a time, and new requests don't queue infinitely —
they overwrite a single "pending" slot. The strategy: **a boolean guards the critical
section; a single-slot pending ref coalesces bursts; the event loop's no-preemption rule
makes the boolean safe without an atomic.**

```
  Single-flight kernel — one in-flight, one pending slot per kind

   in-flight:  [ build running ]  ◄── busyRef = true
   pending:    corridor slot ─┐
               view slot ─────┤  ◄── new requests overwrite, don't queue
                              │
   on finish: busyRef=false → pump() → take corridor first, else view
```

### Move 2 — the load-bearing skeleton

This is a kernel concept, so name each part by what breaks without it.

**Part 1 — `busyRef`: the lock. Remove it → re-entrant builds.** Without the guard, every
`pump()` call would start a fresh async build; two `fetchOverpass`/`buildGraph` chains would
run concurrently, both writing `viewRef`/`setView`, and the *last to resolve* wins
non-deterministically — plus you'd hammer the rate-limited APIs in parallel.

```ts
// mobile/src/useTileGraph.ts:166-182 — busyRef is the lock; the early return is the guard
const pump = useCallback(() => {
  if (busyRef.current) return;          // ← LOCK HELD: drop this call, the running build will re-pump
  let kind, req;
  if (pendingCorridorRef.current) { kind = "corridor"; req = pendingCorridorRef.current; pendingCorridorRef.current = null; }
  else if (pendingViewRef.current) { kind = "view"; req = pendingViewRef.current; pendingViewRef.current = null; }
  else return;
  busyRef.current = true;               // ← ACQUIRE: set synchronously, before any await
```

The acquire (`busyRef = true`) happens **synchronously**, before the first `await`. That
ordering is load-bearing: because no task can preempt mid-statement (`03`), no second
`pump()` can slip between the `if (busyRef.current) return` check and the
`busyRef.current = true` set. *In a multithreaded world this would be a textbook
check-then-act race needing a real mutex.* Here the event loop provides the atomicity for
free — which is exactly why moving A\* or builds to a worker (`02`) would *break* this and
force a real lock.

**Part 2 — the single pending slot: coalescing. Remove it → unbounded queue.** New requests
don't append — they overwrite `pendingViewRef` / `pendingCorridorRef`:

```ts
// mobile/src/useTileGraph.ts:239 — overwrite, not enqueue: only the LATEST view matters
pendingViewRef.current = { bbox: [w - px, s - py, e + px, n + py], silent: false };
pump();
```

If you pan five times during one build, only the fifth viewport survives to run next — the
intermediate ones are stale and worthless. A FIFO queue would dutifully run all five. The
single slot *is* the "only the latest matters" policy, encoded as a data structure. What
breaks without it: a backlog that takes minutes to drain after a fast pan.

**Part 3 — priority: corridor over view. Remove it → routes starve behind pans.** When both
slots are full, `pump()` always takes corridor first (`useTileGraph.ts:170-177`). A route
in progress can't be starved by background pan loads.

```
  Drain order — corridor (route) beats view (pan)

  pending: corridor=[A] view=[B]
  pump() ──► take corridor [A] ──► run ──► finally pump() ──► take view [B]
            (route never waits behind panning)
```

**Part 4 — the `finally` re-pump: liveness. Remove it → permanent deadlock.** Releasing the
lock and re-pumping happens in `finally`, so it runs even if the build throws:

```ts
// mobile/src/useTileGraph.ts:219-225 — release + drain, guaranteed even on error
  } catch {
    // Overpass failed — keep last region; a later pan retries.
  } finally {
    busyRef.current = false;   // ← RELEASE the lock
    if (!silent) setLoadingStep(null);
    pump();                    // ← drain the next pending request
  }
```

What breaks if release is in `try` instead of `finally`? A thrown build leaves `busyRef`
stuck `true` forever — every future `pump()` returns at the guard, and the app never loads
another tile. The `finally` is the liveness guarantee. This is the single part people forget
when hand-rolling a lock: **the unlock must be unconditional.**

**Part 5 — the refs-vs-state duplication.** Note that state lives twice: as React state
(`view`, `corridor` via `setView`/`setCorridor`, which trigger re-render) *and* as refs
(`viewRef`, `corridorRef`, which `pump` reads synchronously). The refs exist because
`pump`'s closure would otherwise capture stale state. The retry logic reads
`viewRef.current?.degraded` (`useTileGraph.ts:213`) — the live value, not the render-time
snapshot. What breaks if you read state instead of refs inside `pump`? You'd act on a stale
graph because the closure captured an old render. This isn't a *race* — it's the classic
React stale-closure trap, solved with refs.

### Move 3 — the principle

In a single-threaded runtime, synchronization isn't about *atomicity* (the event loop gives
you that free) — it's about *logical coordination of async tasks*: making sure one runs at
a time, that bursts coalesce, that the right one wins, and that the lock always releases.
flattr builds all four from a boolean and two ref slots, with zero locking primitives,
because the runtime guarantees no two of its writes interleave. The deep lesson: **a
single-flight flag is a real lock *only* as long as the code stays on one thread** — the day
you move the guarded work off-thread, the boolean stops being atomic and you need the real
thing. Knowing *why* the cheap version is currently sufficient is the senior signal.

## Primary diagram

The full synchronization picture — sources, the guard, the slots, the release.

```
  flattr single-flight — boolean lock + coalescing slots, on one thread

  ┌─ UI (concurrent sources) ────────────────────────────────────┐
  │  pan ──► queueViewport          route ──► ensureBbox          │
  └──────────────┬───────────────────────────────┬───────────────┘
                 ▼ overwrite                       ▼ overwrite
        pendingViewRef                     pendingCorridorRef
                 └───────────────┬───────────────┘
                                 ▼
                    pump():  busyRef? ──yes──► drop
                                │ no
                          busyRef = true (sync, pre-await) ★ acquire
                                │ corridor first, else view
                          ┌─────▼─────┐
                          │ async build│  fetchOverpass → buildGraph
                          │ (yields)   │  (re-entry blocked by busyRef)
                          └─────┬──────┘
                          finally: busyRef = false ★ release → pump() (drain)
                                │
                                ▼  writes viewRef/corridorRef + setView/setCorridor
                       useMemo graphs recompute (merged + display)
```

## Elaborate

This is the **single-flight** pattern (Go's `singleflight` package is the canonical named
version: collapse concurrent duplicate work into one in-flight call). flattr's twist is the
*single pending slot* — a "keep only the latest" coalescing queue, the same shape as a
debounced state update or RxJS `switchMap` (drop the in-flight, take the newest). The
no-lock-needed property comes from JavaScript's **run-to-completion** semantics, the same
guarantee that lets Redux reducers be plain functions and lets you mutate a ref in an event
handler without a mutex. The moment that guarantee is broken — a worker, a shared
`SharedArrayBuffer` — you're back to needing `Atomics` or a real mutex, none of which the
repo has (grep: zero). For *when* you'd cross that line, see `02`'s worker trigger; for the
debounce that feeds these slots, see `03`.

## Interview defense

**Q: "This app fires async graph builds from panning and routing simultaneously. How does
it avoid corrupting the current graph?"**

A single-flight guard. `pump()` checks a `busyRef` boolean — if a build is running, the
call is dropped, and new requests overwrite a single pending slot rather than queueing. One
build runs at a time, corridor (route) before view (pan). The lock releases in `finally`, so
a failed build doesn't deadlock it.

```
  pump(): busyRef? ─yes─► drop.  ─no─► busyRef=true → build → finally busyRef=false → pump()
```

*Anchor:* "It's a single-flight lock built from a boolean — and the unlock is in `finally`,
which is the part people forget."

**Q: "Is that boolean safe? Couldn't two calls both pass the check?"**

Not on one JS thread. The check and the set are synchronous with no `await` between them, so
no task can interleave — run-to-completion gives it atomicity for free. The catch: that's
*only* true while the work stays on one thread. Move the build to a worker and the boolean
stops being a real lock; then you'd need an actual mutex or atomics.

```
  if (busyRef) return;  busyRef = true;   ← no await between → uninterruptible on one thread
```

*Anchor:* "It's a real lock exactly as long as it stays single-threaded — that's the
condition I'd flag before anyone moves work off-thread."

## See also

- `03-event-loop-and-async-io.md` — the no-preemption rule that makes the boolean atomic.
- `02-processes-threads-and-tasks.md` — the worker trigger that would break this guard.
- `07-backpressure-bounded-work-and-cancellation.md` — the pump as bounded work + the missing cancel.
- `study-testing` (sibling) — how single-flight behavior is verified deterministically.
