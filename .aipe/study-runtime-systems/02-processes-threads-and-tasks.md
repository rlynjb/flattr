# Processes, Threads & Tasks — where work runs

**Industry name(s):** single-flight / mutex-gated work queue · cooperative task
scheduling. **Type:** Industry standard (the pattern); Project-specific (the
`pump()` implementation).

## Zoom out, then zoom in

flattr has no thread pool, no worker, no job queue library. What it *does* have is
one hand-rolled single-slot scheduler that decides which network-bound graph
build runs next. That scheduler is `pump()`, and it sits squarely in the run-time
JS thread.

```
  Zoom out — where the "scheduler" lives in the stack

  ┌─ UI layer (React components) ───────────────────────┐
  │  MapScreen: pan event, route effect, grade toggle   │
  └───────────────────────┬──────────────────────────────┘
                          │  enqueue a build request
  ┌─ Orchestration (useTileGraph hook) ─────────────────┐
  │  debounce timer → pendingViewRef / pendingCorridorRef│
  │            ★ pump()  ←─ THIS CONCEPT ★               │ ← we are here
  │            busyRef gates ONE build at a time         │
  └───────────────────────┬──────────────────────────────┘
                          │  the one build that's allowed to run
  ┌─ Work (async, network-bound) ───────────────────────┐
  │  fetchOverpass → buildGraph → setState              │
  └──────────────────────────────────────────────────────┘
```

Zoom in: there are no OS threads to schedule here. The "task" is a graph build
(an async function), and the question this file answers is **how does flattr
decide which task runs, and why is only one allowed at a time?** The answer is
free-tier rate limits — run two Overpass/Open-Meteo builds at once and you get
429'd into uselessness.

## Structure pass

**Layers.** Two: the *producers* (any UI event that wants graph data — pan,
route, grade-toggle, self-heal retry) and the *single consumer* (`pump`, which
runs exactly one build then drains the next).

**Axis traced — "how many of these run concurrently (guarantees)?"** Hold it
across the work types:

```
  One axis — "how many run at once?" — across work types

  pan debounce        → at most 1 timer pending  (clearTimeout collapses)
  pending requests    → at most 1 view + 1 corridor SLOT (newer overwrites)
  in-flight build     → EXACTLY 1 (busyRef lock)        ← the hard limit
  A* search           → 1 (it's synchronous; nothing else runs during it)
  native render/GPS   → parallel (platform threads, uncounted)
```

Every layer the code owns is serialized to one. The only concurrency is the
native side, which flattr doesn't schedule.

**Seam — `busyRef` (`useTileGraph.ts:113`).** This boolean is the entire
synchronization primitive. On one side, producers freely call `pump()`; on the
other, at most one build runs. The axis (concurrency count) flips from "many
callers" to "one execution" exactly here. → `04-shared-state-races-and-synchronization.md`
for why a plain boolean is safe.

## How it works

### Move 1 — the mental model

You've written this before without naming it: a **single-flight guard** — the
`if (loading) return;` you put at the top of a submit handler so a double-click
doesn't fire two requests. `pump()` is that pattern promoted to a real scheduler:
a boolean lock, a couple of pending slots, and a drain-on-finish.

```
  Pattern — single-flight work slot with priority + drain

   producers                 the slot                consumer
  ┌──────────┐  set pending  ┌────────────┐         ┌──────────┐
  │ pan      │ ────────────► │ corridor ▒ │ ─pick──► │ run ONE  │
  │ route    │               │ view     ▒ │ priority│ build     │
  │ retry    │               └────────────┘  (corr  └────┬─────┘
  └──────────┘                  busyRef=true   first)     │ finally
        ▲                                                 │ busyRef=false
        └──────────────── pump() again (drain) ◄──────────┘
```

The kernel: **lock + pending slots + priority pick + drain-on-finish.** Drop any
one and it breaks — that's the next move.

### Move 2 — the load-bearing skeleton

**Part 1 — the lock (`busyRef`).** First line of `pump`:

```ts
// mobile/src/useTileGraph.ts:166-167
const pump = useCallback(() => {
  if (busyRef.current) return;   // ← already building? bail. THIS is the mutex.
```

What breaks if removed: every pan during a build would launch a parallel build.
Two simultaneous Overpass POSTs from the same IP is exactly what gets you
429'd. The lock is the whole reason builds stay under rate limits.

**Part 2 — the priority pick.** Corridor (an active route) beats viewport (mere
panning):

```ts
// mobile/src/useTileGraph.ts:170-180
if (pendingCorridorRef.current) {            // ① route corridor wins
  kind = "corridor"; req = pendingCorridorRef.current;
  pendingCorridorRef.current = null;
} else if (pendingViewRef.current) {         // ② else the viewport
  kind = "view"; req = pendingViewRef.current;
  pendingViewRef.current = null;
} else { return; }                           // ③ nothing pending → idle
```

What breaks if removed: a user who taps two route endpoints while panning could
have their route starved indefinitely by a stream of viewport requests. Priority
is what guarantees the thing the user is *waiting on* runs first.

**Part 3 — drain on finish (`finally` → `pump()`).** The slot is single-entry,
so something has to re-trigger it:

```ts
// mobile/src/useTileGraph.ts:221-225
} finally {
  busyRef.current = false;     // release the lock
  if (!silent) setLoadingStep(null);
  pump();                      // ← re-enter: run the next pending request
}
```

What breaks if removed: one build runs, the lock releases, and any request that
arrived *during* that build sits in its pending slot forever — the scheduler
deadlocks itself. The recursive `pump()` in `finally` is what makes it a queue
rather than a one-shot.

**Part 4 (hardening, not skeleton) — the pending *slots* collapse work.** Note
the slots are single values, not arrays (`pendingViewRef`, `pendingCorridorRef`).
A newer request overwrites an older un-started one. Combined with the upstream
debounce (`onRegionDidChange`, line 254-255), three fast pans become one build.
This is throughput optimization layered on the skeleton — remove it and the
scheduler still works, it just does more redundant builds.

```
  Execution trace — three fast pans during one in-flight build

  t0  pan A → debounce timer set
  t1  pan B → clearTimeout(A), timer reset        (A's request never forms)
  t2  pan C → clearTimeout(B), timer reset
  t3  timer fires → queueViewport(C) → pendingView = C; pump()
  t4  busyRef already true (build X running) → pump() bails
  t5  build X finishes → finally → pump() → runs C
      result: 3 pans → 1 extra build, not 3
```

### Move 2.5 — current vs future state

This is a one-thread scheduler. The obvious future state is moving the *build* or
the *A\** off the JS thread. What that would cost — and what wouldn't change:

```
  Comparison — today vs an off-thread future

  TODAY                         FUTURE (worker / worklet)
  ─────                         ─────
  build runs on JS thread       build runs on a worker thread
  busyRef boolean is enough     need real message-passing + serialization
  no data races (one thread)    must copy graph across the thread boundary
  pump() unchanged ────────────► pump() unchanged (it just posts a message)
```

The takeaway: `pump()`'s shape survives the move. The lock/priority/drain logic
is transport-agnostic — only the body inside the `try` changes from a direct
`await buildGraph` to `await worker.run(...)`.

### Move 3 — the principle

When you have exactly one scarce resource — here, your free-tier rate budget — you
don't need a thread pool, you need a *single-flight gate with a drain*. The
smallest correct scheduler is a boolean, two slots, a priority rule, and a
recursive re-entry. Everything fancier (real queues, worker pools, backpressure
signals) is earned by having more than one unit of concurrency to manage, and
flattr deliberately has one.

## Primary diagram

```
  pump() — the complete single-flight scheduler

  UI events (producers)                  Orchestration (useTileGraph)
  ┌─────────────────┐  setTimeout 600ms  ┌──────────────────────────────┐
  │ onRegionDidChange├───debounce───────►│ queueViewport → pendingViewRef│
  │ route effect     ├──────────────────►│ ensureBbox → pendingCorridorRef│
  │ self-heal retry  ├──────────────────►│ (silent) → both pending refs   │
  └─────────────────┘                    └───────────────┬───────────────┘
                                                         │ pump()
                                          ┌──────────────▼───────────────┐
                                          │ busyRef? ──yes──► return      │
                                          │   no ↓                        │
                                          │ pick: corridor > view         │
                                          │ busyRef = true                │
                                          └──────────────┬───────────────┘
                                                         │ async (Work layer)
                              ┌──────────────────────────▼──────────────┐
                              │ fetchOverpass → buildGraph → setState    │
                              │ finally: busyRef=false; pump() (drain)   │
                              └──────────────────────────────────────────┘
```

## Elaborate

Single-flight is most famous from Go's `golang.org/x/sync/singleflight` and from
SWR/React Query's request dedup. The shared idea: when many callers want the same
expensive thing, collapse them to one execution. flattr's variant adds *priority*
(corridor over view) because not all builds are equal — one is blocking a user's
route, the others are cosmetic. The pattern generalizes anywhere a scarce
downstream (rate limit, DB connection, GPU) can't take concurrent callers.

## Interview defense

**Q: How does flattr keep from getting rate-limited by Overpass and Open-Meteo?**

A single-flight scheduler — `pump()` in `useTileGraph.ts`. A `busyRef` boolean
guarantees exactly one graph build is in flight; everything else waits in a
single pending slot. Corridor builds (active routes) preempt viewport builds.

```
  the one-liner answer

  many callers ──► [ busyRef lock ] ──► exactly 1 Overpass POST at a time
                        │
                   the rate-limit guard
```

Anchor: *"The load-bearing line is the recursive `pump()` in the `finally` block,
`useTileGraph.ts:224` — without it the scheduler runs one build and then
deadlocks, because the pending slot never gets re-checked."*

**Q: Why a boolean instead of a real queue or mutex library?**

Because there's exactly one resource to protect and one thread accessing it. A
mutex library buys you nothing when there are no other threads to contend with —
the boolean *is* the mutex, and it's race-free because JS is single-threaded.
Anchor: the pending *slots* are single values, not arrays — flattr doesn't even
queue redundant work, it overwrites it.

## See also

- `03-event-loop-and-async-io.md` — why the boolean lock is safe (no preemption).
- `07-backpressure-bounded-work-and-cancellation.md` — what this scheduler does
  *not* do: cancel the in-flight build.
- `04-shared-state-races-and-synchronization.md` — `busyRef` as cooperative state.
- `.aipe/study-networking/` — the rate limits this scheduler exists to respect.
