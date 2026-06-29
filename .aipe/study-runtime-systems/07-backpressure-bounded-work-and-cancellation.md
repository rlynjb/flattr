# Backpressure, Bounded Work & Cancellation

**Industry name(s):** bounded concurrency · debounce/throttle · rate-limit
backoff · stale-work supersession (vs cancellation) · capped retry. **Type:**
Industry standard.

## Zoom out, then zoom in

flattr's whole concurrency strategy is about *bounding* — keeping the amount of
network and CPU work small enough to stay under free-tier limits and a phone's
budget. It does this with debounce, single-flight, batch size, backoff, and span
limits. What it deliberately does **not** do is *cancel* in-flight work — stale
work runs to completion and gets superseded, not aborted.

```
  Zoom out — where work gets bounded across the pipeline

  ┌─ UI events ─────────────────────────────────────────────┐
  │  pan/type → DEBOUNCE (600ms / 400ms) → collapse to 1     │ ← bound #1
  └───────────────────────┬───────────────────────────────────┘
  ┌─ Scheduler ───────────▼─────────────────────────────────┐
  │  pump() SINGLE-FLIGHT → 1 build at a time                │ ← bound #2
  │  span limits → refuse too-wide loads/corridors           │ ← bound #3
  └───────────────────────┬───────────────────────────────────┘
  ┌─ Network ─────────────▼─────────────────────────────────┐
  │  BATCH (100/256) + delayMs throttle + EXP BACKOFF on 429 │ ← bound #4
  │  CAPPED retries (1-6) → give up gracefully               │ ← bound #5
  └──────────────────────────────────────────────────────────┘
  ✗ MISSING: cancellation — no AbortController, no A* abort   ← we are here
```

Zoom in: the question is **how does flattr avoid drowning under bursts and
overload, and what happens to work that's no longer needed?** The answer is five
layered bounds and zero cancellation — a deliberate, mostly-fine tradeoff with one
sharp edge (the unbounded A*).

## Structure pass

**Layers.** Two concerns stacked: *throttling the inflow* (debounce + single-flight
+ span limits decide how much work even starts) and *surviving the work that does
start* (batch + backoff + capped retries keep each build from hammering the API).
Cancellation would be a third layer — *stopping work mid-flight* — and it's absent.

**Axis traced — "what bounds this, and what happens at the limit (failure)?"**

```
  One axis — "what's the bound / what at the limit?" — per stage

  pan burst        → debounce 600ms; collapses N pans → 1     (drop extras)
  concurrent builds→ busyRef; hard cap of 1                   (defer, never parallel)
  load/route span  → MAX_LOAD_SPAN / MAX_CORRIDOR_SPAN deg    (refuse, return false)
  elevation reqs   → batch 100 + delayMs + exp backoff on 429 (slow down)
  retries          → capped: Overpass 3, Open-Meteo 1, heal 6 (give up, keep last)
  in-flight build  → NO bound on duration; NO abort           ✗ runs to completion
  A* search        → NO bound on expansions; NO abort          ✗ blocks till done
```

**Seam — the debounce-then-single-flight boundary.** Upstream of it, events arrive
unbounded (drag the map = dozens of `onRegionDidChange`). Downstream, exactly one
build runs. The flip from "unbounded inflow" to "one unit of work" happens across
two collapses: the debounce timer (many events → one queued request) and the
`busyRef` slot (many queued → one running). That double-collapse *is* flattr's
backpressure. → `02-processes-threads-and-tasks.md`.

## How it works

### Move 1 — the mental model

You've bounded inflow before with a search-as-you-type debounce: wait until the
user stops typing, then fire one request instead of one per keystroke. flattr
stacks that idea five deep. And the cancellation gap is the same one most React
apps have: when a debounced fetch finally fires and the inputs already changed,
the old fetch isn't aborted — its result just gets ignored on the next render.
Supersession, not cancellation.

```
  Pattern — bound the inflow, survive the work, supersede the stale

   inflow            running work           stale work
   ┌──────────┐      ┌────────────┐         ┌──────────────┐
   │ N events │─bound│ 1 build     │         │ old result   │
   │ collapse │─────►│ batch+back- │         │ arrives late │
   │ to 1     │      │ off+capped  │         │ → IGNORED by │
   └──────────┘      └────────────┘         │ next render  │
        debounce       throttle/retry        └──────────────┘
                                              (not aborted)
```

### Move 2 — the load-bearing skeleton

The kernel of bounded work here is: **debounce + single-flight + span-limit +
backoff + capped-retry.** Name each by what breaks without it.

**Part 1 — debounce (collapse the burst).** Drop it and every pixel of a pan drag
queues a build:

```ts
// mobile/src/useTileGraph.ts:253-255
if (timerRef.current) clearTimeout(timerRef.current);  // cancel the pending one
timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS); // 600ms
```

What breaks if removed: a 2-second drag fires ~60 region events → 60 build
attempts. Debounce collapses them to the one viewport the user landed on.

**Part 2 — single-flight (cap concurrency at 1).** Covered in depth in file 02 —
`busyRef` ensures one build runs at a time. What breaks if removed: parallel
Overpass POSTs → instant 429.

**Part 3 — span limits (refuse work that's too big to be worth doing).** Two hard
geographic ceilings:

```ts
// mobile/src/useTileGraph.ts:249-251 (viewport)
if (bounds[2]-bounds[0] > MAX_LOAD_SPAN_DEG || ...) return; // zoomed out → load nothing
// mobile/src/useTileGraph.ts:272 (corridor)
if (e-w > MAX_CORRIDOR_SPAN_DEG || n-s > MAX_CORRIDOR_SPAN_DEG) return false; // too far → refuse route
```

What breaks if removed: a world-view pan or a cross-state route would try to fetch
a gigantic bbox — minutes of Overpass, a graph too big for the phone, and an A*
that blocks for ages. The span limit is the bound that keeps the *unbounded* A*
(Part 6) from ever getting a pathologically large graph. That's the quiet
load-bearing connection: flattr bounds A*'s *input size* upstream because it can't
bound A*'s *runtime* directly.

**Part 4 — batch + throttle (rate-limit-friendly network).** Elevation requests
are chunked and spaced:

```ts
// pipeline/elevation.ts:102-121
for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {  // 100 per request
  ...
  if (delayMs && i + OPEN_METEO_BATCH < points.length) await sleep(delayMs); // throttle between batches
}
```

What breaks if removed: one request per point → hundreds of calls → throttled.
Batching is the primary rate-limit defense; the elevCache (file 05) makes most
batches empty on revisit.

**Part 5 — exponential backoff + capped retry (survive a 429, then give up).**

```ts
// pipeline/elevation.ts:114-118
if (res.status === 429 && attempt < retries) {
  await sleep(delayMs * 2 ** (attempt + 1));  // 800ms, 1600ms, ... exponential
  continue;
}
throw new Error(...);  // out of retries → fail this build
```

What breaks if removed without the cap: an infinite retry loop hammering a downed
API. The cap (`retries`, default 3 but set to **1** in the mobile hot path,
`useTileGraph.ts:191`) is the "give up fast and degrade to flat" decision — pair it
with `bestEffortElevation` (line 20-31), which catches the throw and returns
zeros so the build still produces connected streets. The capped self-heal retry
(`MAX_RETRIES = 6`, lines 65, 209-218) then re-queues the degraded region quietly
until grades come back.

```
  Execution trace — Open-Meteo throttled, mobile hot path (retries:1)

  attempt 0 → 429 → sleep 800ms → retry          (attempt < 1)
  attempt 1 → 429 → throw "elevation: 429"        (attempt == retries)
  → bestEffortElevation catches → returns all-0   (degraded = true)
  → build completes with FLAT grades, streets connected
  → schedule self-heal retry in 12s (capped at 6 tries)
  result: no stall, no crash, grades self-heal later
```

**Part 6 — the missing layer: cancellation.** Here's what flattr does *not* do.
Once a build is in flight or A* is running, nothing stops it:

- **No `AbortController` on any `fetch`.** `fetchOverpass` (`overpass.ts:33`) and
  the elevation fetch take no abort signal. Pan away mid-build and the build
  finishes, writes its region, *then* the next pan's build starts.
- **No A\* abort.** `directedAstar` (`MapScreen.tsx:151`) runs to completion in a
  `useMemo`. Change `userMax` or an endpoint mid-search and the old search still
  finishes blocking the thread before the new one starts — React just discards the
  stale `useMemo` result.
- **Supersession instead.** The defense is that stale work is *cheap to ignore*:
  the `useMemo` recomputes from the new inputs, the old region is overwritten in
  its single slot. The work isn't stopped; its output is dropped.

```
  Comparison — cancellation vs flattr's supersession

  CANCELLATION (not built)        SUPERSESSION (what flattr does)
  ─────────────────────────       ──────────────────────────────
  inputs change → abort fetch     inputs change → fetch runs to completion
  → free the thread NOW           → result lands → next render ignores it
  → A* AbortSignal stops loop     → A* finishes, useMemo discards stale value
  costs: plumbing an abort path   costs: wasted work + thread blocked till done
```

The bet: bounds 1-5 keep stale work small and infrequent enough that not
cancelling it is cheap. That holds for `fetch` (the thread is free during I/O
anyway) but is *weakest* for A*, because A* blocks the thread — a superseded A* on
a large graph still janks a frame before its result is thrown away. That's the one
place the no-cancellation choice has teeth.

### Move 3 — the principle

Bounded work and cancellation are two different tools for two different problems.
Bounding controls how much work *starts*; cancellation reclaims work already
*running*. flattr invests entirely in the first — five stacked bounds — and skips
the second, betting that the bounds keep stale work cheap. The bet is sound for
yielding I/O (a stale fetch costs nothing while it's parked) and risky for
non-yielding CPU (a stale A* costs a frame). The general lesson: cancellation
earns its complexity exactly when stale work is *expensive and non-yielding* —
which is precisely flattr's A*, and precisely where it's missing.

## Primary diagram

```
  The full bounded-work stack + the cancellation gap

  EVENTS ──────────────────────────────────────────────────────►
   │ debounce 600/400ms ─ collapse burst → 1            [bound 1]
   ▼
  pump() ─ busyRef ─ 1 build at a time                  [bound 2]
   │ span limits ─ refuse too-wide bbox → false         [bound 3]
   ▼
  fetch ─ batch 100/256 + delayMs throttle              [bound 4]
   │ 429 → exp backoff → CAPPED retry → degrade flat     [bound 5]
   ▼
  build region → setState → useMemo rebuilds graph
   │
   ✗ in-flight build: NOT abortable (no AbortController)
   ✗ A* in useMemo:   NOT abortable (blocks frame, then discarded)
   → stale work SUPERSEDED, not cancelled
```

## Elaborate

The bounding toolkit here is the standard one: debounce (Lodash-era UI), bounded
concurrency (semaphores, p-limit), exponential backoff with cap (AWS SDK, every
robust HTTP client). The supersession-over-cancellation choice is also extremely
common in React land — most apps ignore stale fetch results rather than abort
them, and it's usually fine. The reason it's worth flagging *here* specifically is
the synchronous A*: in a typical app the superseded work is a yielding fetch, so
"don't cancel" is free; in flattr the superseded work can be a thread-blocking
search, so "don't cancel" can cost a visible frame. The fix vocabulary —
`AbortController` for fetch, an iteration-budget check inside the A* `while` loop
that bails when inputs change — is small and well-known; it's just not earned yet
at the current graph size. Cross-link `.aipe/study-performance-engineering/` for
the budget angle and `.aipe/study-networking/` for the retry/backoff angle.

## Interview defense

**Q: How does flattr handle a burst of pan events without melting the rate
limits?**

Five stacked bounds: debounce collapses the burst to one request
(`useTileGraph.ts:254`), single-flight `busyRef` caps builds at one, span limits
refuse too-wide loads, batching + throttle space the elevation calls, and capped
exponential backoff survives a 429 then degrades to flat grades.

```
  the bound stack, one line each

  many pans → [debounce] → 1 → [single-flight] → 1 build →
  [span limit] sane size → [batch+throttle] → [backoff+cap] → done-or-degrade
```

Anchor: *"The clever connection is bound #3 — the span limit caps A*'s **input**
because flattr can't cap A*'s **runtime**. There's no abort inside the search, so
the only way to keep it from blocking the thread is to never feed it a giant
graph."*

**Q: What happens to a build or a route search that's no longer needed?**

It's superseded, not cancelled — that's the deliberate gap. No `AbortController`
on any `fetch`, no abort inside `directedAstar`. Stale work runs to completion and
its result gets ignored on the next render. Anchor: *"That's free for a fetch
because the thread is parked during I/O anyway, but it has teeth for A* — a
superseded search on a large graph still blocks a frame before React throws the
result away. That's the one spot I'd add cancellation first: an
iteration-budget bail inside the `while` loop in `astar.ts:48`."*

## See also

- `02-processes-threads-and-tasks.md` — single-flight, bound #2.
- `03-event-loop-and-async-io.md` — why a superseded A* blocks but a fetch doesn't.
- `08-runtime-systems-red-flags-audit.md` — the no-cancellation risk, ranked.
- `.aipe/study-networking/` — batch/backoff/retry from the protocol side.
- `.aipe/study-performance-engineering/` — the A* frame budget.
