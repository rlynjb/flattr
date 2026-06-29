# Degrade-and-surface at the network seam

**Industry names:** graceful degradation with explicit degraded-mode signaling /
fail-open + flag; the "serve stale/approximate, labeled" pattern.
**Type:** Industry standard (graceful degradation), applied repo-specifically to
the elevation dependency.

---

## Zoom out, then zoom in

The one thing flattr depends on that it doesn't control is elevation data, and
the free Open-Meteo API rate-limits under load (429). The naive responses are
both bad: fail the whole build (no map renders) or silently substitute flat data
(the whole map turns green, lying about every grade). flattr takes a third path —
build with flat fallback so the map *works*, but flag the region `degraded` so the
fake grades never paint over real ones and the user sees "approximate."

```
  Zoom out — where the degrade seam sits

  ┌─ Provider (external) ───────────────────────────────────────┐
  │  Open-Meteo Elevation API  →  429 under load                │
  └─────────────────────────────┬───────────────────────────────┘
                                │  HTTP res.status
  ┌─ Build-time (pipeline/) ────▼───────────────────────────────┐
  │  elevation.ts → retry+backoff, then throw on sustained 429  │
  └─────────────────────────────┬───────────────────────────────┘
                                │  throw
  ┌─ On-device (mobile/src/) ───▼───────────────────────────────┐
  │  useTileGraph.ts → ★ bestEffortElevation: catch → flat + ★  │ ← we are here
  │  ★ degraded=true; exclude from display; self-heal retry ★   │
  └─────────────────────────────┬───────────────────────────────┘
                                │  corridorDegraded
  ┌─ UI (mobile/src/) ──────────▼───────────────────────────────┐
  │  MapScreen → RouteSummaryCard note: "Grades approximate…"   │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **degrade-and-surface** — when an upstream fails, keep
working on substitute data, but carry a flag that says the data is substitute, and
let that flag drive both *what you show* and *what you retry*. The flag is the
observability: without it, a 429 is invisible and looks exactly like a
grade-computation bug.

---

## The structure pass

**Layers:** the failure originates at the **provider** (Open-Meteo), is first
handled at **build-time** (retry then throw), caught **on-device** (fallback +
flag), and surfaced at the **UI**.

**Axis traced — "what does a 429 become at each layer?"** Hold it down the stack:

```
  axis = "what happens to the 429?"  — trace it down

  ┌─ provider ──────────────────┐  → emits 429 (res.status)
  └───────────┬──────────────────┘
  ┌─ elevation.ts ──────────────┐  → retries w/ backoff, then THROWS
  │  :114-118                   │     (gives up, propagates the failure)
  └───────────┬──────────────────┘
  ┌─ useTileGraph bestEffort ───┐  → CATCHES, returns flat 0m, sets degraded
  │  :16-31                     │     (failure becomes a flag, not a crash)
  └───────────┬──────────────────┘
  ┌─ display vs routing graph ──┐  → degraded EXCLUDED from display,
  │  :139-162                   │     INCLUDED in routing (connectivity)
  └───────────┬──────────────────┘
  ┌─ MapScreen note ────────────┐  → "Grades approximate — retrying"
  └──────────────────────────────┘
```

**The seam — `bestEffortElevation` at `useTileGraph.ts:16-31`.** The axis flips
hard here: *above* it, a 429 is a thrown exception that aborts; *below* it, the
same 429 is a `degraded` boolean and a build that succeeds with flat data. That
one wrapper is the boundary between "fail-closed" and "fail-open-with-a-flag." It
also flips a second axis — *trust in the data*: above the seam the grades are
real, below it (when degraded) they're known-fake, which is exactly why the
display graph treats the two sides differently.

---

## How it works

### Move 1 — the mental model

You know how a `fetch()` with a `.catch()` lets you render a fallback UI instead
of a blank screen — but a good fallback *tells the user* it's a fallback ("offline
— showing cached data") rather than pretending nothing's wrong? This is that, for
elevation data: catch the failure, substitute flat data so the map builds, and set
a flag that drives an honest "approximate" label plus an automatic retry.

```
  The pattern — failure becomes a flag, flag drives 3 behaviors

   elevation.sample(points)
        │
   ┌────┴──── try ────────────────────────────┐
   │ success → real elevation, degraded=false  │
   │ throw   → flat 0m,        degraded=TRUE    │
   └────┬───────────────────────────────────────┘
        │  degraded flag now drives:
        ├──► EXCLUDE region from display graph (don't paint fake green)
        ├──► INCLUDE region in routing graph  (flat is fine for connectivity)
        └──► RETRY this region in 12s         (self-heal when API recovers)
```

The key insight: the flag isn't just for the UI. The *same* `degraded` boolean
makes three different downstream decisions, each correct for its layer. That's why
it's observability, not just error handling — one signal, read three ways.

### Move 2 — the step-by-step walkthrough

**Layer 1 — build-time retry, then honest throw.** The provider doesn't paper
over the 429; it retries with exponential backoff and then *throws*
(`pipeline/elevation.ts:114-118`):

```typescript
// pipeline/elevation.ts:114-118 (inside the per-batch fetch loop)
if (res.status === 429 && attempt < retries) {
  await sleep(delayMs * 2 ** (attempt + 1));   // exponential backoff
  continue;
}
throw new Error(`Open-Meteo elevation: ${res.status}`);  // give up: propagate
```

Read the choice: it retries a *transient* 429 (backoff buys time for the quota
window to reset), but a *sustained* 429 throws rather than hanging or silently
returning garbage. The throw is deliberate — it hands the decision up to the
caller, who knows whether flat-fallback is acceptable. The test pins it
(`elevation.test.ts:66-70`): with `retries: 0`, a 429 rejects with `/429/`.

**Layer 2 — the catch that turns the throw into a flag.** This is the seam
(`mobile/src/useTileGraph.ts:16-31`):

```typescript
// mobile/src/useTileGraph.ts:16-31
// Connectivity/coverage over fidelity: if the elevation API is down/throttled,
// build with flat (0 m) elevation rather than failing the whole build…
function bestEffortElevation(p: ElevationProvider, onFallback: () => void): ElevationProvider {
  return {
    async sample(points) {
      try {
        return await p.sample(points);   // try real elevation
      } catch {
        onFallback();                    // mark region degraded
        return points.map(() => 0);      // flat fallback so route still builds
      }
    },
  };
}
```

The wrapper is a *decorator* over any `ElevationProvider` — it doesn't know or
care that the failure was a 429; it converts *any* elevation failure into "flat
data + ring this bell." The `onFallback` callback (`:26`) is how the failure
becomes a flag: the caller wires it to `degraded = true` (`useTileGraph.ts:189-193`).
Note the comment's priority order — **connectivity over fidelity**: a route with
fake-flat grades still connects two points; a failed build connects nothing.

**Layer 3 — the flag splits display from routing.** Here's the part that makes it
*observability* rather than just a fallback. The same `degraded` flag drives two
*different* graph compositions (`useTileGraph.ts:139-162`):

```typescript
// routing graph — INCLUDES degraded (flat is fine for connectivity) :135-145
mergeGraphs([baseGraph, ...(corridor ? [corridor.graph] : []), ...(view ? [view.graph] : [])])

// display graph — EXCLUDES degraded (don't paint fake green over real grades) :147-162
mergeGraphs([
  baseGraph,
  ...(corridor && !corridor.degraded ? [corridor.graph] : []),   // skip if degraded
  ...(view && !view.degraded ? [view.graph] : []),               // skip if degraded
])
```

This is the fix for the **"all grades green" incident** (`audit.md` lens 7).
Before this split, a degraded region's all-flat grades rendered as all-green and
*painted over* the real grades. The fix: the heatmap (display) excludes degraded
regions so they show *nothing* rather than *fake green*, while routing still
includes them so excluding them can't reintroduce the "no route" disconnection
bug. One flag, two opposite decisions, each right for its consumer.

```
  Layers-and-hops — one flag, three downstream behaviors

  ┌─ useTileGraph ──────────────────────────────────────────────────────┐
  │  degraded = true  (set by onFallback, :189-193)                     │
  └───────┬───────────────┬───────────────────┬─────────────────────────┘
          │               │                   │
          ▼               ▼                   ▼
  ┌─ display graph ─┐ ┌─ routing graph ─┐ ┌─ retry loop :209-218 ──────┐
  │ EXCLUDE :157    │ │ INCLUDE :140    │ │ re-queue in 12s, capped at  │
  │ (no fake green) │ │ (connectivity)  │ │ MAX_RETRIES; real build stops│
  └─────────────────┘ └─────────────────┘ └──────────────────────────────┘
```

**Layer 4 — self-heal retry.** The flag also schedules its own repair
(`useTileGraph.ts:209-218`): if `degraded`, re-queue the region silently after
`RETRY_MS` (12s), capped at `MAX_RETRIES` so a sustained outage doesn't loop
forever, and a successful (non-degraded) build stops it. The green "self-heals"
once the API recovers — no user action, no loader flash.

**Layer 5 — surface it to the user.** The flag rides out of the hook as
`corridorDegraded` and becomes a card note (`mobile/src/MapScreen.tsx:372-379`):

```typescript
// mobile/src/MapScreen.tsx:374-376  (the note prop of RouteSummaryCard)
note={
  loadingStep ? "Calculating grades…"
  : corridorDegraded ? "Grades approximate — elevation unavailable, retrying"
  : null
}
```

This lands in the same `note` slot of the card that the steep-edge warning uses
(`03-route-honesty-signals.md`) — the two honesty channels share one surface. The
user is never shown approximate grades as if they were real.

### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A try/catch that substitutes safe-default data on
   failure + a flag set in the catch + at least one downstream decision keyed on
   the flag.
2. **Name each part by what breaks without it.**
   - Drop the *catch* (let it throw) → the whole build fails; the map is blank on
     any 429. Fail-closed.
   - Drop the *flag* (catch but don't signal) → the "all grades green" bug
     returns: fake-flat data renders as real, silently lying.
   - Drop the *display/routing split* (use one graph) → either fake green paints
     the map (if you include) or the region disconnects and "no route" returns
     (if you exclude). The flag is what lets you have it both ways.
3. **Skeleton vs hardening.** The kernel is catch + flag + one keyed decision.
   The exponential backoff (`elevation.ts:115`), the capped self-heal retry
   (`useTileGraph.ts:209-218`), and caching are *hardening* — they reduce how
   often you degrade and how long you stay degraded, but the honesty holds with a
   single try/catch and a flag.

The interview payoff: naming that the flag must drive *display exclusion AND
routing inclusion differently* is the non-obvious part. "Just catch and use flat
data" reintroduces one of the two incidents.

### Move 3 — the principle

**When a dependency you don't control fails, degrade to a safe default that keeps
the system working, but carry a flag that says you degraded — and let that one
flag drive every downstream decision.** Fail-open keeps the map alive; the flag
keeps it honest and makes the failure observable. The cost — fake-flat grades for
a few seconds — is bounded by the self-heal retry and clearly labeled, so the user
is never *silently* served bad data.

---

## Primary diagram

The full seam: 429 at the provider becoming a flag that drives display, routing,
retry, and the user note.

```
  Degrade-and-surface — 429 to user note, end to end

  ┌─ Provider ──────────────────────────────────────────────────────────┐
  │  Open-Meteo  →  429 (res.status)                                     │
  └───────┬──────────────────────────────────────────────────────────────┘
  ┌─ Build-time: pipeline/elevation.ts:114-118 ─▼──────────────────────┐
  │  retry w/ exponential backoff → sustained 429 → THROW              │
  └───────┬──────────────────────────────────────────────────────────────┘
  ┌─ On-device: mobile/src/useTileGraph.ts ─────▼──────────────────────┐
  │  bestEffortElevation catch → flat 0m + degraded=true  :16-31,189-93│
  │       │                                                            │
  │       ├──► display graph EXCLUDES degraded  :157  (no fake green)  │
  │       ├──► routing graph INCLUDES degraded  :140  (connectivity)   │
  │       └──► self-heal retry in 12s, capped   :209-218               │
  └───────┬──────────────────────────────────────────────────────────────┘
  ┌─ UI: mobile/src/MapScreen.tsx:374-376 ──────▼──────────────────────┐
  │  corridorDegraded → "Grades approximate — elevation unavailable,    │
  │                      retrying"  (RouteSummaryCard note slot)        │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Graceful degradation with explicit degraded-mode signaling is a CDN/cache idea:
serve stale content when the origin is down, but set `Warning: 110 Response is
Stale` so caches and clients know. The principle is the same — *serving
best-effort data is fine; serving it unlabeled is the bug.* flattr's `degraded`
flag is its `Warning` header. The injectable `fetchImpl` (`elevation.ts:90`) is
what makes the 429 path testable without the network — the same seam that lets you
*reproduce* the incident (`audit.md` lens 2) is the one that lets you *handle* it.

The operational habit behind this whole pattern: **curl the API before debugging
the pipeline** (`context.md:78-80`, project memory). The "all grades green" bug
*looked* like a grade-computation bug; the fast diagnosis was to `curl` Open-Meteo,
see the 429, and know the grades were upstream-fake before reading a line of
grade code. The `degraded` flag is the durable version of that habit — it makes
the upstream failure visible *in the app* so you don't have to curl every time.

The adjacent concept is **route-honesty signals** (`03-route-honesty-signals.md`):
that pattern flags when the *route* is compromised (steep); this one flags when
the *data behind the grades* is compromised (degraded). They share the card's
`note` slot. What to read next:
`study-system-design/05-elevation-provider-fallback.md` for the provider-layering
architecture, then `study-networking` for the 429/backoff transport mechanics.

---

## Interview defense

**Q: The elevation API 429s. What does the user see, and how do you know it
happened?**

The map still renders — `bestEffortElevation` catches the failure and substitutes
flat data so connectivity holds (`useTileGraph.ts:16-31`). But the region is
flagged `degraded`, which does three things: the heatmap *excludes* it so fake-flat
grades don't paint green over real ones (`:157`), routing *includes* it so the
"no route" disconnection bug can't return (`:140`), and a self-heal retry
re-fetches in 12s (`:209-218`). The user sees "Grades approximate — elevation
unavailable, retrying" (`MapScreen.tsx:376`). That note *is* how I know it
happened — the failure is surfaced in-app, not buried.

```
  what the user sees on a 429

   429 → flat fallback + degraded=true
         ├─ heatmap: region blank (not fake green)
         ├─ routing: still works (flat connects)
         └─ card: "Grades approximate — retrying"
```

Anchor: *one flag drives display-exclusion, routing-inclusion, retry, and the
user note.*

**Q: Why not just use flat data silently on failure?**

Because that's the "all grades green" incident. Silent flat data renders as
all-green and paints over the real grades — a graph that looks perfectly flat
everywhere, which is indistinguishable from a grade-computation bug. The fix was
the flag: exclude degraded regions from the *display* graph so they show nothing
rather than fake green, while keeping them in the *routing* graph for
connectivity. The flag is what lets one substitution be correct for routing and
wrong for display at the same time.

Anchor: *fail-open is fine; fail-open *silently* is the bug that turned the map
green.*

---

## See also

- `03-route-honesty-signals.md` — the route-quality sibling; shares the card's
  `note` slot.
- `audit.md` — lens 2 (reproduction via `fetchImpl`), lens 6 (the flag as state
  snapshot), lens 7 (the "all grades green" incident).
- `study-system-design` — `05-elevation-provider-fallback.md` (provider layering).
- `study-networking` — 429 semantics, retry, and exponential backoff at the
  transport layer.
