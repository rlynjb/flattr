# Elevation batching + dedup — bounding the build-time I/O cost

**Industry name:** request batching + resolution-aware deduplication + retry-with-
backoff + graceful degradation.
**Type:** Industry standard.

---

## Zoom out, then zoom in

The CPU cost of flattr is the search, and the search is cheap. The *expensive*
thing is build-time I/O: turning a bbox of streets into a grade-annotated graph
means asking an external elevation API for the height of every node. Do that
naively — one HTTP request per node — and a few thousand nodes is a few thousand
round-trips, which is slow and instantly trips the free-tier rate limit. The whole
elevation layer exists to make that I/O *bounded and cheap*: batch many points per
request, never sample finer than the data's own resolution, throttle and retry,
and if the API still says no, fall back to flat rather than fail.

Here's where it sits — the I/O-bound stage of the build pipeline, behind the
network boundary.

```
  Zoom out — the build-time I/O stage

  ┌─ pipeline / mobile build ──────────────────────────────────────┐
  │  Overpass (streets) → split edges → ★ sampleElevations ★ → grade │ ← here
  │                                       → buildGraph → graph.json   │
  └───────────────────────────────┬─────────────────────────────────┘
                                   │  Network boundary (rate-limited, free tier)
  ┌─ Open-Meteo Elevation API (Copernicus 90m DEM) ▼───────────────┐
  │  POST batches of ≤100 points → elevation[] in order             │
  └─────────────────────────────────────────────────────────────────┘
```

The pattern: **batch + dedup + backoff + degrade.** Four independent moves, each
cutting a different cost: batch cuts round-trips, dedup cuts redundant points,
backoff survives throttling, degrade survives failure.

## Structure pass

Trace the **cost axis** — "how many external requests does N nodes cost?" — across
the layers.

```
  One question down the layers: "what does N nodes cost in API requests?"

  ┌─ naive ───────────────────────────────────────────┐
  │ one request per node                                │  → N requests
  └───────────────────────┬─────────────────────────────┘
                          │  cost drops at the dedup seam
  ┌─ sampleElevations (dedup to DEM cells) ▼────────────┐
  │ collapse nodes in the same ~90m cell → unique points │  → U requests' worth
  └───────────────────────┬──────────────────────────────┘    (U ≤ N, often ≪ N)
                          │  cost drops again at the batch seam
  ┌─ openMeteoProvider (batch 100/request) ▼────────────┐
  │ ceil(U / 100) HTTP round-trips                       │  → ⌈U/100⌉ requests
  └────────────────────────────────────────────────────────┘
```

**Axis = cost (external requests).** Naive is `N`. The dedup seam
(`sampleElevations`) drops `N → U` by recognizing that two nodes 10 m apart get
the *same* answer from a 90 m DEM — so why ask twice. The batch seam
(`openMeteoProvider`) drops `U → ⌈U/100⌉` by packing 100 points per HTTP call.
The two seams are independent and multiply: a 1600-node neighborhood that dedups
to ~400 unique cells becomes ~4 HTTP requests instead of 1600.

**The load-bearing seam is the `ElevationProvider` interface.** It's a vertical
seam between the *sampling policy* (dedup, which nodes to ask about) and the
*transport* (batch, backoff, which API). That seam is why `bestEffortElevation`
can wrap *any* provider to add degradation without touching either side — the
contract is just `sample(points) → number[]`.

## How it works

### Move 1 — the mental model

You know how you'd batch DB writes instead of one `INSERT` per row, and how you'd
dedup a list before hitting an API? This is both, plus a retry wrapper. The key
insight that makes dedup *correct* (not just an optimization): the elevation data
is a 90 m grid, so any two points inside the same 90 m cell return the same
number. Sampling both is pure waste.

The shape — fan a node list down through dedup and batching to a few requests:

```
  Batch + dedup — N nodes → few requests

  N nodes ──► dedup to DEM cells ──► U unique points ──► batch by 100 ──► ⌈U/100⌉ requests
   1600          (90m grid)              ~400                                   ~4
     │                                                                          │
     └── then fan the U answers back out to all N nodes (cell → elevation map) ─┘
```

### Move 2 — the step-by-step walkthrough

#### Part 1 — dedup to DEM resolution (`sampleElevations`)

Group nodes by which ~90 m grid cell they fall in (`keyOf` rounds lat/lng to the
dedup precision). Keep one representative point per cell, sample only those, then
map each cell's answer back to *every* node in it. **Drop dedup and you sample
every node** — many of them returning identical values from the same DEM cell,
burning requests for no extra fidelity. The precision is chosen to *match* the
data (`DEDUPE = 0.0008` ≈ 90 m, `useTileGraph.ts:33`); sampling finer than the DEM
is sampling noise.

```
  Dedup — one query per DEM cell, fanned back out

  nodes:   n1 n2 n3   n4 n5    n6
  cell:    [ A  A  A ][ B  B ][ C ]    ← keyOf(lat,lng) buckets
  sample:    A          B       C      ← 3 queries, not 6
  fan out: n1..n3 ← elev(A);  n4,n5 ← elev(B);  n6 ← elev(C)
```

#### Part 2 — batch per request (`openMeteoProvider`)

Walk the unique points in chunks of 100 (`OPEN_METEO_BATCH`), join their
lat/lngs into one URL, get back an `elevation[]` array in the same order.
**Drop batching and each point is its own HTTP round-trip** — 100× the requests,
100× the latency, and far over the rate limit. Order preservation is the
load-bearing detail: the response array index must line up with the input point
index, or every node gets the wrong height.

```
  Batch — 100 points, one round-trip, order preserved

  points[0..99]  ─join lat,lng─►  GET /elevation?latitude=...&longitude=...
                 ◄─elevation[]─   [e0, e1, ..., e99]   (index i ↔ point i)
```

#### Part 3 — throttle + exponential backoff

Between batches, sleep `delayMs` (free-tier friendly). On a 429, retry with
`delayMs * 2^attempt` backoff up to `retries` times. **Drop the backoff and one
429 fails the whole build**; drop the throttle and back-to-back batches trip the
limit you were trying to avoid. This is the I/O equivalent of the search's bounded
work — pace the requests so the API stays happy.

```
  Backoff — retry a 429, doubling the wait

  batch → 429 → sleep(delay·2¹) → retry → 429 → sleep(delay·2²) → retry → ok
                                                  (give up after `retries`)
```

#### Part 4 — graceful degradation (`bestEffortElevation`)

The mobile layer wraps the real provider: if `sample` throws (API down or
throttled past retries), return all-zero elevations instead of propagating the
error. **Drop this wrapper and a throttled elevation API fails the entire graph
build** — no streets, no routing, blank screen. With it, the streets render and
routing connects at flat grade; the real grades fill in on a later load when the
API recovers. The repo states this priority explicitly: connectivity/coverage over
fidelity.

```
  Degrade — flat beats failed

  real provider.sample(points)
       ├─ ok ───────────────► real elevations
       └─ throws (429/offline) ─► points.map(() => 0)   ← flat, but the build SUCCEEDS
```

#### Execution trace — a 6-node tile with one cell collision

```
  Trace — sampleElevations with dedup, 6 nodes → 3 unique cells

  step  action                                   state
  ────  ───────────────────────────────────────  ────────────────────────────
   1    keyOf each node (prec=0.0008)             n1,n2→"A"  n3,n4→"B"  n5,n6→"C"
   2    repByKey: first node per cell             A:n1  B:n3  C:n5
   3    provider.sample([n1,n3,n5])               batch of 3 → [120, 135, 118]
   4    elevByKey                                  A:120  B:135  C:118
   5    fan out to all 6 nodes                     n1,n2=120  n3,n4=135  n5,n6=118
        → 3 queries served 6 nodes (50% saved on this tiny example)
```

### Move 2.5 — current state vs fidelity upgrade

**Now:** free Open-Meteo, 90 m Copernicus DEM. **Coarse:** 90 m smooths short
steep pitches — a one-block 12% ramp can read flatter than it is.

```
  Phase A (now)                    Phase B (fidelity upgrade)
  ──────────────                   ──────────────────────────
  openMeteoProvider                googleProvider (already written,
  90m DEM, free, no key              elevation.ts:65-83) — needs API key
  → coarse grades                  or LIDAR source
  → dedup precision 90m            → finer DEM → smaller dedup precision
  the SAME ElevationProvider       → MORE unique points → MORE requests
  interface — swap the provider,   the cost axis moves: better fidelity
  nothing else changes             costs more I/O (the seam makes the
                                   tradeoff a one-line swap)
```

What doesn't change: the interface, the dedup logic, the batching, the backoff.
The provider is swappable behind `ElevationProvider` — the fidelity/cost tradeoff
is a single constructor choice.

### Move 3 — the principle

The general lesson: **for I/O-bound work, the win isn't faster code — it's fewer,
bigger, smarter requests.** Batch to amortize per-request overhead, dedup against
the *resolution of the answer* (asking finer than the data can answer is pure
waste), pace yourself to live within limits, and degrade rather than fail when the
dependency is down. The dedup move specifically — "don't sample finer than your
data" — generalizes anywhere a downstream has a coarser resolution than your
inputs: image thumbnails, time-series rollups, geohash bucketing.

## Primary diagram

The full I/O pipeline — sampling policy, transport, resilience, all behind one
interface.

```
  Elevation batching + dedup, end to end

  ┌─ sampleElevations (sampling POLICY) ───────────────────────────┐
  │  N nodes → keyOf(lat,lng, prec≈90m) → U unique DEM cells        │ ← dedup seam
  │  sample(U representative points)  →  fan U answers back to N     │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  ElevationProvider interface (the swap seam)
  ┌─ bestEffortElevation (resilience wrapper) ▼────────────────────┐
  │  try real.sample(points)  catch → points.map(()=>0)  (degrade)  │
  └───────────────────────────────┬─────────────────────────────────┘
  ┌─ openMeteoProvider (TRANSPORT) ▼───────────────────────────────┐
  │  chunk by 100 → GET /elevation → elevation[] (order preserved)  │ ← batch seam
  │  throttle delayMs · retry 429 with delay·2^attempt backoff      │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │  Network boundary
  ┌─ Open-Meteo (Copernicus 90m DEM, free) ▼───────────────────────┐
  └─────────────────────────────────────────────────────────────────┘

  cost: N nodes → U unique → ⌈U/100⌉ requests  (two multiplying reductions)
```

## Implementation in codebase

**Use cases in this repo.** Two: (1) the **offline build** (`npm run build:graph`,
`pipeline/run-build.ts`) that produces `mobile/assets/graph.json`; (2) the
**in-app tile builds** in `useTileGraph.ts` that fetch new areas as the user pans
or routes — these are the ones that must stay under the free rate limit live.

**Dedup to DEM resolution** (`pipeline/elevation.ts`):

```
  pipeline/elevation.ts  (lines 42-59)

  const keyOf = (lat, lng) => `${Math.round(lat/prec)},${Math.round(lng/prec)}`;  ← DEM cell
  const repByKey = new Map();
  for (const id of ids) {
    const n = nodes[id];
    const k = keyOf(n.lat, n.lng);
    if (!repByKey.has(k)) repByKey.set(k, { lat: n.lat, lng: n.lng });   ← one rep per cell
  }
  const elevs = await provider.sample([...repByKey.values()]);           ← sample uniques only
  ...
  for (const id of ids)
    out[id] = { ...n, elevationM: elevByKey.get(keyOf(n.lat, n.lng))! }; ← fan back to all nodes
       │
       └─ the round-to-cell key is the whole dedup: two nodes in the same ~90m cell
          share one query. `prec` comes from DEDUPE=0.0008 in useTileGraph.ts:33,
          deliberately matched to the 90m DEM — finer would sample noise and burn
          requests. Without this, a dense 1600-node tile is 1600 points sampled.
```

**Batch + backoff transport** (`pipeline/elevation.ts`):

```
  pipeline/elevation.ts  (lines 85, 100-122)

  const OPEN_METEO_BATCH = 100;   ← Open-Meteo allows up to 100 locations/request
  ...
  for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {
    const batch = points.slice(i, i + OPEN_METEO_BATCH);
    const lats = batch.map(p => p.lat).join(",");        ← pack 100 into one URL
    const lngs = batch.map(p => p.lng).join(",");
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url);
      if (res.ok) { json = await res.json(); break; }
      if (res.status === 429 && attempt < retries) {
        await sleep(delayMs * 2 ** (attempt + 1));        ← exponential backoff on throttle
        continue;
      }
      throw new Error(`Open-Meteo elevation: ${res.status}`);
    }
    for (const e of json.elevation) out.push(e);          ← order preserved: index i ↔ point i
    if (delayMs && i + OPEN_METEO_BATCH < points.length) await sleep(delayMs);  ← throttle between
  }
       │
       └─ batch (×100 fewer requests) + throttle (stay under rate) + backoff (survive
          429s). The `out.push` in response order is load-bearing: scramble it and
          every node gets a neighbor's elevation → wrong grades everywhere.
```

**Graceful degradation wrapper** (`mobile/src/useTileGraph.ts`):

```
  mobile/src/useTileGraph.ts  (lines 18-28)

  function bestEffortElevation(p: ElevationProvider): ElevationProvider {
    return {
      async sample(points) {
        try { return await p.sample(points); }
        catch { return points.map(() => 0); }   ← API down/throttled → flat, don't fail the build
      },
    };
  }
       │
       └─ wraps ANY provider via the ElevationProvider seam to add degradation
          without touching the transport. The comment states the policy:
          "Connectivity/coverage over fidelity" — streets render, routing connects,
          grades fill in later. Remove this and one 429 = blank screen.
```

## Elaborate

Request batching and retry-with-exponential-backoff are the bread and butter of
any client talking to a rate-limited API — the same shape as a write-batched DB
client or a bulk-embedding call to an LLM provider (pack many texts per request,
backoff on 429). The interesting, less-common move here is **resolution-aware
dedup**: recognizing that the *answer's* resolution (90 m DEM) bounds how many
distinct questions are worth asking, regardless of how many inputs you have. That's
a fidelity/cost lever, and the repo wires it to a constant (`DEDUPE`) tied to the
chosen provider. The `ElevationProvider` interface is a clean strategy-pattern
seam: `fixtureProvider` for deterministic tests, `openMeteoProvider` for the free
default, `googleProvider` for the paid fidelity upgrade — all swappable, with
`bestEffortElevation` as a decorator over any of them. The honest tradeoff stated
in the code (coarse 90 m smooths steep pitches) is exactly the kind of named cost
the project's spec calls out in §11.

Read next: `04-render-thread-search-debounce.md` (the pump that triggers these
builds and serializes them) and `06-linear-nearest-node-scan.md` (the other
graph-scale cost). The sibling `.aipe/study-system-design/` owns the
coverage-vs-fidelity architecture decision.

## Interview defense

**Q: "You need elevation for thousands of nodes from a rate-limited free API. How
do you not get throttled?"**

Three independent moves that multiply. First, dedup to the data's resolution — the
DEM is 90 m, so two nodes in the same 90 m cell return the same number; I sample
one representative per cell and fan it back out, which collapses ~1600 nodes to a
few hundred unique points. Second, batch 100 points per HTTP request, so that's a
handful of round-trips, not hundreds. Third, throttle between batches and back off
exponentially on 429s. And if it still fails, I degrade to flat elevation so the
build succeeds — coverage over fidelity.

```
  N nodes → dedup (DEM cells) → U unique → batch ×100 → ⌈U/100⌉ requests
  1600    →                   →  ~400    →            →  ~4 requests
```

Anchor: *don't sample finer than your data can answer — the DEM's resolution
bounds the number of distinct questions worth asking.*

**Q: "What's the part of this people get wrong?"**

Order preservation in the batch response, and degradation. The batch API returns
an `elevation[]` array — if your response index doesn't line up with your input
point index, every node silently gets a neighbor's height and all your grades are
subtly wrong, with no error. And without the best-effort fallback, a single 429
fails the *entire* graph build — blank screen — when you could have shipped flat
streets and backfilled grades later.

```
  response[i] MUST map to point[i]   |   catch → flat, build succeeds (don't fail)
```

Anchor: *for I/O-bound work the win is fewer, bigger, smarter requests — not faster
code.*

## Validate

1. **Reconstruct.** From memory, write the dedup: how `sampleElevations` groups
   nodes into cells, samples representatives, and fans answers back.
   (`elevation.ts:42-59`.) Why is `prec` tied to the DEM resolution?
2. **Explain.** Walk what `openMeteoProvider` does on a 429 and why the
   `out.push(e)` must preserve order. (`elevation.ts:108-122`.)
3. **Apply.** The elevation API is throttled during a live pan. Trace what
   `bestEffortElevation` does and what the user sees vs what they'd see without it.
   (`useTileGraph.ts:18-28`, `:111`.)
4. **Defend.** You want finer grades (LIDAR, 1 m resolution). Argue the
   request-cost consequence and what changes vs what stays, citing the
   `ElevationProvider` interface (`elevation.ts:7-10`) and `DEDUPE`
   (`useTileGraph.ts:33`).

## See also

- `04-render-thread-search-debounce.md` — the pump that serializes these builds.
- `06-linear-nearest-node-scan.md` — the other graph-scale cost.
- `.aipe/study-system-design/` — coverage-vs-fidelity as an architecture tradeoff.
