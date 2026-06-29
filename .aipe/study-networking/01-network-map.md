# 01 — Network Map

**The on-the-wire path and every network boundary** · *Project-specific*

## Zoom out, then zoom in

Before any single request, see where the network even lives in flattr. Most of the app never touches it — the router, the heap, the grade classifier, the map rendering are all pure local computation over a graph that's already on the device. The network is a thin band on the edges: it fills the graph at build time and patches it at runtime.

```
  Zoom out — where networking lives in flattr

  ┌─ UI layer (Expo / RN) ───────────────────────────────────┐
  │  MapScreen · AddressBar · GradeSlider · MapLibre render   │
  └───────────────┬──────────────────────────────────────────┘
                  │ calls
  ┌─ Logic layer (pure TS, no network) ──────────────────────┐
  │  astar · graph · cost · classify · tiles · summary       │
  └───────────────┬──────────────────────────────────────────┘
                  │ reads/patches the graph
  ┌─ ★ NETWORK band ★ ───────────────────────────────────────┐ ← we are here
  │  fetchOverpass · openMeteoProvider · geocode  (all fetch) │
  └───────────────┬──────────────────────────────────────────┘
                  │ HTTPS
  ┌─ Provider layer (external, free-tier) ───────────────────┐
  │  overpass-api.de · api.open-meteo.com · nominatim.osm    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the "network map" is the answer to one question — *for any given user action, which hosts get hit, in what order, over what protocol, and what happens if one is down?* flattr has exactly four user-visible network triggers (launch, pan-with-grades-on, type-an-address, request-a-route) and three hosts. This file traces all of them onto one picture.

## Structure pass

**Layers.** Two altitudes, not one. Build-time (Node) and runtime (RN) are different processes, different machines, different lifecycles — but they call *the same two functions*. That's the load-bearing structural fact.

```
  Layers — two altitudes share the same network functions

  ┌─ build-time ─────────────┐     ┌─ runtime ────────────────┐
  │ run-build.ts (Node, once)│     │ useTileGraph (RN, live)  │
  └────────────┬─────────────┘     └────────────┬─────────────┘
               │  both import                    │
               └──────────────┬──────────────────┘
                              ▼
              fetchOverpass()  ·  openMeteoProvider()
              (one definition, two call sites)
```

**Axis = lifecycle (when does the call happen?).** Trace it across the layers and the answer flips, which is exactly what makes the boundary worth studying:

```
  axis traced: WHEN does each network call fire?

  ┌─ build-time ────────────┐  seam  ┌─ runtime ──────────────┐
  │ once, offline, by a dev │ ═══╪══► │ live, per user gesture │
  │ failure = build fails   │  flips  │ failure = degrade/skip │
  └─────────────────────────┘        └────────────────────────┘
```

The lifecycle answer flips at the build/runtime seam: a build-time failure is loud (the dev sees a stack trace, re-runs), a runtime failure must be silent (the user keeps a usable map). That single flip explains why `run-build.ts` lets errors propagate (`run-build.ts:54`) while `useTileGraph` swallows them (`useTileGraph.ts:219`).

**Seams.** Three boundaries carry contracts: (1) the **process boundary** between Node and RN — bridged by the baked `graph.json`, so the app launches with zero network; (2) the **fetch injection seam** — every network function takes `fetchImpl: typeof fetch = fetch`, so tests substitute a fake and never hit the wire (`overpass.ts:24`, `geocode.ts:11`, `elevation.ts:65`); (3) the **provider seam** — `ElevationProvider` is an interface, so fixture/Google/Open-Meteo are swappable behind one `sample(points)` contract (`elevation.ts:7`).

## How it works

### Move 1 — the mental model

You already know the shape: it's a `fetch()` with loading/success/error states, except flattr has four entry points feeding three hosts, and the interesting part is the *fan-out* — one user action can trigger two sequential calls to two different hosts (Overpass then Open-Meteo), and the failure of the second degrades rather than aborts.

```
  Pattern — one route action fans out to two hosts, sequentially

         user taps "Route"
                │
                ▼
       ensureBbox(corridor)
                │
                ▼  hop 1
     ┌─ POST overpass-api.de ─┐   streets (ways) for the corridor bbox
     └───────────┬────────────┘
                 │ ok → feed nodes to elevation
                 ▼  hop 2
     ┌─ GET api.open-meteo.com ┐   elevation per ~90m cell
     └───────────┬─────────────┘
                 │ ok → real grades   │ fail → flat (0 m) grades
                 ▼                     ▼
           buildGraph()         buildGraph() degraded=true → self-heal retry
```

The router itself never appears in this picture — A* runs entirely on the merged local graph after the fetches land. Networking's whole job is to *fill the graph*, never to compute on it.

### Move 2 — walk every trigger onto the map

**Trigger 1 — app launch.** Zero network for the graph. `graph.json` is bundled (`mobile/assets/graph.json`), loaded from disk by `loadGraph.ts`. The only launch-time network is the optional GPS permission/location call via Expo `Location` (`MapScreen.tsx:93`), which is device-local, not one of our three hosts. The elevation cache is also read from disk here (`useTileGraph.ts:126` → `loadElevCache`).

```
  Trigger 1 — launch: disk only, no API

  ┌─ Storage (device) ─┐  read   ┌─ App ─┐
  │ graph.json         │ ──────► │ render│
  │ AsyncStorage cache │ ──────► │ ready │
  └────────────────────┘         └───────┘
       no network band crossed
```

**Trigger 2 — pan the map with grades on.** Debounced 600ms (`useTileGraph.ts:64,255`), then `queueViewport` → `pump` → one Overpass POST + one Open-Meteo GET for the padded viewport bbox. Skipped entirely if the bundled base graph or current view already covers the bounds (`useTileGraph.ts:233-234`).

```
  Trigger 2 — pan: debounce, dedupe-against-coverage, then fan out

  pan event ──600ms──► covered? ──yes──► (no network)
                          │ no
                          ▼
                  hop1 POST overpass ──► hop2 GET open-meteo ──► merge
```

**Trigger 3 — type an address.** Debounced 400ms (`MapScreen.tsx:88`), then one Nominatim GET for autocomplete suggestions (`geocodeSuggest`, `MapScreen.tsx:82`). This is the only trigger that hits the third host.

**Trigger 4 — request a route.** Two **sequential** Nominatim GETs (from, then to) because the policy is ~1 req/s (`MapScreen.tsx:182,189`), then `ensureBbox` triggers the corridor build (Overpass + Open-Meteo). So a cold route from two typed addresses is up to **four** sequential network round-trips across **three** hosts.

```
  Trigger 4 — route from two addresses: 4 hops, 3 hosts, all sequential

  hop1 GET nominatim (from) ─► hop2 GET nominatim (to)
        │ ~1 req/s gap intentional
        ▼
  hop3 POST overpass (corridor) ─► hop4 GET open-meteo (corridor elev)
```

**The single-flight gate.** Every runtime build goes through `pump()`, which holds exactly one in-flight build (`busyRef`, `useTileGraph.ts:166-167`). Corridor requests jump the viewport queue (`useTileGraph.ts:170-177`) so a pending route isn't starved by panning. This is the runtime's whole concurrency-control story: serialize to stay under rate limits.

### Move 3 — the principle

A network map is worth drawing when *the same function runs at two altitudes* — the map is what reveals that build-time and runtime aren't two networking stacks but one, called twice. The reuse is invisible in any single file; it only shows up when you put both call sites on the same picture.

## Primary diagram

The full recap — every trigger, host, hop, and the local-only majority.

```
  flattr network map — complete

  ┌─ UI triggers ───────────────────────────────────────────────┐
  │ launch   pan(grades on)   type addr     request route        │
  └───┬──────────┬──────────────┬──────────────┬─────────────────┘
      │          │ 600ms        │ 400ms        │
      │          ▼              ▼              ▼
      │   ┌────────────┐  ┌──────────┐  ┌──────────────────────┐
      │   │ queueView  │  │ suggest  │  │ geocode×2 (sequential)│
      │   └─────┬──────┘  └────┬─────┘  └──────────┬───────────┘
      │         │ pump()       │                   │ ensureBbox→pump()
   disk only    ▼              ▼                    ▼
  ┌─ NETWORK band (fetch, HTTPS) ───────────────────────────────┐
  │  POST overpass-api.de    GET nominatim.osm   GET open-meteo │
  └──────┬───────────────────────┬───────────────────┬─────────┘
         ▼                        ▼                   ▼
  ┌─ Providers (free-tier, OS-resolved DNS, OS TLS) ────────────┐
  │  Overpass (OSM)        Nominatim (geocode)   Open-Meteo (DEM)│
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The build-time/runtime symmetry is unusual and worth keeping. Most apps have a "data pipeline" repo and an "app" repo that share nothing but a schema. flattr shares the actual fetch code, which means a fix to Overpass retry behavior lands in both places at once. The cost: the runtime bundle carries Node-flavored pipeline code (`buildGraph`, `overpass`) that was written for a script. That's the tradeoff `mobile/scripts/sync-engine.mjs` exists to manage — it copies the engine into the mobile tree so the imports resolve.

## Interview defense

**Q: Walk me through every network call when a user routes between two typed addresses from a cold start.**
Four sequential round-trips across three hosts: two Nominatim GETs (from, then to — sequential on purpose because the policy is ~1 req/s), then one Overpass POST for the corridor, then one Open-Meteo GET for elevation. The geocodes are in `MapScreen.tsx:182-189`; the corridor fan-out is `ensureBbox` → `pump` in `useTileGraph.ts`. Anchor: *three hosts, four hops, all serial — serialization is the rate-limit strategy.*

**Q: What hits the network at app launch?**
For the graph, nothing — `graph.json` is bundled and read from disk, plus the elevation cache from AsyncStorage. The only launch network is the optional GPS location call, which is device-local. Anchor: *the graph is a baked artifact; launch is offline by design.*

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the `pump` single-flight gate in depth
- `05-http-semantics-caching-and-cors.md` — the methods and status codes on each hop
- `.aipe/study-system-design/` — the build-time/runtime split as an architecture decision
