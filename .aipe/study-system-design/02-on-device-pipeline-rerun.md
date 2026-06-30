# On-device pipeline rerun

**Industry names:** client-side compute / edge precompute on demand / "ship the
builder" / lazy region hydration. **Type:** Project-specific (a direct consequence
of keeping the build pipeline pure).

---

## Zoom out, then zoom in

The bundled artifact covers one small Capitol Hill slice. The moment you pan or
route past it, flattr re-runs *the exact same build pipeline* — Overpass fetch,
split, elevation, grade — on the phone, and merges the result into the live graph.
The build toolchain isn't left behind on the build machine; it ships to the client.

```
  Zoom out — the rerun sits between the artifact and the router

  ┌─ RUNTIME (phone) ───────────────────────────────────────────┐
  │  loadGraph → baseGraph (covers the bundled slice only)       │
  │                  │                                           │
  │   pan/route past base?                                       │
  │                  ▼                                           │
  │  ★ useTileGraph: fetchOverpass → buildGraph → prefixGraph ★  │ ← we are here
  │                  │   (SAME pipeline that built the artifact) │
  │                  ▼                                           │
  │  mergeGraphs([base, corridor, view]) → stitch → directedAstar│
  └──────────────────────────────────────────────────────────────┘
```

You know how a service worker can run the same code offline that the server runs
online? Same move. flattr's `buildGraph` has no `node:fs` (see
`01-build-time-graph-artifact.md`), so the identical function runs in two
lifecycles: once at build time to make the artifact, and again at runtime to extend
it. The question it answers: *how do you get coverage beyond the bundled area
without shipping the entire planet's graph?*

---

## The structure pass

**Layers:** UI event (pan/route) → coverage decision → on-device build → merge into
graph.

**Axis = control (who decides a build happens, and which build wins?).**

```
  One question down the layers: "who decides the next build runs?"

  ┌───────────────────────────────────┐
  │ UI: onRegionDidChange / ensureBbox│  → the USER (pan / set endpoints)
  └───────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ covers() guard + pump() queue   │  → the CODE (skip if covered;
      └─────────────────────────────────┘     corridor beats viewport)
          ┌─────────────────────────────┐
          │ buildGraph (pure pipeline)  │  → nobody decides; it just runs
          └─────────────────────────────┘

  control flips at pump(): user requests, code arbitrates, pipeline obeys
```

**Seams:** two matter. (1) The `covers()` check (`useTileGraph.ts:82`) — the seam
between "fetch" and "skip"; the *cost* axis flips here (a covered bbox costs zero
network). (2) The `busyRef` single-flight gate (`:113`) — the seam between
"concurrent" and "serial"; the *guarantees* axis flips (only one build in flight,
ever). Both seams exist to stay under free-tier rate limits.

---

## How it works

#### Move 1 — the mental model

The shape is "same producer, second lifecycle, behind a single-flight queue." A user
gesture proposes a bbox; a coverage guard decides whether to build; a serial pump
runs at most one `buildGraph` at a time, corridor-first; the result is prefixed and
merged.

```
  Pattern — gated single-flight rerun

         user gesture (pan / route)
                  │
                  ▼
            covers(bbox)? ──yes──► skip (no network)
                  │ no
                  ▼
         enqueue (corridor OR viewport)
                  │
                  ▼
         pump():  busy? ──yes──► wait
                  │ no
                  ▼
         fetchOverpass → buildGraph → prefixGraph → setRegion
                  │
                  ▼
         pump() again ──► drain next (corridor first)
```

#### Move 2 — the walkthrough

**A gesture proposes a bbox; a guard kills redundant builds.** Panning fires
`onRegionDidChange`, debounced 600 ms, gated on zoom span and the grades toggle:

```ts
// mobile/src/useTileGraph.ts:231 — queueViewport: the coverage guard
if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;  // base covers it → skip
if (covers(viewRef.current, bounds)) return;                    // current region covers → skip
// else: pad the bbox and enqueue
pendingViewRef.current = { bbox: padded, silent: false };
pump();
```

The boundary condition: `covers()` returns `false` for a **degraded** region
(`:83`) — so flat-fallback areas refetch to upgrade. That single line wires the
self-heal into the coverage check (→ `05-elevation-provider-fallback.md`).

**`pump()` is the single-flight scheduler.** This is the load-bearing part. At most
one build runs; the corridor (an in-progress route) always beats the viewport (idle
panning):

```ts
// mobile/src/useTileGraph.ts:166 — one build at a time, corridor first
const pump = useCallback(() => {
  if (busyRef.current) return;                 // already building → bail
  if (pendingCorridorRef.current) { kind = "corridor"; ... }   // route wins
  else if (pendingViewRef.current) { kind = "view"; ... }      // else viewport
  else return;                                  // nothing queued
  busyRef.current = true;
  (async () => {
    const osm = await fetchOverpass(bbox);
    const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, ...);  // SAME builder
    setRegion({ bbox, graph: prefixGraph(g, kind), degraded });
    busyRef.current = false;
    pump();                                      // drain the next (corridor first)
  })();
}, []);
```

What breaks if you remove `busyRef`: concurrent builds fire parallel Overpass +
Open-Meteo requests and hit the global rate limit instantly. The serial pump is a
*deliberate throughput sacrifice for rate-limit safety* — named in the file header
("One network build runs at a time… to stay under the free Overpass/Open-Meteo
rate limits", `:5`).

**`ensureBbox` is the routing entry point.** When both endpoints are set, MapScreen
asks for a corridor spanning them so they land in one connected component:

```ts
// mobile/src/MapScreen.tsx:139 — endpoints → corridor request
ensureBbox([minLng - M, minLat - M, maxLng + M, maxLat + M]);  // M = ~1 tile margin
// useTileGraph.ts:269 — refuses spans too wide to route
if (e - w > MAX_CORRIDOR_SPAN_DEG || n - s > MAX_CORRIDOR_SPAN_DEG) return false;  // ~13km cap
```

The hop across lifecycles, drawn — note the *same* `buildGraph` box appears on both
sides of the artifact boundary:

```
  Layers-and-hops — the same builder, two lifecycles

  ┌─ BUILD MACHINE ─────────┐                        ┌─ PHONE ──────────────────┐
  │ run-build.ts            │                        │ useTileGraph.pump()      │
  │   → buildGraph(...) ────┼── writes graph.json ──►│ loadGraph → baseGraph    │
  └─────────────────────────┘   (artifact boundary)  │   pan/route past base    │
            ▲                                         │   → buildGraph(...) ◄────┼─ SAME fn
            └──────── identical pure function ────────┘   → prefixGraph → merge  │
                       (no node:fs anywhere in it)        └──────────────────────┘
```

#### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (anticipated, audit lens 7)
  ─────────────────────────        ──────────────────────────────────
  small base + on-device rerun     small base + server proxy in front of
  per-device rate-limit safety       Overpass/Open-Meteo (shared fleet cache)
  free-tier limits are GLOBAL,     forced when the global free-tier ceiling
    so fleet can exhaust quota       is hit across all users
  no flattr backend                first real backend appears here
```
What *doesn't* change in Phase B: `buildGraph` itself. The pipeline stays; only the
fetch source moves behind a proxy.

#### Move 3 — the principle

If your producer is pure, you can run it anywhere — including the client. flattr
ships a tiny artifact and re-derives the rest on demand, trading a little per-pan
latency for an enormous reduction in bundle size and a complete absence of a tile
server. The constraint that makes it safe is the single-flight queue: client-side
compute that hits rate-limited APIs *must* serialize, or it self-DoSes.

---

## Primary diagram

```
  On-device pipeline rerun — full pattern

  ┌─ UI ────────────────────────────────────────────────────────┐
  │  pan → onRegionDidChange (debounce 600ms)                    │
  │  route → ensureBbox(corridor)                                │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼  gate: span limits, grades toggle, covers()?
  ┌─ Scheduler (pump, single-flight) ───────────────────────────┐
  │  busyRef? wait  |  corridor beats viewport  |  drain on done │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼
  ┌─ Same pipeline (no node:fs) ────────────────────────────────┐
  │  fetchOverpass → buildGraph(cached+bestEffort elev)          │
  │     → prefixGraph(kind:)                                     │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼
  ┌─ Merge (03-) ───────────────────────────────────────────────┐
  │  mergeGraphs([base, corridor, view]) → stitchGraph → router  │
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is "ship the builder to the edge" — the same instinct behind service workers,
WASM-compiled native libraries running in-browser, and on-device ML (your own
`contrl` runs MediaPipe on-device for the same reason: no round-trip). The
difference from a normal client-fetch is that flattr isn't fetching *data*, it's
running a *build* — the heavy pipeline executes on the phone.

The enabling discipline came from `01-build-time-graph-artifact.md`: a pure
producer. The merge that makes the output usable is `03-tile-merge-stitch.md`. The
elevation failure model inside the rerun is `05-elevation-provider-fallback.md`.

Runtime mechanics of the async pump, debounce, and refs → `study-runtime-systems`.
The HTTP retry/rate-limit behavior on the wire → `study-networking`.

---

## Interview defense

**Q: Why re-run the build on-device instead of just fetching more graph from a
server?**
There is no server — that's the whole point of the artifact pattern. Re-running the
pure `buildGraph` on the phone means no tile backend to operate. The cost is per-pan
latency and dependence on free-tier APIs; the win is zero infrastructure.

```
  fetch-from-server (rejected)     vs     on-device rerun (chosen)
  needs a tile backend                    needs only the pure builder + 3rd-party APIs
```
Anchor: pure producer → run it on the client.

**Q: What's the load-bearing mechanic, and what breaks without it?**
`busyRef` single-flight in `pump()` (`useTileGraph.ts:166`). Remove it and
concurrent panning fires parallel Overpass/Open-Meteo requests that trip the global
rate limit instantly. Bonus: corridor-priority ensures a route never starves behind
idle panning.
Anchor: client compute over rate-limited APIs must serialize.

**Q: How does an in-progress route survive new tiles loading underneath it?**
Endpoints are stored as coordinates, not node ids; `nearestNode` re-snaps against
the *current* merged graph on every change (`MapScreen.tsx:133`). A closer real node
appearing mid-load just re-snaps. Storing the node id would freeze the route to a
stale node.
Anchor: derive the node id, don't store it.

---

## See also

- `01-build-time-graph-artifact.md` — the pure producer this depends on.
- `03-tile-merge-stitch.md` — how the rerun's output becomes one routable graph.
- `05-elevation-provider-fallback.md` — the degraded/self-heal loop inside the rerun.
- `audit.md` lenses 2, 6, 7 — data flow, reliability, scale ceiling.
</content>
