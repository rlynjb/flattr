# Provider interface

> **Interface / dependency inversion / adapter + decorator**
> — Industry standard. The one-method interface as a deep seam is APOSD.

## Zoom out, then zoom in

The pipeline needs elevation for every node. Where does it come from? At
build time, Open-Meteo's free 90m DEM. With a key, Google's higher-fidelity
API. In tests, a pure function. On-device with a flaky network, a cached
layer that falls back to flat. That's five sources — and the code that turns
nodes into grades doesn't know which one it's talking to. They all hide
behind one method: `sample(points) → number[]`.

```
  Zoom out — the elevation seam

  ┌─ build pipeline / mobile tile build ───────────────┐
  │  buildGraph → sampleElevations(nodes, provider)    │
  └──────────────────────┬──────────────────────────────┘
                         │ provider.sample(points)
  ┌─ ★ ElevationProvider interface (elevation.ts:7) ★ ──┐ ← we are here
  │     sample(points: LatLng[]): Promise<number[]>     │
  └──────────────────────┬──────────────────────────────┘
           ┌─────────────┼─────────────┬───────────────┐
   ┌─ openMeteo ─┐ ┌─ google ─┐ ┌─ fixture ─┐ ┌─ cached / bestEffort ─┐
   │ free 90m    │ │ keyed    │ │ pure fn   │ │ decorators (mobile)   │
   └─────────────┘ └──────────┘ └───────────┘ └───────────────────────┘
```

Zoom in: this is the **deepest kind of interface — one method, many
implementations**, and APOSD's information hiding at a service boundary. The
secret hidden behind `sample` is *everything* about elevation acquisition:
batching, rate limits, retries, API formats, caching, fallback. The caller
(`sampleElevations`) sees only "give me numbers for these points."

## Structure pass

**Layers.** Consumer, interface, implementations (some stacked):
- *Consumer*: `sampleElevations` (`elevation.ts:22`) and `buildGraph`.
- *The seam*: `ElevationProvider` (`elevation.ts:7-10`).
- *Implementations*: `openMeteoProvider`, `googleProvider`, `fixtureProvider`,
  plus `cachedElevation` / `bestEffortElevation` decorators in mobile.

**Axis — "what does the caller know about where elevation comes from?"**

```
  axis = "who knows the elevation source?"

  ┌─ sampleElevations ──────────┐  knows: I get numbers back, in order
  │  dedups, maps onto nodes    │  knows NOTHING about HTTP / keys / DEM
  └──────────┬───────────────────┘
             │ seam: sample(points) → number[]
  ┌─ provider impl ─────────────┐  knows: batch size, retry, URL, JSON shape,
  │  openMeteo / google / cache │         429 backoff, cache cells, fallback
  └────────────────────────────┘

  ALL source knowledge below the seam; the consumer is source-agnostic
```

**Seam.** `ElevationProvider.sample` is the contract: "elevation in meters
for each point, in the same order" (`elevation.ts:9`). Order-preservation is
the load-bearing clause — `sampleElevations` maps results back onto node ids
positionally (`elevation.ts:33-35`), so a provider that reordered would
silently corrupt grades. The axis flips hard: above, zero source knowledge;
below, all of it.

## How it works

### Move 1 — the mental model

You know this exactly from frontend: a `fetcher` prop on a data hook, or
swapping `fetch` for a mock in tests. The component doesn't care if the data
comes from the network, a cache, or a fixture — it calls one function and
gets a promise of data. `ElevationProvider` is that, named: one method,
swappable behind it.

```
  the pattern — one method, swappable behind it

  sampleElevations ──► provider.sample(pts) ──► number[]
                            ▲
       interchangeable: ────┤── openMeteo (real, free)
                            ├── google (real, keyed)
                            ├── fixture (pure, tests)
                            └── cached(bestEffort(openMeteo)) (mobile, stacked)
```

In one sentence: **define the dependency as a one-method interface and inject
the implementation, so the consumer never names a source.**

### Move 2 — the step-by-step walkthrough

#### The interface is three lines

```ts
// elevation.ts:7-10 — the entire contract
export interface ElevationProvider {
  /** Elevation in meters for each point, in the same order. */
  sample(points: LatLng[]): Promise<number[]>;
}
```

One method. The doc comment carries the one non-obvious guarantee
(order-preservation) — exactly the kind of clause only an interface comment
can hold, since nothing in the type enforces it. **What breaks if a provider
violates order?** `sampleElevations` assigns `elevs[i]` to `ids[i]`
(`elevation.ts:34`), so a reordered result attaches the wrong elevation to
every node — and grades, which are elevation differences, all go wrong
silently. The contract is the safety; the type alone isn't enough.

#### The consumer is fully source-agnostic

```ts
// elevation.ts:31-37 — sampleElevations, no-dedup path, annotated
const elevs = await provider.sample(ids.map((id) => ({ lat: ..., lng: ... })));
const out: Record<string, Node> = {};
ids.forEach((id, i) => {
  out[id] = { ...nodes[id], elevationM: elevs[i] };  // positional map-back
});
```

This code works identically whether `provider` is a live HTTP client or a
pure function. It never mentions Open-Meteo, Google, keys, batches, or
retries. **What breaks if the source weren't behind an interface?** Every
test would need a live network and an API key, and you couldn't run the suite
offline. The interface is what makes `fixtureProvider` (`elevation.ts:13-19`)
— "elevation is a pure function of lat/lng" — possible, and that's what
`build-graph.test.ts` uses for deterministic grades.

#### The real adapters hide the messy parts

```ts
// elevation.ts:100-122 — openMeteoProvider.sample, annotated (abridged)
for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {  // 100/request
  const batch = points.slice(i, i + OPEN_METEO_BATCH);
  // ...build URL...
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url);
    if (res.ok) { json = await res.json(); break; }
    if (res.status === 429 && attempt < retries) {
      await sleep(delayMs * 2 ** (attempt + 1));   // exponential backoff
      continue;
    }
    throw new Error(`Open-Meteo elevation: ${res.status}`);
  }
  // ...
}
```

Batching (100 points/request), throttle between batches, 429 exponential
backoff, JSON shape — all hidden behind `sample`. The `googleProvider`
(`elevation.ts:65`) hides a *different* batch size (256), a different URL, a
different JSON shape, and a status check — and presents the identical
interface. `fetchImpl` is itself injected (`elevation.ts:92`) so tests stub
HTTP. **What breaks if these leaked?** The consumer would branch on which API
it's using — the exact source-coupling the interface exists to prevent.

#### Decorators stack on the seam (the mobile depth)

This is the part that shows the interface is genuinely deep — implementations
that *wrap other implementations*, all still `ElevationProvider`.

```ts
// useTileGraph.ts:191-195 — the stack, annotated
const elev = bestEffortElevation(           // outer: catch throttle → flat, flag degraded
  cachedElevation(                          // middle: serve cached cells, fetch only misses
    openMeteoProvider(fetch, { delayMs: 400, retries: 1 })  // inner: real source
  ),
  () => { degraded = true; }
);
```

```
  layers-and-hops — the decorator stack, one request

  ┌─ bestEffortElevation (useTileGraph.ts:20) ─────────────┐
  │  try inner.sample → catch → return all-0, flag degraded│
  └──────────────────────┬──────────────────────────────────┘
              hop: sample(points) — same interface
  ┌─ cachedElevation (useTileGraph.ts:38) ─────────────────┐
  │  hit cache cells → fetch only the misses → cache them  │
  └──────────────────────┬──────────────────────────────────┘
              hop: sample(missesOnly) — same interface
  ┌─ openMeteoProvider (elevation.ts:92) ──────────────────┐
  │  batch · throttle · 429 backoff · parse                │
  └─────────────────────────────────────────────────────────┘
```

Each layer is an `ElevationProvider` wrapping an `ElevationProvider`, adding
exactly one behavior. **What breaks if these were one tangled function instead
of a decorator stack?** Caching, fallback, and HTTP would interleave in one
body — you couldn't test "does the cache serve hits without fetching?" in
isolation, and the fallback's "flag degraded" concern would mix with retry
logic. The shared interface is what lets them compose cleanly. This is the
*deep module deepening by composition* — and the fallback-to-flat decision
feeds pattern `07`'s degraded-region self-heal.

### Move 3 — the principle

A one-method interface is the highest-leverage seam you can build: tiny
surface, unlimited implementations, and the implementations can wrap each
other. The consumer's knowledge of the dependency stops at the method
signature. The general lesson: **the best interfaces are narrow enough that
new implementations — including decorators that compose — cost nothing to
the caller.** Five elevation strategies, one consumer, zero `if (source ===)`.

## Primary diagram

The full seam: one interface, real adapters, a pure fixture, and the mobile
decorator stack.

```
  provider interface — complete

  ┌─ sampleElevations / buildGraph ─────────────────────────────┐
  │  provider.sample(points) → number[]   (source-agnostic)     │
  └───────────────────────────┬──────────────────────────────────┘
                              │ ElevationProvider (elevation.ts:7)
        ┌─────────────────────┼───────────────────┬─────────────┐
  ┌─ fixture ─┐   ┌─ openMeteo ─┐    ┌─ google ─┐   ┌─ DECORATORS (mobile) ─┐
  │ pure fn   │   │ batch 100   │    │ batch 256 │   │ bestEffort(           │
  │ (tests)   │   │ 429 backoff │    │ keyed     │   │   cached(             │
  └───────────┘   └─────────────┘    └───────────┘   │     openMeteo))       │
                                                     └───────────────────────┘
  every box satisfies the same 1-method contract; consumer sees only `sample`
```

## Elaborate

This is the adapter pattern (wrap a foreign API in your interface) plus the
decorator pattern (wrap your interface to add behavior) plus dependency
inversion (the consumer depends on the abstraction, not the concrete source).
It's the cleanest example in the repo of an interface earning its place — and
it's load-bearing for `study-testing/` (the fixture is the determinism seam)
and `study-performance-engineering/` (the cache decorator is the throughput
control).

It feeds pattern `07`: the `bestEffortElevation` decorator's "flag degraded"
callback is what tells the single-flight pump a region was built with fake
flat grades and needs a self-heal retry. Same seam, consumed two layers up.
For the conceptual treatment of interfaces and information hiding, read the
matching `read-aposd` chapter.

## Interview defense

**Q: "Five implementations behind one method — isn't that over-abstraction for
a hobby router? YAGNI says write the Open-Meteo call inline."**

The abstraction pays for itself three times over, and it's *one interface
line*, not a framework. The fixture provider is what makes the whole pipeline
testable offline and deterministically — `build-graph.test.ts` asserts exact
grades because elevation is a pure function of lat/lng, impossible if the HTTP
call were inline. The cache and fallback decorators are what keep the mobile
app usable under Open-Meteo's free-tier throttling — they wrap the *same*
interface, so the consumer didn't change at all when they were added. And
Google vs Open-Meteo is a real fidelity upgrade path. Inline the call and I
lose deterministic tests, offline builds, and the ability to layer caching
without touching `sampleElevations`.

```
  inline openMeteo call         vs     ElevationProvider seam
  ┌──────────────────┐                 ┌──────────────────┐
  │ tests need network│ ✗              │ fixture = offline │ ✓
  │ + API key         │                │ deterministic     │
  │ caching = rewrite │                │ cache = decorator │ ✓
  │ consumer          │                │ consumer unchanged│
  └──────────────────┘                 └──────────────────┘
```

*Anchor: a one-method interface buys deterministic offline tests, a swappable
fidelity source, and composable caching/fallback — for one line of contract.*

**Q: "What's the contract clause people miss, and what breaks if it's
violated?"**

Order preservation — "in the same order" (`elevation.ts:9`). The consumer maps
results back onto nodes positionally (`elevation.ts:34`), so a provider that
returned elevations in a different order would attach wrong elevations to every
node, and since grade is an elevation *difference*, every grade would be wrong
— silently, no error. The type system can't enforce it, so it lives in the
interface comment, which is exactly what interface comments are for.

*Anchor: the load-bearing clause is order-preservation — the consumer maps
back positionally, so reordering corrupts every grade with no error.*

## See also

- `07-single-flight-graph-pump.md` — consumes the degraded flag this seam sets.
- `02-penalty-as-the-domain-seam.md` — the other one-file knowledge boundary.
- `audit.md` Lens 4 (decorators vs pass-throughs), Lens 6 (the masked throttle).
- `study-testing/` — the fixture provider as the determinism seam.
