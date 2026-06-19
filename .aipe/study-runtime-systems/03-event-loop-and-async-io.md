# Event loop and async I/O

*Event loops, queues, microtasks, async I/O, and blocking hazards.*
**Type:** Industry standard (the JS event loop + async/await).

## Zoom out, then zoom in

The single thread from `02-` doesn't sit idle while it waits on the
network — it parks the awaiting task and runs other tasks. The thing that
makes that work is the **event loop**, and flattr leans on it in exactly
two places: the pipeline's fetch-and-backoff loops, and the app's
debounce/retry timers. Everything else is synchronous and never touches
the loop's queues at all.

```
  Zoom out — where async I/O lives in the system

  ┌─ BUILD process ──────────────────────────────────────────┐
  │  ★ fetchOverpass / sampleElevations: await + setTimeout ★ │ ← we are here
  │    CPU stages (parse/grade): synchronous, no loop involved │
  └──────────────────────────────────────────────────────────┘

  ┌─ RUN process ────────────────────────────────────────────┐
  │  ★ pump() fetch, geocode, retry backoff: await+setTimeout★│ ← and here
  │    astar / nearestNode / geojson: synchronous              │
  └──────────────────────────────────────────────────────────┘

   no Promise.all, no Promise.race, no queueMicrotask, no
   process.nextTick — the loop is used plainly
```

Zoom in: the question is *what does flattr put on the event loop, and
when does it accidentally block it?* The answer: it puts sequential
`await`ed fetches and `setTimeout` sleeps on it — and it blocks it in the
one place from `02-`, the synchronous search.

## Structure pass

**Layers.** The async machinery nests:

```
  Layered decomposition — "where does this work resume?"

  ┌───────────────────────────────────────────────┐
  │ outer: the event loop (timers, I/O callbacks)  │ → resumes on a later tick
  └───────────────────────────────────────────────┘
      ┌─────────────────────────────────────────┐
      │ middle: the microtask queue (promises)    │ → resumes after THIS task,
      └─────────────────────────────────────────┘    before the next tick
          ┌─────────────────────────────────────┐
          │ inner: the synchronous call stack     │ → runs now, no resume
          └─────────────────────────────────────┘

  "where does it resume?" — later tick / end of this task / never (sync)
```

**Axis — guarantees (sync vs async).** Trace "is this work deferred or
immediate?" `await fetch(...)` defers — the continuation is a microtask
that runs when the promise settles. `setTimeout(fn, ms)` defers harder —
`fn` is a macrotask that runs on a future loop tick. A plain function
call is immediate — it runs on the current stack, blocking everything.

**Seam.** The load-bearing boundary is **`await` ↔ synchronous CPU**.
Cross an `await` and the thread is freed for other tasks; stay in
synchronous code and the thread is pinned. flattr's blocking hazard lives
exactly at the synchronous side of this seam (the search), and its
politeness lives at the async side (the backoff sleeps).

## How it works

### Move 1 — the mental model

You know the shape from any `fetch().then()` chain: the request goes out,
your thread doesn't block, and a callback fires later when the response
lands. `async/await` is the same machine with nicer syntax — `await`
*is* a `.then()`, and the code after it *is* the callback. The event loop
is the dispatcher that decides which settled callback runs next.

```
  Pattern — the event loop's two queues + the stack

   ┌─ call stack ─┐   runs synchronous code NOW
   │  astar()     │   (blocks the loop while it runs)
   └──────┬───────┘
          │ stack empties
          ▼
   ┌─ microtask queue ─┐  promise continuations (await resumes)
   │  fetch .then       │  drained FULLY before any macrotask
   └──────┬─────────────┘
          │ empty
          ▼
   ┌─ macrotask queue ─┐  setTimeout callbacks, I/O events
   │  backoff sleep     │  one per loop tick
   └────────────────────┘

   key rule: a synchronous task on the stack blocks BOTH queues
```

### Move 2 — walk the mechanism

**A sequential fetch loop parks the thread, batch by batch.** The
elevation provider doesn't fire all its requests at once — it walks
batches of 100 points, `await`ing each before the next. Between batches it
*sleeps* on a `setTimeout`-backed promise to stay under the free-tier
rate limit.

```
  Execution trace — openMeteoProvider.sample over 250 points

  step  loop activity              event-loop state
  ────  ─────────────────────────  ────────────────────────────
  1     batch 0 (pts 0-99)         await fetch → thread freed
  2     response lands             microtask resumes, push elevs
  3     sleep(300ms)               macrotask scheduled, thread freed
  4     batch 1 (pts 100-199)      await fetch → thread freed
  5     response lands             resume, push elevs
  6     sleep(300ms)               thread freed
  7     batch 2 (pts 200-249)      await fetch → resume → done
        (no trailing sleep — last batch)
```

The thread is free during every `await` and every `sleep` — the build
process could do other work, but it has none, so it just waits. That's
fine: it's offline.

**Retry-with-backoff is a loop that re-schedules itself on the macrotask
queue.** On a 429, the provider doesn't give up and doesn't busy-wait — it
`await`s a `setTimeout` whose delay *doubles* each attempt, then loops
back to retry the same batch.

```
  Pattern — exponential backoff as a self-rescheduling loop

  attempt 0: fetch → 429 → sleep(delay·2¹)  ─┐
  attempt 1: fetch → 429 → sleep(delay·2²)  ─┤ each sleep is a
  attempt 2: fetch → 429 → sleep(delay·2³)  ─┤ macrotask; thread
  attempt 3: fetch → ok  → break             ┘ free between them

  the doubling spaces retries out so a throttled server recovers
  (protocol-level detail → study-networking)
```

**The two geocode lookups are sequential on purpose, not in parallel.**
When you route From→To, `handleRoute` `await`s the From geocode, *then*
the To geocode. You could `Promise.all` them for half the latency — but
Nominatim's policy is ~1 req/sec, so sequential is deliberate politeness,
not an oversight (the code comments say exactly this).

```
  Comparison — what flattr does vs the "faster" alternative

  flattr (sequential):   await From ──► await To       (~2 round-trips)
  Promise.all (faster):  await [From, To] together      (~1 round-trip)
                         └─ but violates Nominatim ~1 req/sec → bans you

  the slower path is the correct one here
```

**The debounce defers the *trigger*, not the work.** A pan fires
`onRegionDidChange` many times; the handler clears and resets a 600ms
`setTimeout` each time, so the actual fetch only fires once the user stops
moving. Same pattern for autocomplete (400ms). These are macrotasks that
*collapse a burst of events into one task*. (This is the frontend-side
debounce; see also
[`.aipe/study-frontend-engineering/`](../study-frontend-engineering/) if
present.)

**The one blocking hazard: synchronous CPU never yields to the loop.**
`directedAstar` and `nearestNode` are not `async`. While they run, the
microtask and macrotask queues are both stalled — a pending fetch
continuation can't resume, a queued timer can't fire. On the build
process nobody notices; on the app, this *is* the freeze from `02-`.

```
  Layers-and-hops — a blocked loop during a sync search (run process)

  ┌─ JS thread ────────────┐ hop1: setUserMax → render
  │ React commit            │ ───────────────────────────┐
  └────────────┬────────────┘                            ▼
               │                          ┌─ call stack ─────────────┐
               │                          │ directedAstar (sync)      │
               │                          │ ◄── BLOCKS the loop ──►    │
  ┌─ microtask q ───────────┐             └────────────┬──────────────┘
  │ pending fetch .then      │ ◄── cannot run until ────┘
  └──────────────────────────┘     the stack empties

   the search starves every queued continuation for its whole duration
```

### Move 3 — the principle

`await` is a yield point; a synchronous function is not. The event loop
keeps a single thread responsive *only* if every task is either short or
punctuated by `await`s. flattr's I/O is well-behaved (sequential, backed
off, polite) precisely because it's all `await`-punctuated. Its one
liability is the CPU work that has no `await` in it — the loop can't help
you if you never give it the thread back.

## Primary diagram

The full async picture: what flattr puts on each queue and the one thing
that blocks them all.

```
  flattr on the event loop — queues, what's on them, the blocker

  ┌─ CALL STACK (synchronous, blocks everything) ────────────┐
  │  parseOsm · splitWays · computeGrades · buildAdjacency    │
  │  directedAstar · nearestNode · graphToGeoJSON  ★ BLOCKER ★ │
  └───────────────────────────────────────────────────────────┘
            │ stack must empty before queues drain
  ┌─ MICROTASK QUEUE (promise continuations) ────────────────┐
  │  await fetchOverpass · await provider.sample · await geocode│
  └───────────────────────────────────────────────────────────┘
  ┌─ MACROTASK QUEUE (timers) ───────────────────────────────┐
  │  sleep(300ms) backoff · debounce(600ms) · suggest(400ms)  │
  └───────────────────────────────────────────────────────────┘

  well-behaved: all I/O is await/timer (yields the thread)
  hazard: the CPU stack work has no yield → starves both queues
```

## Implementation in codebase

**Use cases.** The async loop matters whenever flattr talks to the
network: building a tile in `useTileGraph`, geocoding an address,
sampling elevation. The blocking hazard matters whenever a synchronous CPU
function runs long on the app's thread.

The elevation fetch loop — sequential batches, backoff, inter-batch
sleep — is the clearest example:

```
  pipeline/elevation.ts  (lines 100-122, condensed)

  for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {  ← one batch at a time
    const batch = points.slice(i, i + OPEN_METEO_BATCH);
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url);            ← yields thread to event loop
      if (res.ok) { json = await res.json(); break; }
      if (res.status === 429 && attempt < retries) {
        await sleep(delayMs * 2 ** (attempt + 1)); ← macrotask; doubling backoff
        continue;                                   ← retry SAME batch
      }
      throw new Error(...);                          ← give up: non-retryable
    }
    if (delayMs && i + OPEN_METEO_BATCH < points.length) await sleep(delayMs); ← inter-batch throttle
  }
        │
        └─ every `await` here frees the JS thread. The sleeps are deliberate
           rate-limit politeness, not latency bugs — drop them and Open-Meteo
           429s you (see the project's open-meteo-rate-limit memory note).
```

The deliberate sequential geocode, with the reason in a comment:

```
  mobile/src/MapScreen.tsx  (lines 173-185, condensed)

  const a = await geocode(from, { viewbox });      ← From: await fully first
  if (!a) { setRouteError("From not found"); return; }
  ...
  const b = await geocode(to, { viewbox });        ← THEN To, sequential
  // ^ comment: "sequential: Nominatim allows ~1 req/sec"
        │
        └─ Promise.all would halve latency but violate the 1-req/sec policy.
           The slower path is the correct one — async correctness over speed.
```

The mobile fetch loop fails *fast* on elevation so a throttled build
degrades quickly instead of stalling the screen on backoff:

```
  mobile/src/useTileGraph.ts  (lines 109-112)

  // Fail-fast elevation (few retries) so a throttled build degrades to flat quickly
  const elev = bestEffortElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 }));
        │
        └─ retries:1 (vs the pipeline default of 3) — on the interactive runtime
           you'd rather show flat-grade streets now than block on doomed 429
           backoffs. The event-loop math (fewer macrotask sleeps) is the point.
```

## Elaborate

The event loop is what lets one thread serve thousands of in-flight I/O
operations — it's why Node won the "C10k" conversation and why the
browser never needed threads for network work. The catch is the one
flattr hits: the loop is **cooperative**. It can only switch tasks at
yield points, so a single long synchronous function defeats the entire
model. The professional reflex is to treat any `while` loop over a
non-trivial data structure on the interactive thread as suspect, and
either bound it or chunk it with `await`. Read `07-` for the bounded-work
framing, and `04-` for the one place flattr coordinates *across* async
tasks (the `pump()` gate).

## Interview defense

**Q: "How does the pipeline avoid hammering the elevation API?"**

Three things, all on the event loop. Batches of 100 points, `await`ed one
at a time so they're sequential not concurrent. A 300ms `setTimeout` sleep
between batches as a steady throttle. And exponential backoff on 429s —
each retry `await`s a doubling delay before re-firing the same batch
(`elevation.ts:100-122`). Every one of those is an `await`, so the thread
is free throughout.

```
  batch → sleep(300) → batch → sleep(300) → ...
   429 → sleep(600) → sleep(1200) → ... (backoff)
```

Anchor: *"It's all `await`-punctuated, so politeness costs the build wall
time but never blocks the thread."*

**Q: "Where could a synchronous function block the loop, and why does it
matter?"**

`directedAstar` and `nearestNode` — neither is `async`, so while they run
the microtask and macrotask queues both stall (`astar.ts:48`,
`nearest.ts:8`). On the build process that's invisible. On the app it
freezes React, because the search runs in a render-time `useMemo`
(`MapScreen.tsx:143`).

```
  sync search on stack ──► queues frozen ──► no fetch resume, no timer fire
```

Anchor: *"A function with no `await` is invisible to the event loop — it
just holds the thread."*

## Validate

**Reconstruct.** Draw the stack + two queues and place each flattr
operation: which queue does `await fetch` resume on, which does
`setTimeout` use, and what blocks both? (Microtask; macrotask; the
synchronous call stack.)

**Explain.** Why is the inter-batch `sleep(300)` in `elevation.ts:121`
*not* a performance bug? (Rate-limit politeness; removing it triggers 429s
and the slower backoff path — net slower and risks a ban.)

**Apply.** The route-search freezes the app for 150ms. Show how to keep
the loop responsive without a worker. (Chunk the `astar.ts:48` `while`
loop: run K expansions, then `await new Promise(r => setTimeout(r, 0))` to
hand the thread back to the loop, then continue.)

**Defend.** Justify the sequential geocode over `Promise.all`
(`MapScreen.tsx:181`). (Nominatim's ~1 req/sec policy; parallel risks a
ban. Correctness-of-citizenship beats one round-trip of latency.)

## See also

- `02-processes-threads-and-tasks.md` — why the sync blocker matters
- `04-shared-state-races-and-synchronization.md` — the pump() async gate
- `07-backpressure-bounded-work-and-cancellation.md` — chunking + bounds
- [`.aipe/study-networking/`](../study-networking/) — retry/backoff at the protocol layer
