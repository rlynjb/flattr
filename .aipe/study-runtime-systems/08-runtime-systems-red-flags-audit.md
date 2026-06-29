# Runtime Systems — Red-Flags Audit

**Industry name(s):** execution-model risk audit. **Type:** Project-specific.

Ranked by consequence. Each finding names the evidence (`file:line`), the trigger
that makes it bite, and the move. Observed behavior and inference are labelled.
This is the verdict-first companion to `00-overview.md` — the overview maps the
runtime; this file ranks what's wrong with it.

## How to read the ranking

```
  Consequence axis — "what does the user feel when this trips?"

  R1  frozen UI mid-route       ███████████  highest (blocks the thread)
  R2  stale A* blocks a frame   ████████     high
  R3  unbounded memory growth   ██████       medium (long sessions)
  R4  timers leak on unmount    ████         low-medium
  R5  redundant build work      ███          low (wasteful, not wrong)
  R6  whole-blob cache writes   ██           low (scale-only)
```

---

## R1 — A* runs synchronously on the render thread, with no frame budget

**Severity: highest. Observed.**

**Evidence:** `MapScreen.tsx:151-162` — `directedAstar` is called inside a
`useMemo` in the component body. The search loop (`astar.ts:48-76`) is a tight
`while (!open.isEmpty())` with no `await`, no yield, no chunking. The graph-merge
`useMemo`s (`useTileGraph.ts:132-162` → `stitchGraph`, `tiles.ts:45-86`) are
likewise synchronous CPU on the render path.

**What breaks:** the JS thread is blocked for the full duration of the search.
Because it's during render, the next frame can't paint until A* returns. On the
544 KB bundled graph the haversine heuristic keeps expansions low and it's
imperceptible. The exposure is *scale*: a wide corridor merged from many tiles
grows the graph, A* expands more nodes, and the block lengthens — with no ceiling.

**Inference:** there is no frame-budget measurement anywhere in the repo, so the
graph size at which A* drops a frame is unknown and untested. The bench harness
(`bench/`) measures `nodesExpanded`/`pushes`/`pops` for algorithm *correctness and
efficiency*, not wall-clock frame impact on-device.

**The move:** first, measure — instrument `directedAstar` wall-clock against graph
size on-device. Then either move it off-thread (RN worklet / `InteractionManager`)
or add a cooperative yield + iteration-budget bail inside the `while` loop. The
upstream span limit (`07`, bound #3) currently substitutes for this by capping
A*'s *input*; that's a guard, not a fix.

→ deep walk in `03-event-loop-and-async-io.md` and `07-backpressure-bounded-work-and-cancellation.md`.

## R2 — No cancellation: stale A* and stale fetches run to completion

**Severity: high. Observed.**

**Evidence:** no `AbortController` on any `fetch` (`overpass.ts:33`,
`elevation.ts:109`); no abort path inside `directedAstar` or `search`. Stale work
is superseded by React re-rendering from new inputs, not cancelled.

**What breaks:** change an endpoint or `userMax` mid-search and the *old* A* still
finishes — blocking the thread — before the new one starts; React just discards
the stale `useMemo` result. For `fetch` this is harmless (the thread is parked
during I/O). For A* it compounds R1: a superseded search still costs a frame.

**The move:** an iteration-budget / generation-counter bail inside the A* `while`
loop is the cheapest first step (check a "still-current" flag every N pops). Add
`AbortController` to the builds second — lower payoff since I/O already yields.

→ `07-backpressure-bounded-work-and-cancellation.md`.

## R3 — The merged graph / region state has no eviction

**Severity: medium. Observed (the no-cap); inference (the impact).**

**Evidence:** `useTileGraph.ts:107-108, 132-162` — `view` and `corridor` regions
feed the merged-graph `useMemo` with no cap, no LRU, no TTL. Contrast the
elevCache, which *is* bounded at `MAX_ENTRIES = 50000` (`elevCache.ts:9`).

**What breaks:** over a long session spanning a wide area, corridor/region graph
data accumulates in the merged graph and never gets dropped. **Inference:** on a
phone, a long map session could grow the resident graph past comfortable memory;
there's no measurement of session-length memory in the repo. Steady-state is fine
(each pan's old merge becomes garbage), but breadth accumulates.

**The move:** an LRU on region tiles keyed by recency of view, or a hard cap on
merged graph size with eviction of the farthest tiles. Low urgency until a memory
measurement says otherwise.

→ `05-memory-stack-heap-gc-and-lifetimes.md`.

## R4 — Timers are never cleared on unmount

**Severity: low-medium. Observed.**

**Evidence:** `timerRef`, `retryRef` (`useTileGraph.ts`), `suggestTimer`
(`MapScreen.tsx:69`), and `persistTimer` (`elevCache.ts`) use clear-before-set
when *re-arming*, but there is no `useEffect` cleanup clearing them on unmount.

**What breaks:** if the hosting component unmounts with a timer armed, the callback
fires later and may `setState` on an unmounted component (the classic RN warning)
or call `pump()` against torn-down state. **Inference:** low real-world impact
because `useTileGraph`/`MapScreen` effectively live for the app's lifetime, so
unmount is rare. It's a hygiene flag a reviewer would catch.

**The move:** add `return () => { clearTimeout(timerRef.current); clearTimeout(retryRef.current); }`
cleanups to the relevant effects. Small, mechanical.

→ `06-filesystem-streams-and-resource-lifecycle.md`.

## R5 — `indexEdges` rebuilds a full Map on every A* call

**Severity: low. Observed.**

**Evidence:** `astar.ts:35` (and `bidirectional.ts:27`) call `indexEdges(graph)`,
which builds a `Map<string, Edge>` over every edge (`astar.ts:12-16`) on *every*
search. The merged graph also rebuilds entirely on every pan
(`useTileGraph.ts:132`).

**What breaks:** redundant allocation and O(E) work per route, re-done each time
`userMax` or an endpoint changes even though the graph is unchanged. Wasteful, not
incorrect.

**The move:** memoize the edge index alongside the graph (rebuild only when the
graph object identity changes). Minor; only worth it if A* runs hot (see R1's
measurement).

→ `05-memory-stack-heap-gc-and-lifetimes.md`.

## R6 — AsyncStorage cache is a whole-blob read-modify-write

**Severity: low (scale-only). Observed.**

**Evidence:** `elevCache.ts:42-57` — `persistNow` serializes the *entire* Map to
one JSON string under one key on every flush. Load (`loadElevCache`, line 17-29)
reads and parses the whole blob.

**What breaks:** at the 50k cap the blob is small (string keys + numbers, low
single-digit MB), so this is fine today. **Inference:** it wouldn't scale to a
large cache — every flush re-serializes everything, and a partial write on crash
loses the unflushed 4 s window. The debounce (`PERSIST_DEBOUNCE_MS = 4000`) keeps
flush frequency low, which mitigates the write cost.

**The move:** if the cache ever needs to grow past tens of thousands of entries,
move to per-key storage or SQLite. Not warranted now.

→ `06-filesystem-streams-and-resource-lifecycle.md`.

---

## not yet exercised (no finding — named for completeness)

- **Real threads / worker pools** — single-threaded both runtimes. No race risk,
  but also no escape hatch for R1/R2.
- **Locks / atomics / channels** — `busyRef` boolean is the only "lock," safe by
  single-threading. → `04-shared-state-races-and-synchronization.md`.
- **Streaming I/O / stream backpressure** — all I/O is whole-body request/response.
- **Graceful shutdown / signal handling** — build process sets `process.exitCode`
  on error (`run-build.ts:56`); the app is killed by the OS.
- **Manual memory / explicit lifetimes** — GC'd; retention, not allocation, is the
  story (R3).

## The one-line verdict

flattr's runtime is two disciplined single-threaded programs whose backpressure
(debounce + single-flight + backoff) is genuinely well-built — and whose single
real exposure is that the one piece of unbounded, non-yielding, uncancellable CPU
work, A*, sits directly on the render thread (R1+R2). Fix the frame budget there
and the rest are hygiene.

## See also

- `00-overview.md` — the runtime map these risks sit on.
- `03-event-loop-and-async-io.md` — R1's mechanism.
- `07-backpressure-bounded-work-and-cancellation.md` — R2's mechanism.
- `.aipe/study-performance-engineering/` — measuring R1/R5.
