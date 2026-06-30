# 06 — Single-flight graph pump

**Industry names:** single-flight / mutex-guarded work queue / priority drain.
**Type label:** Industry standard (single-flight; the priority-drain shaping is flattr's).

One graph build runs at a time. A `busy` flag guards it, two pending
slots hold the next request, and the corridor (a pending route) always
drains before the viewport (panning). It's a hand-rolled job queue inside
a React hook.

---

## Zoom out, then zoom in

This is the busiest module in the repo (audit lens 1) and the one place
the build pipeline runs *live* on the phone. It's the coordination layer
between user gestures and rate-limited network builds.

```
  Zoom out — where the pump lives

  ┌─ MOBILE UI ──────────────────────────────────────────────────┐
  │  MapScreen: pan event          route button                   │
  └────────┬───────────────────────────┬─────────────────────────┘
           │ onRegionDidChange          │ ensureBbox
  ┌─ useTileGraph (mobile/src/useTileGraph.ts) ──────────────────┐
  │  queueViewport ──► pendingView ─┐                            │
  │  ensureBbox     ──► pendingCorridor ─┐                       │
  │                                  │   │                       │
  │                    ┌─────────────▼───▼──────────┐            │
  │                    │ ★ pump()  :166  ★ ← here   │            │
  │                    │  busyRef guard, corridor   │            │
  │                    │  first, then drain         │            │
  │                    └────────────┬───────────────┘            │
  └─────────────────────────────────┼───────────────────────────┘
                                    │ ONE build at a time
  ┌─ PIPELINE (run live) ──────────▼───────────────────────────┐
  │  fetchOverpass → buildGraph → openMeteo elevation          │
  │  rate-limited free APIs — must not run concurrently        │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **single-flight** — collapse concurrent demand
for the same kind of work into one in-flight execution, queue the rest.
You've hit this whenever two components both triggered the same `fetch`
and you wished only one fired. flattr's version adds a *priority* twist:
two queue slots, and the route corridor always wins over panning.

---

## Structure pass

**Layers.** UI gestures (top) → request slots (`pendingViewRef`,
`pendingCorridorRef`) → the pump (the mutex + drain) → the pipeline (the
actual build). One axis carries the whole design.

**Axis held constant — "is more than one build allowed to run?"**

```
  "can two builds run at once?" — trace across the pump

  ┌─ above the pump ──────┐   seam   ┌─ below the pump ─────────┐
  │ MANY requests fire    │ ════╪═══► │ exactly ONE build runs   │
  │ (every pan, every     │ (it flips)│ (busyRef true → others   │
  │  route)               │           │  wait in pending slots)  │
  └───────────────────────┘           └──────────────────────────┘
```

**Seam.** `requests │ pump`. Above it, demand is unbounded (pan as fast
as you like). Below it, concurrency is exactly one. That flip is the
whole reason the pump exists — the free Overpass/Open-Meteo APIs throttle
under concurrent load, so the seam *converts* bursty demand into serial
execution.

---

## How it works

### Move 1 — the mental model

The shape: a mutex (`busyRef`), two mailboxes for the next job (corridor
and view), and a drain loop that, whenever a build finishes, picks the
*corridor* mailbox first. New requests overwrite their mailbox rather
than stacking — you only ever care about the *latest* viewport, not every
intermediate pan.

```
  Pattern — single-flight with priority drain

   requests:  pan→ [pendingView]   route→ [pendingCorridor]
                       │                      │
                       └──────────┬───────────┘
                                  ▼
                     ┌────────────────────────┐
                     │ pump()                 │
                     │  busy? ── yes ─► return │ ← mutex
                     │   no                    │
                     │   take corridor FIRST,  │ ← priority
                     │   else view             │
                     │   busy=true; build…     │
                     │   finally: busy=false   │
                     │            pump() again │ ← drain
                     └────────────────────────┘
```

### Move 2 — the walkthrough

**The mutex — one boolean stops concurrency.** `useTileGraph.ts:166-167`:

```ts
// mobile/src/useTileGraph.ts:166-167
const pump = useCallback(() => {
  if (busyRef.current) return;   // a build is running → do nothing, it'll re-pump
```

Bridge: this is the `if (loading) return` guard you put on a submit button
so a double-tap doesn't fire two requests — except here the "button" is
every pan and route, and the guard protects rate-limited APIs. **What
breaks without it:** two concurrent `buildGraph` calls, each hammering
Overpass and Open-Meteo, which throttle and 429 — degrading *both* builds
to flat-fallback elevation (`07`). The single boolean is what keeps the
free tier usable.

**Priority — corridor drains before view.** `useTileGraph.ts:170-180`:

```ts
// mobile/src/useTileGraph.ts:170-180  (condensed)
if (pendingCorridorRef.current) {
  kind = "corridor"; req = pendingCorridorRef.current;
  pendingCorridorRef.current = null;        // claim it
} else if (pendingViewRef.current) {
  kind = "view"; req = pendingViewRef.current;
  pendingViewRef.current = null;
} else {
  return;                                    // nothing to do
}
```

Bridge: a strict priority queue with two levels. **Why corridor wins:** a
pending route is a user *waiting for an answer*; a pending viewport is
just cosmetic grade-coloring while panning. Starving the route to keep
repainting the heatmap would be backwards. So corridor is checked first,
unconditionally. **Boundary condition:** because requests *overwrite*
their slot rather than enqueue (`useTileGraph.ts:239`,
`useTileGraph.ts:275` both assign, not push), a flurry of pans collapses
to the latest one — you never build a stale viewport the user already
panned past.

**The drain — re-pump in `finally`.** `useTileGraph.ts:221-225`:

```ts
// mobile/src/useTileGraph.ts:221-225
} finally {
  busyRef.current = false;     // release the mutex
  if (!silent) setLoadingStep(null);
  pump();                      // ← drain: immediately try the next pending
}
```

Bridge: this is the "kick the queue" call at the end of a job worker.
When a build finishes (success *or* failure — it's in `finally`), the
mutex releases and `pump()` is called again, which picks up whatever's
pending (corridor first). **What breaks without the `finally`:** if a
build throws and you released the mutex only on the success path, `busy`
would stick true forever and the pump would deadlock — no further builds
ever run. The `finally` is the load-bearing part that keeps the queue
live through failures.

**The self-heal layer (optional hardening).** On top of the kernel,
`useTileGraph.ts:209-218` re-queues a *degraded* (flat-fallback) region
silently after `RETRY_MS`, capped at `MAX_RETRIES`, so grades self-heal
once the elevation API recovers. This isn't part of the single-flight
kernel — strip it and the pump still works, you just lose automatic
recovery. Naming it as hardening (vs kernel) is the lesson: the mutex +
priority + drain is the irreducible core; the retry loop is a layer on
top.

### Move 2.5 — what the kernel is vs what it isn't

```
  kernel (can't remove)        hardening (can remove, lose a feature)
  ────────────────────────     ──────────────────────────────────────
  busyRef mutex          :167  self-heal retry          :209-218
  corridor-first pick    :170  debounce on pan          :255
  finally → pump drain   :221  silent vs loud loader    :116,196
  overwrite-not-enqueue  :239  best-effort elevation    :191 (→07)
```

Remove anything in the left column and concurrency, priority, or liveness
breaks. Remove anything on the right and you lose a refinement but the
pump still serializes correctly.

### Move 3 — the principle

When demand is bursty but the downstream work must be serialized (rate
limits, exclusive resources, expensive builds), put a single-flight gate
in front: one mutex, latest-wins slots, and a drain that re-fires on
completion. Add priority when some requests are user-blocking and others
are cosmetic. The two parts people forget are the `finally`-drain (or the
queue deadlocks on error) and overwrite-not-enqueue (or you process stale
requests). flattr gets both right.

---

## Primary diagram

```
  Single-flight graph pump — full recap

  ┌─ UI ─────────────────────────────────────────────────────────┐
  │  pan (debounced :255) → queueViewport → pendingViewRef        │
  │  route → ensureBbox → pendingCorridorRef                      │
  └──────────────────────────────┬───────────────────────────────┘
                                 ▼
  ┌─ pump() useTileGraph.ts:166 ─────────────────────────────────┐
  │  busyRef? ─yes─► return (re-pumped later)                     │
  │  pick: corridor FIRST :170, else view                        │
  │  busyRef = true                                              │
  │  ┌─ async build ──────────────────────────────────────────┐ │
  │  │ fetchOverpass → buildGraph → best-effort elevation (07) │ │
  │  │ setView / setCorridor;  degraded? → self-heal retry     │ │
  │  └─────────────────────────────────────────────────────────┘ │
  │  finally: busyRef = false; pump()  ← drain next (corridor 1st)│
  └───────────────────────────────────────────────────────────────┘
       converts bursty UI demand → exactly one build at a time
```

---

## Elaborate

Single-flight is named after Go's `golang.org/x/sync/singleflight` and
shows up everywhere concurrent demand must collapse to one execution:
SWR/React-Query dedupe in-flight fetches, CDNs coalesce origin requests,
databases coalesce identical queries. The flattr variant is a hand-rolled
version because it needs two things off-the-shelf dedupers don't give:
*priority* (route over pan) and *latest-wins overwrite* (panning past a
region cancels its build implicitly). It lives in a React hook, so the
mutex is a `useRef` (survives re-renders without triggering them) rather
than `useState`. Read `07` for the elevation fallback that runs inside
each build; read `study-frontend-engineering` for the hook mechanics and
`study-system-design` for the rate-limit-as-a-system-constraint framing.

---

## Project exercises

### EX-06-A — Prove the priority

- **What to build:** a test that queues a viewport and a corridor while
  `busy` is true, then releases and asserts the corridor builds first.
- **Why it earns its place:** locks in the user-blocking-over-cosmetic
  ordering — the reason the pump exists at all.
- **Files to touch:** a test around `useTileGraph` (or extract `pump` to
  a testable pure module first).
- **Done when:** the corridor-first order is asserted.
- **Estimated effort:** 1.5 hr (extraction is most of it).

### EX-06-B — Break the drain, watch it deadlock

- **What to build:** temporarily move `busyRef.current = false` out of
  `finally` into the success path; write a test where the build throws and
  show the next request never runs.
- **Why it earns its place:** makes the most-forgotten load-bearing line
  (the `finally` release) visible by removing it.
- **Files to touch:** `useTileGraph.ts` (revert after), a test.
- **Done when:** the deadlock is demonstrated, then fixed by restoring
  `finally`.
- **Estimated effort:** 45 min.

---

## Interview defense

**Q: Why hand-roll a queue inside a hook instead of just calling the
build on each pan?**

Because the build hits free Overpass and Open-Meteo APIs that throttle
under concurrent load. Firing one build per pan would run several at once
and 429 them all. The pump serializes to exactly one in-flight build
(`busyRef`), holds only the *latest* pending request per kind
(overwrite-not-enqueue), and prioritizes the route corridor over viewport
panning — because a pending route is a user waiting, a pending viewport
is just heatmap repaint.

```
  the two forgotten load-bearing parts:
  1. finally → pump()   (or the queue deadlocks when a build throws)
  2. overwrite the slot (or you build viewports the user already panned past)
```

**Q: Why corridor before view?** A route is user-blocking; panning grade
colors is cosmetic. If a pan-triggered viewport build is queued ahead of
a route the user just requested, the user waits on cosmetics. So
`pendingCorridorRef` is checked first, always.

**Q: Why `useRef` for `busy` and not `useState`?** The mutex must not
trigger a re-render every time it flips, and it must hold the latest value
synchronously across the async build. `useState` would re-render on every
toggle and could read stale in the closure. `useRef` is the right tool for
mutable-but-not-rendered state.

**Anchor:** "Single-flight in a hook: `busyRef` mutex, corridor-first
drain, re-pump in `finally`. The `finally` is what keeps it from
deadlocking on a failed build."

---

## See also

- `07-provider-interface.md` — the elevation fallback inside each build.
- `05-blocked-as-large-finite.md` — connectivity-over-fidelity, the same
  instinct as flat-fallback elevation.
- `audit.md` lens 1 (highest cognitive load), lens 6 (errors masked low).
