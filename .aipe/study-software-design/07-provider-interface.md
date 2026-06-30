# 07 — Provider interface (elevation)

**Industry names:** adapter / strategy interface / dependency inversion.
**Type label:** Industry standard.

One interface — `sample(points) → meters` — and four implementations
behind it: a deterministic fixture for tests, Google, Open-Meteo, and
two *decorators* (cache, best-effort) that wrap any of them. The pipeline
never knows which it's talking to.

---

## Zoom out, then zoom in

This is the seam between flattr's graph builder and the outside world's
elevation data. It's what lets the same `buildGraph` run against a real
API in production and a pure function in tests.

```
  Zoom out — where the provider interface sits

  ┌─ PIPELINE / MOBILE (callers) ────────────────────────────────┐
  │  sampleElevations(nodes, provider)   buildGraph(…, elev)      │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ provider.sample(points)
  ┌─ THE SEAM ───────────────────▼──────────────────────────────┐
  │  ★ interface ElevationProvider { sample } ★  elevation.ts:7  │
  └───────────────────────────────┬──────────────────────────────┘
         ┌──────────────┬─────────┴────────┬──────────────────┐
         ▼              ▼                  ▼                  ▼
   fixtureProvider  googleProvider   openMeteoProvider   (decorators:)
   :13 (tests)      :65 (real)       :92 (real, default) cachedElevation,
                                                          bestEffortElevation
                                                          (useTileGraph.ts:20,38)
```

Zoom in: the pattern is **dependency inversion through a one-method
interface.** You've done this every time you typed a function to accept
`{ fetch }` so a test could pass a fake. Here the dependency is "where do
elevation meters come from," and inverting it means the pipeline depends
on the *contract* (`sample`), never on Google or Open-Meteo directly.

---

## Structure pass

**Layers.** Caller (pipeline/mobile) → interface → implementation
(real/fixture) → optional decorators wrapping implementations. The
interface is one method, which is what makes the decorators trivial.

**Axis held constant — "where do elevation meters come from?"**

```
  "what's the elevation source?" — trace across the interface seam

  ┌─ above the seam ──────┐   seam   ┌─ below the seam ─────────────┐
  │ buildGraph just calls │ ════╪═══► │ fixture (pure fn) OR         │
  │ provider.sample(pts)  │ (it flips)│ Google OR Open-Meteo OR      │
  │ — source-blind        │           │ cache(…) OR best-effort(…)   │
  └───────────────────────┘           └──────────────────────────────┘
```

**Seam.** `caller │ ElevationProvider`. Above it, the builder is blind to
the source. Below it, the source can be a deterministic test fixture, a
paid API, a free API, or a cache/fallback decorator stack — and swapping
any of them touches *zero* caller code. → the decorators feed the pump in
`06`.

---

## How it works

### Move 1 — the mental model

The shape: a wall socket. The interface is the two-slot socket
(`sample(points): Promise<number[]>`); fixture, Google, and Open-Meteo are
different appliances that all fit it. And because the socket is *one
method*, you can also build pass-through adapters (a cache, a fallback)
that are themselves sockets-with-a-plug — decorators that wrap one
provider and present the same interface.

```
  Pattern — one interface, plugs and decorators

   interface ElevationProvider { sample(points): Promise<number[]> }
            ▲            ▲            ▲                    ▲
            │ plug       │ plug       │ plug               │ plug+socket
   ┌────────┴──┐  ┌──────┴────┐ ┌─────┴──────┐   ┌─────────┴──────────┐
   │ fixture   │  │ google    │ │ openMeteo  │   │ cachedElevation(p) │ ← wraps a
   │ (pure fn) │  │ (API key) │ │ (free)     │   │ bestEffort(p)      │   provider,
   └───────────┘  └───────────┘ └────────────┘   └────────────────────┘   IS a provider
```

### Move 2 — the walkthrough

**The interface — one method, the whole contract.** `elevation.ts:7-10`:

```ts
// pipeline/elevation.ts:7-10
export interface ElevationProvider {
  /** Elevation in meters for each point, in the same order. */
  sample(points: LatLng[]): Promise<number[]>;
}
```

Bridge: it's the same shape as typing a param `fetcher: (url) =>
Promise<Response>` so you can swap `fetch`. The contract is "give me
points, get meters back in order." **The load-bearing clause is "in the
same order"** — the doc-comment carries it, and every implementation and
every caller relies on positional alignment (point `i` → meters `i`).
Break the ordering in one provider and the grades silently attach to the
wrong nodes. That's the kind of interface comment audit lens 7 praises.

**The fixture — why tests never touch the network.** `elevation.ts:13-19`:

```ts
// pipeline/elevation.ts:13-19
export function fixtureProvider(fn: (lat: number, lng: number) => number): ElevationProvider {
  return { async sample(points) { return points.map((p) => fn(p.lat, p.lng)); } };
}
```

Elevation as a *pure function of lat/lng*. The test suite passes, say,
`(lat) => lat * 1000` and gets deterministic, network-free grades. This
is the whole payoff of the seam: `buildGraph` is testable end-to-end
without a key, a quota, or a flaky API. The provider interface is what
makes the test pyramid possible here.

**The real providers — same contract, different transport.**
`googleProvider` (`elevation.ts:65`) batches 256 points/request against
the Google Elevation API; `openMeteoProvider` (`elevation.ts:92`) batches
100/request against the free Copernicus DEM, with 429-retry and inter-
batch throttling. Both honor the same `sample(points) → number[]`
contract, so the caller swaps them with one line. **The free-tier
realities (batch sizes, retry, throttle) are hidden *below* the seam** —
the pipeline doesn't know Open-Meteo caps at 100/request. That's
complexity pulled downward (audit lens 5).

**The decorators — adapters that are themselves providers.** This is the
part that earns the pattern its file. `cachedElevation` and
`bestEffortElevation` (`useTileGraph.ts:20,38`) each *take* a provider and
*return* a provider:

```ts
// mobile/src/useTileGraph.ts:38-62  (condensed)
function cachedElevation(p: ElevationProvider): ElevationProvider {
  return { async sample(points) {
    // split into cache hits / misses, call p.sample only for misses, cache results
  }};
}
```

Because the interface is one method, you stack them: in the pump
(`useTileGraph.ts:191`) the live build uses
`bestEffortElevation(cachedElevation(openMeteoProvider(...)))` — cache in
front of the real API, best-effort (flat-on-throttle) in front of that.
Each layer is a provider wrapping a provider. **What this buys:** the
cache and the fallback are written *once*, provider-agnostic, and compose
with any source. Swap `openMeteoProvider` for `googleProvider` and the
cache and fallback still work unchanged.

**The one defect this file flags — the duplicated cell-key.** The cache
keys by DEM cell, and the cell-key formula is written in *two* places:
`elevation.ts:42` (`keyOf`, used by `sampleElevations`' dedup) and
`useTileGraph.ts:36` (`cellKey`, used by the cache). Same quantization,
two homes:

```
  elevation.ts:42    `${Math.round(lat / prec)},${Math.round(lng / prec)}`
  useTileGraph.ts:36 `${Math.round(lat / DEDUPE)},${Math.round(lng / DEDUPE)}`
```

They must agree exactly or the runtime cache keys a cell differently than
the build deduped it — silent cache misses, re-fetched data, burned
quota. **The fix:** export one `cellKey(lat, lng, prec)` from
`elevation.ts` (it owns the dedup concept) and have `useTileGraph` import
it. This is audit lens 3's headline leak; it lives here because the cache
*decorator* is where the duplicated formula does its damage.

### Move 3 — the principle

Put a one-method interface between your code and any external source, and
two things become free: tests get a deterministic fake, and you can
*decorate* — caching, fallback, retry — as wrappers that present the same
interface, written once and composed. The narrower the interface (one
method here), the cheaper the decorators. The cost to watch: anything the
implementations must agree on but the interface doesn't enforce (the
cell-key formula) becomes a leak — push those into shared code below the
seam.

---

## Primary diagram

```
  Provider interface — full recap

  ┌─ caller ─────────────────────────────────────────────────────┐
  │  buildGraph(…, provider)  /  sampleElevations(nodes, provider)│
  └──────────────────────────────┬───────────────────────────────┘
                                 │ provider.sample(points) → meters[]
  ┌─ interface ElevationProvider (elevation.ts:7) ───────────────┐
  │  sample(points): Promise<number[]>   /** same order */       │
  └──┬────────────┬─────────────┬───────────────────┬───────────┘
     ▼            ▼             ▼                   ▼
  fixture     google        openMeteo         DECORATORS (wrap a provider):
  :13 tests   :65 key       :92 free,         bestEffort(cached(openMeteo))
                            batch+retry        useTileGraph.ts:191
                                               └ cache keys by DEM cell ⚠
                                                 (cellKey dup: :36 ↔ elevation.ts:42)
```

---

## Elaborate

This is the adapter pattern plus the decorator pattern, unified by a
one-method interface — and it's textbook dependency inversion (depend on
the abstraction, not the concretion). The fixture-as-pure-function trick
is the same instinct as injecting `fetch` for testability; the decorator
stack is the same shape as Express middleware or RxJS operators (each
wraps the next, same interface in and out). The narrowness of the
interface is the enabler: a fat interface would make every decorator
re-implement methods it doesn't care about. The duplicated cell-key is
the cautionary half — a one-method interface can't enforce agreement on a
*data format* the two sides share, so that agreement has to live in shared
code, not in two copies. Read `06` for the pump that composes the
decorators live; read `study-testing` for the fixture-provider as the
backbone of the test suite.

---

## Project exercises

### EX-07-A — Kill the duplicated cell-key (the audit's #1 fix)

- **What to build:** export `cellKey(lat, lng, prec)` from
  `pipeline/elevation.ts`; rewrite `useTileGraph.ts:36`'s `cellKey` and
  `elevation.ts:42`'s `keyOf` to both call it.
- **Why it earns its place:** removes the one real information leak in the
  repo — the formula then lives once, and the cache can't silently drift
  from the build's dedup.
- **Files to touch:** `pipeline/elevation.ts`, `mobile/src/useTileGraph.ts`,
  tests.
- **Done when:** both call sites import one function and a test asserts
  they produce identical keys for the same point.
- **Estimated effort:** 40 min.

### EX-07-B — Add a third decorator

- **What to build:** a `loggingElevation(p)` decorator that counts
  cache-miss network calls, composed into the pump's stack.
- **Why it earns its place:** proves the decorator chain composes — a new
  wrapper drops in with zero changes to the providers it wraps.
- **Files to touch:** `mobile/src/useTileGraph.ts` (or a shared module).
- **Done when:** the stack is `logging(bestEffort(cached(openMeteo)))` and
  builds still work.
- **Estimated effort:** 30 min.

---

## Interview defense

**Q: Why an interface for elevation instead of just calling the API?**

Two payoffs. Testability: `fixtureProvider` makes elevation a pure
function of lat/lng, so `buildGraph` is tested end-to-end with no network,
no API key, no flaky quota. Composability: because the interface is one
method, caching and best-effort-fallback are *decorators* — each wraps a
provider and presents the same interface, so I stack them
(`bestEffort(cached(openMeteo))`) and they work with any source. Swap
Open-Meteo for Google and the cache and fallback don't change.

```
  one-method interface → decorators compose for free
  bestEffort( cached( openMeteo ) )   each layer: provider → provider
       ▲          ▲         ▲
   flat-on-429  skip API   real source
                if cached
```

**Q: What's the weak spot?** The cache keys by DEM cell, and the cell-key
formula is duplicated in `elevation.ts:42` and `useTileGraph.ts:36`. A
one-method interface can't enforce that two sides agree on a *data
format*, so the formula has to move into shared code — otherwise an edit
to one silently breaks cache hits. That's the fix I'd make first.

**Anchor:** "One-method `ElevationProvider.sample` — fixture for tests,
real APIs for prod, and cache/fallback as composable decorators. The
catch: the cell-key formula leaks across two files, which the interface
can't enforce."

---

## See also

- `06-single-flight-graph-pump.md` — composes these decorators live.
- `03-directed-traversal-over-undirected-storage.md` — elevation feeds
  the grades this graph derives direction from.
- `audit.md` lens 3 (the cell-key leak — #1 fix), lens 5 (batch/retry
  hidden below the seam).
