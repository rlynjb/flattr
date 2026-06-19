# 01 — Network map
### the full on-the-wire path and every network boundary
**Industry name:** request topology / network boundary map — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

Before any single protocol detail, you need the whole picture of *what talks to what*. You've drawn these for your own systems: AdvntrCue is browser → Netlify function → Postgres → OpenAI. flattr's map is unusual because it has two completely separate network phases, and the boxes that do the talking in each phase are the *same code*.

```
  Zoom out — where the network boundaries live in flattr

  ┌─ Build layer (Node, your laptop, run once) ─────────────────┐
  │  ★ all build-time wire traffic lives here ★                 │
  │  pipeline/run-build.ts → overpass.ts, elevation.ts          │
  └──────────────────────────┬───────────────────────────────────┘
                             │  ═══ NETWORK BOUNDARY ═══
                             ▼  (to providers you don't own)
  ┌─ Provider layer (third-party public APIs) ──────────────────┐
  │  overpass-api.de · api.open-meteo.com ·                     │
  │  maps.googleapis.com · nominatim.openstreetmap.org ·        │
  │  tiles.openfreemap.org                                       │
  └──────────────────────────┬───────────────────────────────────┘
                             │  build output: data/graph.json
                             ▼  (copied + bundled — NOT a network hop)
  ┌─ App layer (React Native, the phone) ───────────────────────┐
  │  ★ all runtime wire traffic lives here too ★                │
  │  MapScreen.tsx → geocode.ts, useTileGraph.ts, MapLibre      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the network map is the inventory of every hop the system makes and the boundary each hop crosses. For flattr that inventory is small and entirely outbound — flattr is always the client, never the server. There's no inbound traffic to map because nothing connects *to* flattr.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** Three: Build (Node CLI), Provider (the public APIs), App (React Native). The Build and App layers both sit on the flattr side of the boundary; the Provider layer is everything across it.

**Axis — trust (what can each side see or tamper with?).** Trace it across the boundary:

```
  One axis — "who controls this code/data?" — across the boundary

  ┌─ flattr side ───────┐   network    ┌─ provider side ──────────┐
  │ YOU control:        │   boundary   │ THEY control:            │
  │  the fetch params   │ ════╪═══════►│  rate limits, uptime,    │
  │  the retry policy   │  (it flips)  │  response shape, schema, │
  │  the parsing        │              │  DEM resolution, TOS     │
  └─────────────────────┘              └──────────────────────────┘
         ▲                                      ▲
         └──── same axis, two answers ──────────┘
              → every provider hop is a contract you can't change
```

The axis flips hard at the boundary. On your side you control request shaping and failure handling. On the far side you control *nothing* — not the rate limit, not the schema, not whether the server is up. That's why every defensive mechanism in this repo (retries, dedup, best-effort fallback) lives strictly on the flattr side.

**Seams.** The load-bearing seam is the network boundary itself — but there's a second, quieter one: `data/graph.json`. The build layer crosses the network to providers, distills the result into one JSON file, and that file crosses into the app layer *as a bundled asset, not over the wire* (`mobile/src/loadGraph.ts:7`). The graph file is a seam where "network dependency" flips to "zero network dependency." The base map works offline because of it.

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how a build step can bake an API response into a static file so the runtime never re-fetches it — like committing a generated config? flattr's whole base graph is that pattern at scale: the build phase makes ~3 provider round-trips, bakes the answer into `graph.json`, and the app ships it. Runtime network calls only happen when the user wanders *outside* the baked area.

```
  Pattern — two phases, one shared client, one baked artifact

   BUILD (once)                          RUNTIME (per session)
   ───────────                           ─────────────────────
   fetch streets ─┐                      load graph.json (no net)
   fetch elevation┤──► graph.json ──ship──► render base map
   build graph ───┘         │                    │
                            │            pan outside? ──► fetch more
                            │            route far?   ──► fetch corridor
                            └─ SAME pipeline modules run in both phases ─┘
```

#### Move 2 — walking every hop

**The build-time hops.** When you run `npm run build:graph`, `pipeline/run-build.ts` makes a fixed sequence of outbound calls. First one POST to Overpass for all the OSM `highway` ways in the bbox. Then a series of GETs to the elevation provider — Open-Meteo by default, batched 100 points at a time. That's it. No call depends on a server flattr owns; every one crosses the boundary to a public API.

```
  Layers-and-hops — build time

  ┌─ Build (Node) ─┐  hop 1: POST data=<QL>     ┌─ Provider ───────┐
  │ run-build.ts   │ ─────────────────────────► │ overpass-api.de  │
  │                │  hop 2: 200 + OSM JSON ◄─── └──────────────────┘
  │                │
  │                │  hop 3: GET ?latitude=..&   ┌─ Provider ───────┐
  │                │         longitude=..        │ api.open-meteo   │
  │                │ ─────────────────────────► │ .com             │
  │                │  hop 4: 200 + {elevation[]}◄└──────────────────┘
  │  writes data/graph.json (no further hops)                       │
  └─────────────────────────────────────────────────────────────────┘
```

**The runtime hops.** On the phone, three independent things touch the wire. MapLibre fetches vector map tiles from OpenFreeMap (`STYLE_URL`, `mobile/src/MapScreen.tsx:21`) — flattr hands MapLibre a style URL and the native library does the tile fetching itself. The address bar geocodes through Nominatim. And `useTileGraph` re-runs the *same* Overpass + Open-Meteo pipeline to extend coverage when you pan or route far.

```
  Layers-and-hops — runtime (the phone)

  ┌─ App (RN) ─────┐  hop A: GET style + tiles   ┌─ Provider ───────┐
  │ MapLibre       │ ─────────────────────────►  │ tiles.open       │
  │                │     (native lib owns this)   │ freemap.org      │
  │                │                              └──────────────────┘
  │ AddressBar     │  hop B: GET /search?q=..    ┌─ Provider ───────┐
  │                │ ─────────────────────────►  │ nominatim.osm    │
  │                │                              └──────────────────┘
  │ useTileGraph   │  hop C: POST Overpass +     ┌─ Provider ───────┐
  │                │         GET Open-Meteo       │ overpass-api.de  │
  │                │ ─────────────────────────►  │ + open-meteo.com │
  │                │                              └──────────────────┘
  │ loadGraph()    │  NO HOP — reads bundled graph.json from disk    │
  └─────────────────────────────────────────────────────────────────┘
```

**The non-hop that matters most.** `loadGraph()` is one line: it reads the bundled JSON. No network. The base routing experience — see the map, see grade colors, route within Capitol Hill — works in airplane mode. Everything else is enrichment that *can* fail without breaking the core.

#### Move 3 — the principle

Map the boundaries before the protocols. The moment you can name which hops cross into systems you don't own, you know exactly where your failure handling has to live — on your side of every one of those arrows, because the other side is a contract you can't touch.

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The complete network map — every hop, every boundary, both phases.

```
  flattr — complete network map

  ┌─ BUILD LAYER (Node) ────────────────────────────────────────┐
  │  run-build.ts ─POST─► overpass-api.de ──────────► OSM JSON   │
  │              └─GET──► api.open-meteo.com ───────► elevation  │
  │                         (or maps.googleapis.com w/ key)      │
  │                                │                             │
  │                                ▼ writes once                 │
  │                         data/graph.json                      │
  └────────────────────────────────┬─────────────────────────────┘
                  bundled as asset  │  (NOT a network hop)
  ┌─ APP LAYER (React Native) ──────▼─────────────────────────────┐
  │  loadGraph() ◄── graph.json (disk, offline)                  │
  │  MapLibre ──GET──► tiles.openfreemap.org                     │
  │  geocode  ──GET──► nominatim.openstreetmap.org               │
  │  useTileGraph ─POST─► overpass-api.de  ─GET─► open-meteo.com │
  │  expo-location ──► device GPS (not the wire)                 │
  └───────────────────────────────────────────────────────────────┘
   ═══ every outbound arrow crosses into a provider flattr doesn't own ═══
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** The map is reached for whenever you ask "what breaks if provider X is down?" Down Overpass at build time = no graph. Down Overpass at runtime = no new coverage, but the base graph still works. Down OpenFreeMap = blank map background (but the route line, drawn by flattr from the graph, still renders). Each boundary has a different blast radius, and the map is how you see it.

**The build sequence, side by side** — `pipeline/run-build.ts` (lines 40-52):

```
  pipeline/run-build.ts  (lines 40-52)

  const { provider, ... } = pickElevation();   ← choose provider by env var
  const osm = await fetchOverpass(BBOX);        ← HOP 1: POST to Overpass
  const graph = await buildGraph(               ← HOPs to elevation happen
      "seattle-mvp", BBOX, osm, provider, ...); │  INSIDE buildGraph →
  mkdirSync("data", { recursive: true });       │  sampleElevations →
  writeGraph(graph, "data/graph.json");         ← provider.sample()
        │
        └─ the only two outbound dependencies of the entire build are
           these two awaits; everything else is pure local computation
```

The whole build's network surface is `fetchOverpass(BBOX)` plus the elevation calls buried inside `buildGraph`. Two providers, then disk.

**The runtime base-load, side by side** — `mobile/src/loadGraph.ts` (lines 9-11):

```
  mobile/src/loadGraph.ts  (lines 9-11)

  export function loadGraph(): Graph {
    return graph as unknown as Graph;   ← `graph` is the bundled import
  }                                        of ../assets/graph.json
        │
        └─ zero network. This is why the seam at graph.json matters:
           the base map is a static asset, so the app's core path
           has no provider dependency at all
```

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

This is the "thick client, thin (borrowed) backend" topology. flattr owns no server, so its "backend" is a federation of public OSM-ecosystem APIs (Overpass, Nominatim, OpenFreeMap all derive from OpenStreetMap data) plus an elevation source. The pattern shows up any time you build on free public infrastructure: your network map is a list of other people's services, and your engineering effort goes into being a well-behaved guest (User-Agent strings, request throttling, respecting rate limits) rather than into running servers. The spec's proposed Next.js deployment (`docs/flattr-spec.md` §8) would add one boundary you *do* own — but the app as built has zero.

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "Walk me through every network call your app makes."**

Answer: "Two phases. At build time, one POST to Overpass for OSM streets and a batch of GETs to Open-Meteo for elevation — that bakes a static graph.json. At runtime on the phone, three things hit the wire: MapLibre fetches vector tiles from OpenFreeMap, the address bar geocodes through Nominatim, and a tile-extension hook re-runs the same Overpass+Open-Meteo pipeline when you pan or route outside the baked area. The base routing experience reads a bundled JSON and makes zero network calls."

```
  build: POST Overpass + GET Open-Meteo → graph.json
  run:   GET tiles · GET geocode · POST/GET extend-coverage
  core:  loadGraph() — no network
```

Anchor: *every outbound hop crosses into a provider flattr doesn't own; the base experience crosses nothing.*

**Q: "What's the blast radius if your map tile provider goes down?"**

Answer: "The map background goes blank, but the route line and grade heatmap still render — flattr draws those from its own graph data as GeoJSON overlays, independent of the basemap tiles. Routing is unaffected because it's pure local A\* over the bundled graph."

```
  tiles down → basemap blank
  BUT route + heatmap = GeoJSON from local graph → still draw
```

Anchor: *the basemap and the route are different layers from different sources; one failing doesn't take the other.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** From memory, list every hostname flattr talks to and whether it's build-time, runtime, or both. (Check against `pipeline/overpass.ts:4`, `pipeline/elevation.ts:106` & `:72`, `pipeline/geocode.ts:5`, `mobile/src/MapScreen.tsx:21`.)
2. **Explain:** Why is `mobile/src/loadGraph.ts:9-11` *not* on the network map?
3. **Apply:** A user opens the app in airplane mode in Capitol Hill. Which features work, which don't, and why? (Trace through `loadGraph` vs `useTileGraph` vs `STYLE_URL`.)
4. **Defend:** Someone proposes adding a flattr-owned routing server. Where does it land on the map, and what new failure boundary does it introduce that doesn't exist today?

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `02-dns-routing-and-addressing.md` — how those four hostnames resolve.
- `05-http-semantics-caching-and-cors.md` — the methods and headers on each hop.
- `08-networking-red-flags-audit.md` — ranked risks per boundary.
- `.aipe/study-system-design/` — the build-vs-runtime split as architecture.
