# Event Loop and Async I/O — scheduling on the one thread

**Industry name:** event loop / cooperative scheduling / async I/O — *Industry standard*.

## Zoom out, then zoom in

The one JS thread from `02` doesn't sit idle waiting for the network — it runs an event
loop that interleaves work. Here's where that loop lives.

```
  Zoom out — the event loop under the app code

  ┌─ App tasks ──────────────────────────────────────────────────┐
  │  pan handler · route handler · geocode typeahead · A* memo   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ all queued onto ↓
  ┌─ Event loop (the one JS thread) ─────────────────────────────┐
  │  ★ macrotask queue (timers, I/O callbacks)                   │ ← we are here
  │  ★ microtask queue (resolved promises) — drained first       │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ await delegates blocking I/O to ↓
  ┌─ Native I/O (off-thread) ────▼───────────────────────────────┐
  │  network sockets · disk · resolve a promise when done        │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question here is **"in what order do tasks run, and what can stall the
loop?"** flattr's answers are concrete — debounce timers gate pan and typeahead work,
`await` chains serialize network I/O, and exactly one task (A\*) is synchronous and can
stall the loop. Name the queues, then find the blocking hazard.

## Structure pass — layers, one axis, the seams

**The layers** are the two queues the loop drains (microtask → macrotask) plus the native
I/O it delegates to. **The axis: "does this task yield the thread, or hold it?"**

```
  Axis: "yield or hold?"  — traced across task types

  ┌─ async task (await chain) ───────────────────┐
  │  fetchOverpass, geocode, sampleElevations     │  → YIELDS at every await
  └────────────────────────────────────────────────┘    (native does the wait)
  ┌─ timer task (setTimeout) ────────────────────┐
  │  debounce 600ms / 400ms, retry 12s, persist 4s│  → YIELDS (fires later)
  └────────────────────────────────────────────────┘
  ┌─ sync CPU task (A*) ─────────────────────────┐
  │  directedAstar in useMemo                     │  → HOLDS until it returns ★
  └────────────────────────────────────────────────┘    the lone blocking hazard
```

**The seam that matters** is `await` itself:

```
  The await seam — where the loop reclaims the thread

  your code         await fetch(...)        native I/O
  ┌──────────┐  ═════╪═════════════════►  ┌──────────────┐
  │ runs ... │      (loop FREE here:      │ socket waits │
  │ pauses   │ ◄═══  microtask resumes    │ resolves ──► │
  └──────────┘       you when it resolves) └──────────────┘
```

Everything async in flattr crosses this seam and frees the loop. The one thing that
*doesn't* is A\*. That contrast is the lesson. Hand off to How it works.

## How it works

### Move 1 — the mental model

You know this from `fetch()` already: when you `await fetch(url)`, the line "pauses" but
your *app* doesn't freeze — clicks still register, spinners still spin. That's the event
loop reclaiming the thread while native waits on the socket. flattr's whole async story is
that primitive, applied repeatedly, plus `setTimeout` to *delay* tasks (debounce) and a
`for` loop with `await sleep()` to *space out* tasks (backoff). The strategy: **never block
the loop on I/O — delegate it and let the loop run other tasks; and shape *when* tasks fire
with timers.**

```
  The event-loop kernel: one thread, two queues, native I/O outside

   ┌──────────────────── JS THREAD ────────────────────┐
   │  [microtasks]  drained fully  →  [macrotasks] one  │
   │   promise .then                  timer / I/O cb    │
   └───────────────────────┬───────────────────────────┘
                           │ await hands off
                           ▼
                  ┌─ native (off-thread) ─┐
                  │ socket / disk waits   │ ──resolves──► enqueues a microtask
                  └───────────────────────┘
```

### Move 2 — the parts, one at a time

**Part 1 — debounce timers shape *when* work fires.** Two of them, both `setTimeout`. Pan
events fire dozens of times a second; you don't want a graph build per event. So the region
handler resets a timer and only acts after motion stops:

```ts
// mobile/src/useTileGraph.ts:245-258 — debounce: collapse a burst of pans into one build
const onRegionDidChange = useCallback((e: RegionEvent) => {
  const { bounds } = e.nativeEvent;
  // ... span/grades guards ...
  if (timerRef.current) clearTimeout(timerRef.current);          // ← cancel the pending one
  timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS); // 600ms
}, [queueViewport]);
```

```
  Debounce — a burst of macrotasks collapses to one

  pan pan pan pan pan ............(quiet)
   │   │   │   │   │
   reset reset reset reset reset
                              └─600ms─► queueViewport fires ONCE
```

The typeahead does the identical move with a 400ms timer (`MapScreen.tsx:73-89`). What
breaks if you remove the `clearTimeout`? Every pan event queues its own build — the pump
serializes them, but you'd do dozens of redundant network builds for one gesture. The
debounce is the first stage of backpressure (see `07`).

**Part 2 — `await` chains serialize network I/O and free the loop.** The pump's body is one
long await chain. Each `await` frees the JS thread while native does the network wait:

```ts
// mobile/src/useTileGraph.ts:184-197 — the async build, each await frees the loop
(async () => {
  try {
    const osm = await fetchOverpass(bbox);          // ← loop free during the fetch
    // ...build elevation provider...
    const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, ..., onPhase);  // ← free again
    // ...store the region...
```

```
  Build task — await points free the loop (other tasks run between)

  pump task: ──fetchOverpass── [await: loop free] ──buildGraph── [await: loop free] ──store──
                                     ▲                                ▲
                              input/timers/render run here, not blocked
```

This is why a network build doesn't freeze the UI even though it's "one task" — it's really
a chain of short synchronous chunks separated by yields.

**Part 3 — backoff loops *space out* I/O on the same thread.** The elevation provider
retries 429s with exponential backoff, using `await sleep()` — a `setTimeout` wrapped in a
promise. This is async-await used to *throttle*, not just to wait:

```ts
// pipeline/elevation.ts:108-119 — retry 429 with exponential backoff, on the same thread
for (let attempt = 0; ; attempt++) {
  const res = await fetchImpl(url);
  if (res.ok) { json = await res.json(); break; }
  if (res.status === 429 && attempt < retries) {
    await sleep(delayMs * 2 ** (attempt + 1));   // ← 800ms, 1600ms, 3200ms... loop free meanwhile
    continue;
  }
  throw new Error(`Open-Meteo elevation: ${res.status}`);
}
```

Overpass does the same with linear backoff (`overpass.ts:42-46`, `delayMs * (attempt + 1)`).
Both batch and space requests (`elevation.ts:121` sleeps between batches) so the free APIs
don't throttle them. The loop is free the entire time — the `sleep` is a timer, not a spin.
What breaks without the backoff? You hammer a throttled API and every request 429s; the
serialized retry *is* the rate-limit compliance.

**Part 4 — the one synchronous hazard: A\*.** Every other task yields. `directedAstar`
doesn't — it's a `while` loop over a priority queue that runs to completion without an
`await` (`astar.ts:48-77`). On the JS thread, inside a `useMemo`:

```
  The blocking hazard — A* holds the thread end to end

  loop: [debounce timer ready][input ready][A* memo recomputes]──────────[finally other tasks]
                                            └─ no await inside; thread held ─┘
        if A* is short (city graph): invisible.
        if A* is long (huge graph):  timers + input wait → visible jank
```

Code: the search loop has no yield point —

```ts
// features/routing/astar.ts:48-77 — synchronous while loop, no await, holds the thread
while (!open.isEmpty()) {
  const current = open.pop()!;
  if (closed.has(current)) continue;
  if (current === goalId) { /* reconstruct + return */ }
  closed.add(current);
  for (const edgeId of graph.adjacency[current] ?? []) { /* relax */ }
}
```

This is the deliberate asymmetry: I/O is async (yields), CPU is sync (holds). It's correct
because A\* over a city graph is fast. The boundary: if the merged graph grew past ~16ms of
search, you'd chunk it (yield every N expansions) or move it to a worker (`02`).

### Move 3 — the principle

The event loop trades parallelism for a guarantee: **tasks run to completion without
interleaving, so you never need a lock — but you must never block.** Async I/O honors the
"never block" rule by delegating the wait to native; timers shape *when* tasks fire;
backoff loops shape *how fast*. The single discipline is "yield often, hold briefly." The
moment one task forgets to yield (A\* on a huge graph), the loop's great strength — no
preemption — becomes its great weakness: that one task starves everything.

## Primary diagram

The whole scheduling picture: queues, the await seam, timers, and the lone sync hazard.

```
  flattr event loop — queues, timers, async I/O, the sync hazard

  ┌──────────────────── JS THREAD (event loop) ────────────────────┐
  │                                                                │
  │  microtasks (promise .then) ─drain fully─►                     │
  │  macrotasks (one per turn):                                    │
  │    ├ debounce 600ms → queueViewport → pump()                   │
  │    ├ debounce 400ms → geocodeSuggest                           │
  │    ├ retry 12s / persist 4s timers                             │
  │    └ A* useMemo recompute ──── SYNC, HOLDS THREAD ★            │
  │                                                                │
  │  await points free the loop ──────────────┐                   │
  └────────────────────────────────────────────┼──────────────────┘
                                               ▼ native (off-thread)
                              ┌─ network: Overpass / Open-Meteo / Nominatim ─┐
                              │  + backoff sleeps space the requests out      │
                              └───────────────────────────────────────────────┘
```

## Elaborate

This is the **Node.js / browser event-loop model** verbatim — microtask queue (promises)
drained before each macrotask (timer / I/O callback). The debounce pattern is the same one
every search box uses; the backoff loop is textbook exponential-backoff-with-jitter (minus
the jitter — flattr's is deterministic). The deeper idea, **cooperative multitasking**,
predates JS by decades (early Mac OS, Windows 3.x) and has the same failure mode flattr's
A\* could hit: one task that won't yield hangs the system. The modern fix — time-slicing a
long computation by yielding periodically — is what React's concurrent mode does for
rendering and what flattr would do for A\* if it grew. For the network-protocol view of
these same calls (TLS, DNS, connection reuse), see `study-networking`; for the rate-limit
strategy as backpressure, see `07`.

## Interview defense

**Q: "How does this app stay responsive while fetching and building graph data?"**

Every network and disk operation is `await`-ed, which frees the single JS thread for input
and rendering while native does the wait. Pan and typeahead bursts are debounced
(`setTimeout`, 600ms / 400ms) so a gesture produces one build, not dozens. Backoff loops
(`await sleep`) space out retries without spinning.

```
  await fetch ──[loop free: input/render run]──► resolve ──► continue
```

*Anchor:* "Async I/O frees the loop; timers shape when work fires; backoff shapes how fast."

**Q: "What could freeze the UI?"**

`directedAstar` — it's the one synchronous task on the thread, a `while` loop with no
`await` (`astar.ts:48-77`). City-sized graphs make it invisible; a large enough graph would
exceed a frame and jank. Fix: yield every N expansions, or move it to a worker.

```
  [A* sync, no yield]─────── thread held ───────► timers + input wait behind it
```

*Anchor:* "The blocking hazard is always the synchronous task that forgot to yield — here
there's exactly one, and I can name it."

## See also

- `02-processes-threads-and-tasks.md` — the one thread this loop runs on.
- `07-backpressure-bounded-work-and-cancellation.md` — debounce + serialized I/O as backpressure.
- `04-shared-state-races-and-synchronization.md` — why no-preemption means no locks.
- `study-networking` (sibling) — the same I/O as protocol behavior (DNS, TLS, retries).
