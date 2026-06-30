# Elevation provider fallback + persistent cache

**Industry names:** provider abstraction / adapter pattern / best-effort with
fallback / read-through persistent cache. **Type:** Industry standard.

---

## Zoom out, then zoom in

Elevation is the one input flattr can't compute itself — it comes from a DEM behind
a rate-limited API. So the elevation layer is built to survive that API being slow,
throttled, or down: one interface, three swappable providers, a best-effort wrapper
that degrades to flat instead of failing the build, and a persistent cache so
revisited areas never hit the network again.

```
  Zoom out — elevation sits inside every graph build, build-time and runtime

  ┌─ Shared pipeline (build-time AND on-device) ────────────────┐
  │  split → ★ ElevationProvider.sample() ★ → grade             │ ← we are here
  │              │                                              │
  │   build-time: Google | Open-Meteo | flat (run-build.ts)     │
  │   runtime:    cached( bestEffort( Open-Meteo ) )            │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼  cache miss
        Open-Meteo / Google Elevation API  (rate-limited, can 429)
```

You've coded against an interface so you could swap the implementation in tests — a
`fetch`-shaped dependency you inject. Same shape: `ElevationProvider` is one method,
`sample(points) → number[]`, and everything else (Google, Open-Meteo, fixture-flat,
the cache wrapper, the best-effort wrapper) is a different object satisfying it. The
question it answers: *how does the system keep producing a usable graph when the one
external data source it depends on fails?*

---

## The structure pass

**Layers:** caller (`sampleElevations`) → cache wrapper → best-effort wrapper → real
provider → network.

**Axis = failure (where does an elevation failure stop, and what does the build get
instead?).**

```
  One question down the layers: "what happens when elevation fetch fails?"

  ┌───────────────────────────────────┐
  │ sampleElevations (caller)         │  → unaware; always gets number[]
  └───────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ cachedElevation                 │  → hits served free; misses passed down
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ bestEffortElevation         │  → CATCHES, returns 0s, flags degraded
          └─────────────────────────────┘
              ┌─────────────────────────┐
              │ openMeteoProvider        │  → 429 backoff, then THROWS
              └─────────────────────────┘

  failure originates at the provider (throw), is CONTAINED at bestEffort (flatten)
```

**Seam = `bestEffortElevation` (`useTileGraph.ts:20`).** The failure-containment
boundary. Below it, `openMeteoProvider` throws on a non-retryable 429
(`elevation.ts:118`). Above it, the caller only ever sees a `number[]`. The wrapper
catches the throw, returns flat zeros, and flips the region's `degraded` flag — that
flag is the seam's contract to the rest of the system (it drives the self-heal retry
and the "approximate grades" note, → `04-honest-fallback-routing.md`).

---

## How it works

#### Move 1 — the mental model

The shape is a stack of decorators around one interface. Each wrapper adds one
behavior — caching, then best-effort — and the innermost real provider does the
network work. Composition reads inside-out: `cached(bestEffort(openMeteo(...)))`.

```
  Pattern — decorator stack over one interface

  sampleElevations
        │ calls .sample(points)
        ▼
  ┌─ cachedElevation ──────────────────┐  serve hits, collect misses
  │   ┌─ bestEffortElevation ────────┐ │  catch failures → flat + flag
  │   │   ┌─ openMeteoProvider ────┐ │ │  batch, 429-backoff, throw
  │   │   │   fetch → DEM          │ │ │
  │   │   └────────────────────────┘ │ │
  │   └──────────────────────────────┘ │
  └─────────────────────────────────────┘
        │ returns number[] (always — never throws to caller)
```

#### Move 2 — the walkthrough

**One interface, three real providers.** The contract is a single method:

```ts
// pipeline/elevation.ts:7 — the whole interface
export interface ElevationProvider { sample(points: LatLng[]): Promise<number[]>; }
```
Build-time picks one by environment, best to worst (`run-build.ts:22`): Google
(paid, needs a key) → Open-Meteo (free, default, 90m DEM) → flat (offline testing).
That's the *provider* fallback — a quality ladder chosen once per build.

**`bestEffortElevation` contains the failure.** The runtime can't fail a build just
because the API is throttled — the streets must still render and connect:

```ts
// mobile/src/useTileGraph.ts:20 — catch → flat → flag
function bestEffortElevation(p, onFallback) {
  return { async sample(points) {
    try { return await p.sample(points); }     // happy path: real elevations
    catch { onFallback(); return points.map(() => 0); }  // throttled → flat + flag degraded
  }};
}
```
What breaks without this wrapper: a single 429 throws out of `buildGraph` and the
whole region fails — no streets, "no route." With it, you get a connected graph with
flat (bogus) grades, marked `degraded` so it self-heals later. **Connectivity over
fidelity, named in the header** (`useTileGraph.ts:17`).

**`cachedElevation` is read-through, keyed to the 90m DEM grid.** Hits cost nothing;
only misses go down the stack:

```ts
// mobile/src/useTileGraph.ts:38 — read-through cache wrapper
points.forEach((pt, i) => {
  const hit = getElev(cellKey(pt.lat, pt.lng));     // ~90m cell key
  if (hit !== undefined) out[i] = hit;              // free
  else { missPts.push(pt); missIdx.push(i); }       // collect misses
});
if (missPts.length) {
  const got = await p.sample(missPts);              // ONE call for all misses (may throw)
  got.forEach((e, j) => putElev(cellKey(...), e));  // cache only real values
}
```
Two design choices worth naming: misses are batched into one downstream call (not N
calls), and *only successfully-fetched values are cached* — flat-fallback zeros
never poison the cache, because they throw before reaching `putElev`.

**The cache persists across restarts, and never invalidates.** `elevCache.ts` mirrors
the in-memory `Map` to AsyncStorage:

```ts
// mobile/src/elevCache.ts:3 — "DEM samples never change → valid forever"
const STORAGE_KEY = "flattr.elevCache.v1";
// :39 writes debounced 4s; :48 cap 50k entries, oldest dropped (Map insert order)
```
No invalidation policy, on purpose — the underlying DEM is genuinely immutable, so
TTLs or busting would be pure overhead (audit lens 4). The cap is a memory safety
valve, not a freshness mechanism.

**Self-heal closes the loop.** A degraded region re-queues itself silently until real
elevation lands or the budget runs out:

```ts
// mobile/src/useTileGraph.ts:209 — bounded silent retry
if (degraded && retryCountRef.current < MAX_RETRIES) {   // MAX_RETRIES = 6
  retryCountRef.current += 1;
  retryRef.current = setTimeout(() => { /* re-queue degraded bbox, silent */ pump(); }, RETRY_MS);
}
```
`covers()` returning `false` for degraded regions (`:83`) is what makes the retry
actually refetch instead of short-circuiting on coverage. The retry is `silent` so
the loading overlay doesn't flash while grades catch up.

The hops, drawn:

```
  Layers-and-hops — a sample() call through the stack

  ┌─ caller ────────┐ hop1: sample(pts)   ┌─ cached ─────────┐
  │ buildGraph      │ ──────────────────► │ hits→out         │
  └─────────────────┘                     │ misses ▼         │
                                          └────────┼─────────┘
                            hop2: sample(misses)   ▼
                                          ┌─ bestEffort ─────┐
                                          │ try ▼  catch→0s  │──flag degraded──►
                                          └────────┼─────────┘   (self-heal +
                            hop3: fetch (may 429)   ▼             "approx" note)
                                          ┌─ openMeteo ──────┐
                                          │ backoff → throw  │──► Open-Meteo API
                                          └──────────────────┘
```

#### Move 3 — the principle

Depend on an external source through an interface, then wrap that interface with the
two behaviors every flaky dependency needs: a cache (so you call it as little as
possible) and a best-effort fallback (so its failure degrades quality, not
availability). The fallback's *flag* is as important as its *value* — flattr's
`degraded` bit is what lets the system both keep working and tell the truth that it's
working in a reduced mode.

---

## Primary diagram

```
  Elevation provider fallback + cache — full pattern

  build-time ladder:  GOOGLE_ELEVATION_KEY → Open-Meteo → FLAT   (run-build.ts:22)

  runtime stack (useTileGraph.ts:191):
  ┌─ cachedElevation ──────────────────────────────────────────┐
  │  hit (90m cell, AsyncStorage-backed) → free                 │
  │  miss ▼ (batched, one call)                                 │
  │  ┌─ bestEffortElevation ────────────────────────────────┐  │
  │  │  try → real elevations                                │  │
  │  │  catch (429/down) → flat 0s + set degraded=true ──────┼──┼─► self-heal retry
  │  │  ┌─ openMeteoProvider ──────────────────────────────┐ │  │   (≤6×, silent)
  │  │  │ batch 100 · 429 exp-backoff · throw on give-up   │ │  │   + "approx" note
  │  │  └──────────────────────────────────────────────────┘ │  │   in UI (04-)
  │  └────────────────────────────────────────────────────────┘  │
  │  cache only REAL values (zeros never stored)                │
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the adapter + decorator pair you'd reach for around any third-party
dependency: an interface to swap implementations, decorators to layer caching and
resilience without touching the core. flattr's `fetchImpl` injection
(`elevation.ts:65`, `:92`) is the same seam that lets tests run without network —
the fixture provider is just another implementation of the one interface
(`elevation.ts:13`).

The `degraded` flag is the through-line to two other patterns: it drives the
display-excludes-degraded merge (`03-tile-merge-stitch.md`) and the "Grades
approximate" UI note (`04-honest-fallback-routing.md`). The HTTP-level retry/backoff
and rate-limit mechanics on the wire → `study-networking`. The cache's
debounce/persist runtime behavior → `study-runtime-systems` and
`study-performance-engineering`.

---

## Interview defense

**Q: Why not just fail the build when elevation is unavailable?**
Because the streets and connectivity don't depend on elevation — only the grade
*coloring* does. Failing the whole build would mean "no map, no route" for a
transient 429. Best-effort returns flat grades + a degraded flag, so you get a
working map now and real grades when the API recovers.

```
  fail-closed:   429 → no graph → "no route"   (bad)
  best-effort:   429 → flat graph + degraded flag → working map, self-heals  (chosen)
```
Anchor: connectivity over fidelity; the flag carries the honesty.

**Q: What's your cache invalidation strategy?**
None — and that's correct. DEM elevation samples don't change between reads, so
cached values are valid forever (`elevCache.ts:3`). The only eviction is a 50k-entry
memory cap, dropping oldest first. A TTL would be overhead protecting against a
change that can't happen.
Anchor: immutable source → no invalidation needed, only a memory cap.

**Q: Why cache only successful values?**
Flat-fallback zeros are wrong data. If you cached them, a revisit would serve the
bogus zeros forever and never self-heal. They throw before `putElev` is reached
(`useTileGraph.ts:53`), so only real elevations persist.
Anchor: never persist a fallback value, or it defeats the self-heal.

---

## See also

- `02-on-device-pipeline-rerun.md` — where this stack runs on-device.
- `03-tile-merge-stitch.md` — degraded regions excluded from the display graph.
- `04-honest-fallback-routing.md` — the "approximate grades" UI surfacing.
- `audit.md` lenses 4, 6 — caching/invalidation, reliability.
</content>
