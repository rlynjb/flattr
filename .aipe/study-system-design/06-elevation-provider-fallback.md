# 06 — Elevation Provider Abstraction & Best-Effort Fallback

*Industry names: provider/adapter pattern + dependency injection · graceful
degradation of a slow dependency · "coverage over fidelity." Type: Industry
standard.*

---

## Zoom out, then zoom in

You've swapped a payment provider behind one interface, or pointed a `fetch` at a
fake in tests via injection — same shape here. Elevation is the one part of the
pipeline that *has* to reach an external API, and it's the make-or-break input
(spec §12: "grade accuracy is the whole product"). flattr hides all of it behind
a single `ElevationProvider` interface so the source is swappable and the failure
mode is contained.

Here's where it sits — one stage of the build DAG, but the only one with a hard
external dependency and three interchangeable implementations:

```
  Zoom out — the elevation seam in the build DAG

  ┌─ BUILD DAG (build-graph.ts) ─────────────────────────────────────┐
  │  parseOsm → splitWays → ★ sampleElevations ★ → computeGrades      │ ← we are here
  └────────────────────────────────┬─────────────────────────────────┘
                                    │  ElevationProvider.sample(points)
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        googleProvider        openMeteoProvider      fixtureProvider
        (paid, best)          (free, default)        (tests / FLAT=0)
              │                     │
              ▼                     ▼
         Google Elevation     Open-Meteo (90m DEM)   ← external HTTP
```

Zoom in: two patterns stacked. First, **provider abstraction** — one interface,
many adapters, chosen at the call site. Second, **best-effort degradation** — at
runtime, wrap the provider so a failed elevation lookup returns flat (0 m)
instead of aborting the whole build. The question both answer: *"how do you
depend on a flaky, rate-limited external API without letting it take down the
system or lock your tests to the network?"*

---

## Structure pass

**Layers.** Two distinct concerns, often confused:

```
  the INTERFACE   — ElevationProvider { sample(points): Promise<number[]> }
  the ADAPTERS    — google / openMeteo / fixture (pick one at the call site)
  the WRAPPER     — bestEffortElevation: catch → return zeros (runtime only)
```

**Axis — failure containment (where does an elevation failure stop?).**

| Layer | What happens when the elevation source fails? |
|---|---|
| adapter (raw) | throws — `Open-Meteo elevation: 429` propagates up |
| build-time caller | the whole `npm run build:graph` aborts (acceptable — rerun it) |
| runtime caller | `bestEffortElevation` catches → 0 m → build *succeeds* flat |

The flip: the *same* provider, called from build vs runtime, has its failure
contained at different boundaries. Offline, a failure should be loud (you want to
know the build is bad before you ship it). On the phone, a failure must be
*silent and degrading* (a blank screen is worse than a flat-graded one). Same
interface, two failure policies — that's the seam worth seeing.

**Seams.** Two. The **interface seam** (`ElevationProvider`) is where the source
is substitutable — tests inject `fixtureProvider`, prod uses `openMeteoProvider`,
and the network is never touched in CI. The **wrapper seam**
(`bestEffortElevation`) is where the failure policy flips from "throw" to
"degrade," and it exists *only* on the runtime side.

---

## How it works

### Move 1 — the mental model

The shape is the adapter pattern you already use: define what you need
(`sample(points) → elevations`), then write one small implementation per source,
and let the caller pick. Layered on top is a decorator that changes one behavior
— catch-and-degrade — without changing the interface. The provider says "here's
how to get elevations"; the wrapper says "...and if that fails, pretend it's
flat."

```
  Pattern — interface + adapters + a degrading decorator

  ElevationProvider (interface)
        ▲           ▲           ▲
        │           │           │
   google      openMeteo     fixture        ← three adapters, same shape
        ▲
        │  wrapped by
   bestEffortElevation(provider)            ← decorator: same interface,
        │   try provider.sample(...)            adds catch → zeros
        │   catch → points.map(() => 0)
        ▼
   caller just sees an ElevationProvider
```

### Move 2 — the walkthrough

#### The interface — the substitution point

One method: `sample(points) → Promise<number[]>`, elevations in the same order
as the points. That's the entire contract. Anything that implements it is an
elevation source, and the build DAG doesn't know or care which.

```
  interface ElevationProvider:
    sample(points: LatLng[]) -> Promise<number[]>   // same order in, same order out
```

The boundary condition that makes this seam real: the `fetchImpl` parameter on
the real adapters is *also* injectable (`googleProvider(key, fetchImpl)`,
`openMeteoProvider(fetchImpl, opts)`). So even within the real provider, the
network call is swappable — tests pass a fake `fetch` and assert on the URL and
the parsed response without a live API. Two levels of injection: swap the whole
provider, or swap just its transport.

#### The three adapters — same shape, different sources

- **`fixtureProvider(fn)`** — deterministic: elevation is a pure function of
  lat/lng. Tests use it; `FLAT_ELEVATION=1` uses `() => 0` for an offline build.
- **`openMeteoProvider`** — the free default. Batches 100 points/request,
  throttles 300 ms between batches, retries 429 with *exponential* backoff. 90 m
  DEM — coarse, which is why grades get clamped downstream (`grade.ts`).
- **`googleProvider(key)`** — the paid fidelity upgrade. Batches 256/request. Only
  used when `GOOGLE_ELEVATION_KEY` is set.

The selection happens at one place, `pickElevation` in the build CLI — a small
factory that reads env and returns the provider plus its tuning (batch dedup,
segment length). The DAG downstream is identical regardless of choice.

```
  pickElevation():
    if GOOGLE_ELEVATION_KEY:  return google (paid, fine segments)
    if FLAT_ELEVATION == 1:   return fixture(()=>0) (offline)
    else:                     return openMeteo (free, 90m → coarse 90m segments)
```

#### The dedup optimization — don't sample finer than the data

Open-Meteo's DEM is ~90 m resolution, so sampling two nodes 5 m apart returns the
*same* elevation and wastes a request. `sampleElevations` with a `dedupePrecision`
coalesces all nodes in the same ~90 m cell into one query, then fans the answer
back out. This is request-coalescing keyed by rounded coordinate — it both keeps
grades physically sane (no spiking at sub-DEM baselines) and stays under the
free-tier rate limit.

```
  sampleElevations(nodes, provider, { dedupePrecision }):
    if no precision:  sample every node (one query per node)
    else:
      group nodes into precision-sized cells          // ~90m grid
      sample ONE representative point per cell         // far fewer queries
      assign each node its cell's elevation            // fan back out
```

#### The degrading wrapper — coverage over fidelity (runtime only)

At runtime, an elevation failure can't be allowed to blank the screen. So
`useTileGraph` wraps the provider in `bestEffortElevation`: try the real sample;
on *any* throw, return 0 m for every point. The streets still render, routing
still connects, and grades fill in on a later load when the API recovers.

```
  Pattern — degrade to flat, don't fail the build

  bestEffortElevation(provider):
    sample(points):
      try:    return provider.sample(points)        // real elevations
      catch:  return points.map(() => 0)            // flat — but the build SUCCEEDS

  effect: a throttled on-device build degrades to a flat-graded (but routable)
          graph instead of leaving the user with nothing.
```

```
  Layers-and-hops — the same provider, two failure policies

  ┌─ BUILD TIME (run-build.ts) ─┐  fail loud   ┌─ openMeteoProvider ──┐
  │ pickElevation() → provider  │ ───────────► │ throws on 429 (×3)   │
  │ failure ⇒ build ABORTS      │ ◄─────────── │                      │
  └─────────────────────────────┘   (rerun it) └──────────────────────┘

  ┌─ RUN TIME (useTileGraph) ───┐  fail soft    ┌─ bestEffortElevation ─┐
  │ wrap provider, retries:1    │ ───────────► │ try → catch → zeros    │
  │ failure ⇒ FLAT graph, ok    │ ◄─────────── │ build SUCCEEDS flat    │
  └─────────────────────────────┘ (degraded)   └────────────────────────┘
```

### Move 3 — the principle

Hide a flaky external dependency behind a narrow interface so the source is
swappable and the network is injectable — then decide the *failure policy at the
call site*, not inside the dependency. The same provider can fail loud offline
(you want to catch a bad build) and fail soft on-device (you want a degraded
answer over no answer). The interface makes substitution cheap; separating the
failure policy from the provider makes both policies possible without forking the
code.

---

## Primary diagram

The whole elevation seam, one frame — interface, adapters, selection, dedup, and
the two failure policies.

```
  Elevation provider & fallback — full recap

  ┌─ ElevationProvider interface ── sample(points) → Promise<number[]> ──┐
  └──────▲────────────────▲──────────────────▲──────────────────────────┘
         │                │                  │
    fixtureProvider  openMeteoProvider   googleProvider
    (tests/FLAT=0)   (free, 90m, 429     (paid, fidelity)
                      retry+throttle)         │
         ▲                ▲                   ▲   fetchImpl injectable on all
         │                │                   │   (tests pass a fake fetch)
         └──── pickElevation() picks by env ──┘  (build-time)
                          │
                          ▼
            sampleElevations(nodes, provider, { dedupePrecision })
              └─ coalesce same-90m-cell nodes → one query → fan out
                          │
        ┌─ build time ────┴──────────── run time ─┐
        ▼                                          ▼
   failure ⇒ throw ⇒ build aborts        bestEffortElevation: catch ⇒ 0m
   (loud — rerun build)                  ⇒ flat-but-routable graph (soft)
```

---

## Implementation in codebase

**Use cases.** Build time: `pickElevation` selects Open-Meteo by default so a
contributor with no API key can build the graph for free. Tests: every pipeline
test injects `fixtureProvider` so the suite is deterministic and offline. Runtime:
when you pan past the bundled bbox and Open-Meteo is throttled,
`bestEffortElevation` keeps the new streets on screen (flat-graded) instead of
failing the pan.

**The interface + injectable transport — `pipeline/elevation.ts` (lines 7-19,
64-66, 92-95).**

```
  export interface ElevationProvider {
    sample(points: LatLng[]): Promise<number[]>;   ← the whole contract: order in = order out
  }
  export function fixtureProvider(fn): ElevationProvider { ... }       ← deterministic (tests)
  export function googleProvider(apiKey, fetchImpl = fetch): ... { }   ← fetchImpl injectable
  export function openMeteoProvider(fetchImpl = fetch, opts = {}): ... { }
       │
       └─ two injection levels: swap the provider, OR swap just fetchImpl. The
          comment at line 2 says it: tests use fixtureProvider; googleProvider
          is "never called by the suite."
```

**The selection factory — `pipeline/run-build.ts` (lines 22-38).**

```
  function pickElevation(): Picked {
    if (process.env.GOOGLE_ELEVATION_KEY)
      return { provider: googleProvider(key), ..., maxSegM: MAX_SEGMENT_M };   ← paid, fine (12m)
    if (process.env.FLAT_ELEVATION === "1")
      return { provider: fixtureProvider(() => 0), ... };                      ← offline flat
    return { provider: openMeteoProvider(),
             sampleOpts: { dedupePrecision: 0.0008 }, maxSegM: 90 };           ← free, coarse (90m)
  }
       │
       └─ note maxSegM tracks the source: 12m for fine Google data, 90m for the
          coarse DEM. Splitting finer than the DEM would manufacture noise — the
          segment granularity is matched to the data fidelity on purpose.
```

**The retry/backoff inside the free adapter — `pipeline/elevation.ts` (lines
99-125).**

```
  const delayMs = opts.delayMs ?? 300;   ← throttle between batches (free-tier friendly)
  const retries = opts.retries ?? 3;     ← retry 429s
  for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {   ← 100/request
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url);
      if (res.ok) { json = ...; break; }
      if (res.status === 429 && attempt < retries) {
        await sleep(delayMs * 2 ** (attempt + 1));   ← EXPONENTIAL backoff on 429
        continue;
      }
      throw new Error(`Open-Meteo elevation: ${res.status}`);   ← give up ⇒ throw (loud)
    }
    if (delayMs && more) await sleep(delayMs);       ← pace between batches
  }
```

**The degrading wrapper + fail-fast tuning — `mobile/src/useTileGraph.ts` (lines
18-28, 111).**

```
  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return {
      async sample(points) {
        try { return await p.sample(points); }       ← real elevations
        catch { return points.map(() => 0); }        ← degrade to flat (don't fail the build)
      },
    };
  }
  ...
  const elev = bestEffortElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 }));
       │
       └─ retries:1 (vs 3 at build time): on a phone, fail FAST and degrade to
          flat rather than stall the screen on doomed 429 backoffs. Coverage > fidelity.
```

**The dedup — `pipeline/elevation.ts` (lines 22-60).**

```
  export async function sampleElevations(nodes, provider, { dedupePrecision }) {
    if (!prec) { /* one sample per node */ }
    const keyOf = (lat, lng) => `${round(lat/prec)},${round(lng/prec)}`;  ← ~90m cell key
    // one representative point per cell:
    for (id of ids) if (!repByKey.has(keyOf(...))) repByKey.set(...);
    const elevs = await provider.sample([...one per cell...]);            ← far fewer queries
    for (id of ids) out[id] = { ...n, elevationM: elevByKey.get(keyOf(...)) }; ← fan back out
  }
       │
       └─ request-coalescing keyed by rounded coordinate: stays under the rate
          limit AND avoids manufacturing grade noise below the DEM resolution.
```

---

## Elaborate

This is the adapter (or "ports and adapters" / hexagonal) pattern plus a decorator
for the failure policy — bread-and-butter for any system that depends on a
third-party API it doesn't control. The two design moves that make it good here
are the injectable `fetchImpl` (the network is a parameter, so tests are fast and
hermetic — see `.aipe/study-networking/` for the wire-level retry/backoff) and
the separation of *failure policy* from *provider*. Most codebases bake the
failure behavior into the client; flattr keeps the provider dumb (it throws) and
puts the policy at the call site (build aborts vs runtime degrades). That's why
the same `openMeteoProvider` serves two opposite reliability requirements without
a branch inside it.

The "coverage over fidelity" call (`useTileGraph.ts:16-17`) is the interesting
product judgment. Grade accuracy is supposedly the whole product (spec §12) — so
degrading to *flat* (zero grade) seems to throw away the value. But the
alternative on a throttled phone is a blank area, which is worse: the user can't
even see the streets. So the runtime accepts temporarily-wrong grades to keep the
map usable, and the comment promises grades "fill in on a later load when the API
recovers." It's the right call for a transient failure on a live map; it would be
the *wrong* call at build time, which is exactly why the loud-vs-soft split exists.

The dedup is a small but real systems detail: it ties three things together — the
DEM resolution (90 m), the edge-split granularity (`maxSegM=90` for the free
source), and the elevation dedup cell (`0.0008°` ≈ 90 m). All three are matched
so the pipeline never computes grade over a baseline finer than the data
supports. Mismatch them and you get spiky, fake-looking grades at cell
boundaries — the exact failure the spec warns about (§11.A, §11.C).

Read next: `05-honest-fallback-routing.md` — the sibling honest-degradation
pattern at the routing layer (return a flagged route, don't refuse).

---

## Interview defense

**Q: How do you test a pipeline that depends on an elevation API?**
> The API is behind an `ElevationProvider` interface, and tests inject
> `fixtureProvider` — elevation as a pure function of lat/lng — so the suite is
> deterministic and never touches the network. Even the real providers take an
> injectable `fetchImpl`, so I can test the Open-Meteo batching and 429 backoff
> against a fake `fetch` and assert on the URL and parsing. Two levels of
> injection: swap the whole provider, or just its transport.

```
  ElevationProvider ── fixtureProvider (tests, deterministic)
                    ── openMeteo(fetchImpl=fakeFetch) (test the adapter, no network)
```

**Q: The API is rate-limited and sometimes down. What happens?**
> It depends on *where* it's called, and that's deliberate. At build time the
> provider throws on persistent failure and the build aborts — loud, because I
> want to catch a bad graph before shipping it; I just rerun the build. At runtime
> the provider is wrapped in `bestEffortElevation`, which catches and returns 0 m
> for every point, so the build *succeeds* with flat grades — the streets still
> render and routing still connects, and real grades fill in on a later load. Same
> provider, two failure policies, set at the call site.

```
  build time: throw → abort (loud, rerun)
  run time:   catch → flat → succeed (soft, degrade) — coverage > fidelity
```

**Q: You degrade to flat — doesn't that defeat the product (grade is the whole
point)?**
> For a *transient* runtime failure, no — the alternative is a blank area, which
> is strictly worse: the user can't even see the streets. Temporarily-wrong
> (flat) grades on a usable map beat a correct map of nothing, and it self-heals
> on the next load. At *build* time I'd never do this — a permanently flat graph
> shipped to users would be the product lying, so the build fails loud instead.
> The split is the point.

```
  transient + runtime  ─► flat now, correct later  (usable beats blank)
  permanent + build    ─► fail loud  (never ship a lying graph)
```

---

## Validate

1. **Reconstruct.** Draw the interface, the three adapters, and the
   `bestEffortElevation` decorator (`elevation.ts:7-19`,
   `useTileGraph.ts:18-28`). Name what each adapter is for.
2. **Explain.** Why does the build use `retries: 3` (`elevation.ts:97`) but the
   runtime use `retries: 1` (`useTileGraph.ts:111`)? What does fail-fast buy on a
   phone?
3. **Apply.** You pan to a new area and Open-Meteo returns 429 on every retry.
   Trace what `bestEffortElevation` returns (`useTileGraph.ts:21-25`), what
   `computeGrades` then produces (`grade.ts:27-30`), and what the user sees.
4. **Defend.** Justify the "coverage over fidelity" runtime choice
   (`useTileGraph.ts:16-17`) against the spec's claim that grade accuracy is the
   whole product (§12). Where is degrading-to-flat correct, and where would it be
   a lie?

---

## See also

- `03-on-device-pipeline.md` — where `bestEffortElevation` is wired into the
  runtime build.
- `05-honest-fallback-routing.md` — the sibling honest-degradation pattern.
- `audit.md` §6 (failure handling).
- `.aipe/study-networking/` — Overpass/Open-Meteo retries, backoff, the
  `fetchImpl` seam on the wire.
- `.aipe/study-data-modeling/` — how `elevationM` becomes signed `gradePct`.
