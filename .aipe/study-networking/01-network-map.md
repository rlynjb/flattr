# Network map

**Industry name(s):** request topology / network boundary map. **Type:** Language-agnostic.

## Zoom out, then zoom in

Here's the whole thing on one screen. flattr is two programs that both reach the same
three external APIs — but at different *times* and from different *runtimes*. The
build-time program (Node) runs once and bakes a static `graph.json`. The runtime program
(React Native, on a phone) reads that artifact and makes *more* of the same calls live as
you pan and route.

```
  Zoom out — every network boundary flattr touches

  ┌─ BUILD TIME (Node + tsx, runs once) ──────────────────────────────┐
  │  pipeline/run-build.ts                                             │
  │     │ fetchOverpass(BBOX)        ──HTTP──►  Overpass               │
  │     │ openMeteoProvider().sample ──HTTP──►  Open-Meteo             │
  │     ▼                                                              │
  │  writes mobile/assets/graph.json  (static artifact, no network)    │
  └───────────────────────┬───────────────────────────────────────────┘
                          │ bundled into the app
  ┌─ RUNTIME (React Native, on device) ─▼─────────────────────────────┐
  │  MapScreen.tsx                                                     │
  │     geocode / geocodeSuggest ────────HTTP──►  Nominatim   ★        │
  │  useTileGraph.ts                                                   │
  │     fetchOverpass(viewport/corridor) ─HTTP──►  Overpass   ★        │
  │     openMeteoProvider().sample ──────HTTP──►  Open-Meteo  ★        │
  │     reads/writes elevCache (AsyncStorage, on-disk, NO network)     │
  └────────────────────────────────────────────────────────────────────┘
                  ★ = a live network boundary at runtime
```

Now zoom in. The thing this file teaches is the **map itself** — where every wire
crosses a trust/process boundary, so that when later chapters talk about "the Overpass
retry" or "the elevation cache" you already know *which arrow* on this picture they mean.
Every other chapter is a close-up of one box or one arrow here.

## The structure pass

**Layers.** Three nested altitudes:
- **outer — process/runtime:** build-time Node vs runtime React Native. Same client
  code (`pipeline/overpass.ts` is imported by both `run-build.ts:7` and
  `useTileGraph.ts:11`), two execution contexts.
- **middle — client module:** the three `fetch`-wrapping modules (`overpass`,
  `elevation`, `geocode`).
- **inner — single request:** one `await fetchImpl(...)` and its status check.

**Axis traced: where does failure get contained?** Hold that one question down the stack.

```
  One question down the layers: "where is a network failure contained?"

  ┌─ outer: build-time run-build.ts ───────────────┐
  │  a thrown fetch error aborts the whole build    │  → FAILURE = FATAL
  └──────────────────────┬──────────────────────────┘
       ┌─ outer: runtime useTileGraph.ts ───────────┐
       │  try/catch keeps last region, retries later │  → FAILURE = SWALLOWED
       └──────────────────┬──────────────────────────┘
            ┌─ inner: a single fetch ───────────────┐
            │  non-2xx → throw OR retry (per client) │  → FAILURE = RAISED
            └────────────────────────────────────────┘

  same network error, three containment answers depending on altitude
```

That contrast *is* the lesson: the **same** `fetchOverpass` throws identically at the
inner layer, but build-time lets it kill the run (`run-build.ts:44`, no surrounding
catch) while runtime wraps it (`useTileGraph.ts:219`, `catch {}` keeps last data).

**Seams.** The load-bearing boundary is the **process boundary between
flattr-code and third-party-server** — control flips (flattr can't make the server
respond), trust flips (flattr can't validate what the server is), and failure originates
there. Every chapter from `02` to `08` is a study of one property of that one seam.

## How it works

### Move 1 — the mental model

You already know the shape of a `fetch()`: a request goes out, you `await`, you get
loading → success → error. flattr's network map is just **three of those, fanning out
from two runtimes to three servers it doesn't own.** The map is a fan-out diagram, not a
chain.

```
  The pattern — fan-out from two runtimes to three external origins

         build-time ─┐                   ┌─► Overpass    (streets)
                     ├─ same fetch code ─┼─► Open-Meteo  (elevation)
         runtime ────┘                   └─► Nominatim   (geocode, runtime only)

  no call depends on another's *response*; they're parallel boundaries,
  sequenced only to respect rate limits, not because of data dependency
```

### Move 2 — the step-by-step walkthrough

**The build-time path (Node, runs once).** When you run `npm run build:graph`
(`run-build.ts`), one process makes two kinds of outbound call and writes a file.

```
  Layers-and-hops — build time

  ┌─ Node process ─┐ hop 1: POST data=<QL>   ┌─ Overpass ──┐
  │ run-build.ts   │ ──────────────────────► │ overpass-   │
  │                │ hop 2: 200 + OSM JSON ◄─ │ api.de      │
  │                │                          └─────────────┘
  │                │ hop 3: GET ?latitude=…   ┌─ Open-Meteo ┐
  │                │ ──────────────────────► │ api.open-   │
  │                │ hop 4: 200 + elev[] ◄─── │ meteo.com   │
  │                ▼                          └─────────────┘
  │  writes mobile/assets/graph.json (filesystem, NO wire)  │
  └─────────────────────────────────────────────────────────┘
```

`run-build.ts:44` makes hop 1-2; the chosen elevation provider (`run-build.ts:26` Google
or `:37` Open-Meteo) makes hop 3-4. Nominatim is **never** called at build time — there's
nothing to geocode in a graph build.

**The runtime path (React Native, on device).** The app reads the bundled `graph.json`,
then makes *live* calls as the user interacts. Two triggers: typing an address (Nominatim)
and panning/routing (Overpass + Open-Meteo).

```
  Layers-and-hops — runtime, two triggers

  ┌─ RN app ───────┐                              ┌─ origins ───┐
  │ MapScreen      │ hop A: GET search?q=…  ─────►│ Nominatim   │
  │  (you type)    │ hop A': suggestions[]  ◄──── │             │
  │                │   (debounced 400ms,          └─────────────┘
  │                │    MapScreen.tsx:80)
  │ useTileGraph   │ hop B: POST overpass   ─────►│ Overpass    │
  │  (you pan/     │ hop B': OSM JSON       ◄──── │             │
  │   route)       │ hop C: GET elevation   ─────►│ Open-Meteo  │
  │                │ hop C': elev[] / 429   ◄──── │             │
  │                ▼   (cache-first: many hops avoided, elevCache.ts)
  │  merges into in-memory Graph, renders                       │
  └─────────────────────────────────────────────────────────────┘
```

`useTileGraph.ts:186` makes hop B; `:191` makes hop C (wrapped in cache + best-effort).
`MapScreen.tsx:82` makes hop A. The cache (`elevCache.ts`) sits *in front* of hop C so
revisited areas skip it entirely.

**The boundary that isn't there: flattr → flattr.** There is none. The two flattr
runtimes never talk to each other over the network — the build-time program hands off to
the runtime program through a **file** (`graph.json`), bundled into the app. That's the
single most important fact on the map: flattr owns no server, so it has no inbound network
surface at all.

### Move 3 — the principle

A network map is worth drawing *before* you study any mechanism because every retry,
timeout, and cache is just hardening on **one specific arrow** of this picture. When you
can't place a mechanism on the map, you're memorizing it; when you can, you're reasoning
about it. flattr's map also teaches a structural truth: **a "networked app" with no
server of its own is entirely an exercise in being a well-behaved HTTP client.**

## Primary diagram

The full recap — every box, every wire, every runtime.

```
  flattr — complete network map

  ┌─ BUILD TIME · Node ───────────┐        ┌─ EXTERNAL ORIGINS (HTTPS) ──┐
  │ run-build.ts                  │ POST   │                             │
  │   fetchOverpass ──────────────┼───────►│  Overpass  overpass-api.de  │
  │   openMeteoProvider ──────────┼─GET───►│  Open-Meteo api.open-meteo  │
  │        │ writes               │        │  Nominatim nominatim.osm    │
  │        ▼                      │        │                             │
  │  graph.json (static artifact) │        └──────▲──────▲──────▲────────┘
  └────────┬──────────────────────┘               │      │      │
           │ bundled                          POST │  GET │  GET │
  ┌─ RUNTIME · React Native ──────▼────────────────┴──────┴──────┴──────┐
  │  MapScreen.tsx ─ geocode/Suggest ─────────────────► Nominatim       │
  │  useTileGraph.ts ─ fetchOverpass ─────────────────► Overpass        │
  │                  ─ openMeteoProvider ─────────────► Open-Meteo       │
  │     elevCache (AsyncStorage, on-disk) ── cuts Open-Meteo calls       │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This map is the "client-only application" shape: a frontend (here, two frontends — a
build script and a mobile app) that composes third-party APIs with no first-party
backend. It's the same shape as `AdvntrCue` calling GPT-4, or `dryrun` calling the Gemini
API — except flattr has *no* fallback to its own server because it has no server. The
design pressure that produces is total dependence on the third parties' availability and
rate limits, which is why the next seven chapters are mostly about **failure and
politeness**, not throughput. Read `02` next: the very first thing that happens on any of
these arrows is turning a hostname into an address.

## Interview defense

**Q: Walk me through flattr's network architecture.**
> Two runtimes, three outbound HTTP clients, zero inbound surface. Build-time Node calls
> Overpass and Open-Meteo once to bake a static `graph.json`; runtime React Native calls
> all three (adding Nominatim for geocoding) live as the user pans and types. The two
> runtimes hand off through a file, not the wire — flattr owns no server.

```
  build-time ─(file)─► runtime ─(HTTPS)─► {Overpass, Open-Meteo, Nominatim}
```
> Anchor: *no first-party backend — it's all client-side HTTP against free third-party APIs.*

**Q: Which boundary carries the most risk?**
> The flattr-code → third-party-server seam, every time. Control, trust, and failure all
> flip there, and flattr controls none of it — which is exactly why the code is built
> around retries, caching, and best-effort degradation.

```
  flattr │ ═══════ │ server it doesn't own
         (control, trust, failure all flip here)
```
> Anchor: *the load-bearing seam is the one flattr can't see past — the third-party server.*

## See also

- `02-dns-routing-and-addressing.md` — the first hop on every arrow.
- `05-http-semantics-caching-and-cors.md` — what travels on each labelled hop.
- `07-timeouts-retries-pooling-and-backpressure.md` — the hardening on each arrow.
- `study-system-design` — why the build-time/runtime split exists at all.
