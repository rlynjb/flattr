# Runtime Systems Red-Flags Audit — ranked execution-model risks

**Industry name:** runtime risk audit — *Project-specific*.

## Zoom out, then zoom in

Every prior file taught one mechanism. This one ranks the *risks* those mechanisms carry,
worst-consequence first, each tied to evidence. Here's where the risks sit in the stack.

```
  Zoom out — where the ranked risks live

  ┌─ Render / CPU (JS thread) ───────────────────────────────────┐
  │  #1 sync A* blocks the frame                                 │ ← we are here (all risks)
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ Async coordination ─────────▼───────────────────────────────┐
  │  #2 no cancellation · #3 single-flight lock is thread-bound  │
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ Memory / resources ─────────▼───────────────────────────────┐
  │  #4 graph/cache growth · #5 timers never cleared on unmount  │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question is **"if this app falls over, what falls first?"** The ranking below
answers it by consequence — what actually breaks, for whom, and the file:line that proves
it. None of these are bugs *today* at city scale; they're the load-bearing assumptions that,
once violated, bite in the order listed.

## Structure pass — layers, one axis, the seams

**The axis for an audit is "blast radius":** when this assumption breaks, who notices and how
badly? Trace it across the risks:

```
  Axis: "blast radius when the assumption breaks"

  #1 sync A*        → whole UI freezes (every user, every frame)   ── widest
  #2 no cancel      → wasted fetch + stale flicker (per stale pan)
  #3 thread-bound   → latent: harmless NOW, breaks the day work moves off-thread
     lock
  #4 unbounded      → slow creep over a long session (capped at 50k)
     growth
  #5 timer leak     → fires after unmount (single-screen app → near-zero today) ── narrowest
```

**The seam each risk sits behind** is named in its row. The audit's job is to keep these
ordered by *consequence*, not by how interesting the mechanism is. Hand off to the ranked
findings.

## How it works — the ranked audit

### Move 1 — the mental model

An audit is a triage list: not "here's everything," but "here's what breaks first and why."
Each finding names the assumption, the evidence, the trigger that violates it, and the fix.
The shape:

```
  Audit row kernel — assumption → evidence → trigger → consequence → fix

  [what's assumed safe] ──holds because──► [current condition]
       │ breaks when ──► [trigger]
       ▼
  [concrete consequence] ──► [the move]
```

### Move 2 — the findings, ranked by consequence

---

**#1 — A\* runs synchronously on the JS/render thread.** *Severity: high (latent).*

```
  Risk #1 — the one synchronous CPU task on the render thread

  useMemo recompute ──► directedAstar (while loop, no await) ──► holds JS thread
                              │
                        graph small  → microseconds, invisible
                        graph large  → exceeds 16ms frame → input lag, jank
```

- **Evidence:** `MapScreen.tsx:151-162` (sync call in `useMemo`); `astar.ts:48-77` (`while`
  loop, no yield).
- **Assumption holding it safe:** the merged graph stays city-sized, so one search is well
  under a frame.
- **Trigger:** a graph large enough that one `directedAstar` exceeds ~16ms — wider corridors,
  denser OSM, or routing across a big merged area.
- **Consequence:** the *entire* app freezes during the search (single thread, `02`) — not one
  worker, everything. Slider drags recompute A\* every tick (`05`, Part 1), amplifying it.
- **Fix:** move A\* to a worker (it's already a pure function — `02` Move 2.5), or chunk it
  (yield every N expansions). Cheap first step: hoist `indexEdges` out of the per-call path.

---

**#2 — No cancellation of in-flight work.** *Severity: medium-high.*

```
  Risk #2 — stale builds run to completion

  pan A → build A commits → pan B → A runs FULLY → A's result written → THEN B
                                     ✗ no AbortController to stop A
```

- **Evidence:** grep for `AbortController`/`AbortSignal` returns zero hits; superseded build
  still commits (`useTileGraph.ts:200-205`).
- **Assumption holding it safe:** the 600ms debounce makes superseded builds rare — you
  usually stop panning before a build commits.
- **Trigger:** fast panning, or routing while the previous corridor is still building.
- **Consequence:** wasted Overpass + Open-Meteo round trips on rate-limited free APIs; the
  area you're looking at waits behind the one you left; brief stale-graph flicker as A's
  result paints before B (`07`, Part 6).
- **Fix:** thread an `AbortSignal` through the injectable `fetch` (`overpass.ts:23`,
  `elevation.ts:93`) and abort on supersession — a contained change.

---

**#3 — The single-flight "lock" is a boolean, safe only while single-threaded.**
*Severity: medium (latent, conditional).*

```
  Risk #3 — busyRef is a real lock ONLY on one thread

  if (busyRef) return; busyRef = true;   ← atomic by run-to-completion, NOT by a primitive
       │ breaks the day this work runs on a worker
       ▼ then it's a check-then-act race needing real mutual exclusion
```

- **Evidence:** `useTileGraph.ts:166-182` (boolean guard, no atomic); no `Atomics`/`Mutex`
  anywhere (grep: zero).
- **Assumption holding it safe:** all guarded work runs on the one JS thread, so check-then-set
  can't interleave (`04`).
- **Trigger:** moving builds or A\* off-thread (the same worker move that fixes #1).
- **Consequence:** two builds could pass the guard concurrently; last-to-resolve wins
  non-deterministically; parallel hits on rate-limited APIs.
- **Fix:** when work moves off-thread, replace the boolean with real coordination (a promise
  chain, a worker message queue, or `Atomics`). The point is to *know* this coupling exists
  before someone parallelizes #1.

---

**#4 — In-memory growth: the elevation cache trends toward its cap.** *Severity: low.*

```
  Risk #4 — cache Map grows with roamed area, capped at 50k

  putElev × roaming ──► mem Map grows ──► crosses 50k ──► FIFO trim (05)
   bounded high-water mark, not a leak
```

- **Evidence:** `elevCache.ts:11` (the `Map`), `elevCache.ts:48-52` (the 50k FIFO cap). The
  merged graph itself is bounded per-instant (`05`, Part 2).
- **Assumption holding it safe:** the 50k cap turns the only monotonic grower into a bounded
  one; per-instant graph state is one base + one corridor + one view.
- **Trigger:** a very long session roaming a wide area.
- **Consequence:** memory high-water mark of ~50k cached numbers (low hundreds of KB) —
  bounded; no eviction policy on *loaded tiles* themselves, but slots overwrite so it doesn't
  accumulate.
- **Fix:** none needed at current scale. If true tile roaming became a use case, add an LRU
  over loaded tiles keyed by bbox (the repo already has `PriorityQueue`/`Map` for it).

---

**#5 — Timers are never cleared on unmount.** *Severity: low.*

```
  Risk #5 — setTimeouts outlive the component

  useTileGraph: timerRef / retryRef / persistTimer ── no cleanup return in effects
       │ component unmounts
       ▼ timer fires into a dead component (RN warns; near-zero impact single-screen)
```

- **Evidence:** the debounce/retry timers in `useTileGraph.ts` and `elevCache.ts` are armed
  with `setTimeout` but no `useEffect` cleanup return clears them on unmount (*inference from
  the absence of a cleanup return*).
- **Assumption holding it safe:** flattr is effectively single-screen (`MapScreen` mounts for
  the session), so unmount-during-pending-timer barely happens.
- **Trigger:** adding navigation that unmounts `MapScreen` while a build/retry/persist is
  pending.
- **Consequence:** a timer fires `setState`/`pump` into an unmounted tree — a console warning
  and a tiny wasted build; not a crash.
- **Fix:** return a cleanup from the effects that `clearTimeout` the refs on unmount.

---

### Move 3 — the principle

A runtime audit ranks by **blast radius, not by how clever the bug is.** flattr's #1 (sync
A\* freezing the whole single thread) outranks #5 (a leaked timer that fires a warning)
because the consequence is wider, even though both are "fine today." The through-line across
all five: every one is a *currently-safe assumption with a named trigger* — city-sized
graphs, rare supersession, single-threaded execution, a capped cache, a single screen. None
are bugs now; all are the conditions under which they become bugs. The senior skill an audit
demonstrates is naming the assumption *and* the exact trigger that breaks it — which is what
lets you decide what to fix now (nothing) versus what to watch (graph size → #1, #3).

## Primary diagram

The five risks, ranked, with assumption and trigger — the audit on one page.

```
  flattr runtime risks — ranked by blast radius

  #  RISK                    EVIDENCE              SAFE WHILE...      TRIGGER → fix
  ── ─────────────────────── ───────────────────── ───────────────── ─────────────────────
  1  sync A* freezes thread  MapScreen.tsx:155     graph city-sized   big graph → worker
                             astar.ts:48-77
  2  no cancellation         grep: no Abort*       debounce 600ms     fast pan → AbortSignal
                             useTileGraph.ts:200      makes stale rare
  3  boolean "lock"          useTileGraph.ts:166   work on one thread off-thread → real lock
     thread-bound            grep: no Atomics
  4  cache growth → 50k cap  elevCache.ts:48-52    cap holds          wide roam → LRU tiles
  5  timers not cleared      useTileGraph effects  single-screen app  nav unmount → cleanup
                             (no cleanup return)
```

## Elaborate

The discipline here is **risk triage by consequence**, the same posture a production incident
review takes: rank by impact and likelihood, name the precondition, decide watch-vs-fix.
flattr's audit is unusually clean because the codebase is small and single-threaded — the
risks are all "this safe assumption could break," not "this is broken." That's a healthy
signal: the dangerous codebases are the ones where the audit finds *active* races, leaks, or
unbounded queues. flattr's all sit behind named triggers, which means they're *decisions*
(on-thread A\*, no cancel) made deliberately for a city-scale app, not oversights. The two
worth pre-empting are #1 and #3, because they're *coupled*: the fix for #1 (move A\* to a
worker) is the exact trigger for #3 (the boolean stops being atomic). Whoever parallelizes
the search has to fix the lock in the same change. For the mechanisms behind each risk, the
prior seven files walk them; for how to *verify* a fix didn't regress behavior, see
`study-testing`.

## Interview defense

**Q: "What's the single biggest runtime risk in this app, and why does it rank first?"**

A\* runs synchronously on the JS thread inside a `useMemo` (`MapScreen.tsx:155`). It ranks
first on blast radius: single-threaded means a long search freezes the *entire* UI, not one
worker. It's safe only because the graph is city-sized; a large enough graph exceeds a frame
and janks. The fix is a worker — and it's already a pure function, so it ports cleanly.

```
  sync A* on one thread → whole UI freeze (widest blast radius)
```

*Anchor:* "Rank by blast radius — on one thread, a slow CPU task freezes everything, so it
outranks every async risk."

**Q: "Are any of these risks coupled?"**

Yes — #1 and #3. Moving A\* (or builds) to a worker to fix the freeze is the exact thing that
breaks the single-flight boolean lock, because `busyRef` is only atomic on one thread.
Whoever parallelizes the search has to replace the boolean with real coordination in the same
change.

```
  fix #1 (worker) ──is the trigger for──► #3 (boolean lock no longer atomic)
```

*Anchor:* "The fix for the worst risk is the trigger for another — that coupling is the thing
you flag before anyone parallelizes."

## See also

- `02-processes-threads-and-tasks.md` — risk #1, #3 (the single thread and the worker move).
- `04-shared-state-races-and-synchronization.md` — risk #3 (the boolean lock in full).
- `05-memory-stack-heap-gc-and-lifetimes.md` — risk #4 (the cache cap).
- `07-backpressure-bounded-work-and-cancellation.md` — risk #2 (the cancellation gap).
- `study-testing` (sibling) — verifying a fix doesn't regress runtime behavior.
