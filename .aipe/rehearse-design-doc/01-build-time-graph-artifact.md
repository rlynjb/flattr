# Design Doc — Ship the graph as a static build-time artifact, not a backend

**One-line summary:** flattr precomputes the routable street graph at build time into a static `graph.json` bundled with the app, and the runtime reads it directly — no routing server, no database, no network on the routing path.

This is the decision that shapes everything else, so write it down first. A reviewer's instinct will be "where's the backend?" — the doc's job is to make the absence a deliberate, defended choice rather than something that looks missing.

## Context / problem

flattr needs a routable, elevation-annotated street graph at query time. Producing that graph is expensive: pull OSM street geometry, densify it, sample elevation per segment, compute grades. The question isn't *how* to build the graph — it's *where the built graph lives* and *what serves it to the router*. The repo's constraints frame the answer: free-tier data sources only, a single developer, and a target of an offline-capable mobile app. There is no team to operate a service and no budget for managed infrastructure.

## Goals & non-goals

```
  GOALS                              NON-GOALS
  ─────                              ─────────
  routing works fully OFFLINE        live/edited map data
  zero per-query network on the      city-wide coverage in the
    happy path                         bundled artifact
  no server to operate or pay for    concurrent multi-user serving
  graph is reproducible from the     real-time graph updates
    pipeline                         user-writable graph state
```

The decisive non-goal is **live data**: flattr explicitly does not need the graph to change between builds. That's what makes a static artifact viable.

## The decision

Precompute the graph offline and bundle it; the runtime treats it as a read-only, in-memory structure indexed by its own adjacency map.

```
  BUILD-TIME ARTIFACT — where the graph lives and what reads it

  ┌─ BUILD TIME (run once, offline) ─────────────────────────┐
  │  Overpass ─► split ─► Open-Meteo ─► grade ─► build-graph  │
  │                                                  │        │
  │                                                  ▼        │
  │                                  ┌──────────────────────┐ │
  │                                  │ graph.json           │ │
  │                                  │  nodes  (Record<id>) │ │ ← primary key
  │                                  │  edges  (Edge[])     │ │
  │                                  │  adjacency           │ │ ← the index
  │                                  │   (nodeId → edgeId[])│ │
  │                                  └──────────────────────┘ │
  └──────────────────────────────────┬───────────────────────┘
                                      │ bundled in the app
  ┌─ RUNTIME (on device) ────────────▼───────────────────────┐
  │  load once at startup ─► hold in memory ─► A* traverses    │
  │  reads: nodes O(1), adjacency[node] O(1) per expansion     │
  │  writes: NONE.  network on routing path: NONE.            │
  └───────────────────────────────────────────────────────────┘
```

The key property the diagram shows: the access pattern is **whole-graph, read-only, in-memory** — load once, traverse many times, never mutate. The adjacency map *is* the index that makes each A\* node-expansion O(1); no query engine is needed because there are no queries, just traversal.

## Alternatives considered

| Alternative | Why it lost |
|-------------|-------------|
| **Routing server + spatial DB (PostGIS/Postgres)** | Buys live data and city scale, neither of which is a goal. Costs a server to operate, a network hop on every route, and a billing surface — all for a read-only workload that never writes. Wrong tool for the access pattern. |
| **Client-side DB (SQLite) on device** | A real option for large on-device graphs. But the graph is small (~1621 nodes) and the access is whole-graph traversal, not row queries — SQLite's query engine is overhead the workload never uses. Reconsider only when the graph outgrows memory. |
| **Fetch graph from an API at runtime** | Breaks the offline goal and reintroduces a service to operate. The on-demand tile fetch (for areas beyond the base) is the *bounded* version of this — used only past the bundled edge, not for the core route. |

## Tradeoffs accepted

We chose a static artifact, accepting that **the data is frozen at build time** — updating the map means re-running the pipeline and reshipping the app. For a neighborhood prototype with no live-data requirement, that's a non-cost. We also accept that the artifact is **trusted blindly on load** — see Risks.

> Coach note — where a reviewer pushes: "what about stale map data?" The framing that holds: "the graph changes on the timescale of streets being built, not minutes. A rebuild-and-ship cadence matches the data's real change rate. If the product needed live data, this is the decision I'd revisit — and I'd reach for SQLite or a service then, not now."

## Risks & mitigations

```
  RISK                                  MITIGATION
  ────                                  ──────────
  malformed/schema-drifted artifact     ▲ OPEN: today it's cast
    crashes deep in A*                    unvalidated. Add validate-
                                          on-load + a schema version.
  graph outgrows device memory          bounded by scope (neighborhood);
                                          tiling loads more on demand
  stale street data                     rebuild + reship; acceptable at
                                          the data's real change rate
```

The artifact-validation risk is real and currently unmitigated — `graph.json` is cast straight to the graph type with no runtime check, so a bad build surfaces as a cryptic mid-search crash. It's the first hardening this decision needs.

## Rollout / migration

There's nothing to migrate — this is the foundational decision, not a change to an existing system. The forward-compatible move is to add a `schemaVersion` field to the artifact now, so a future format change can be detected and rejected cleanly rather than silently mis-read.

## Open questions

1. **Validation:** what's the minimum schema check on load that catches a bad artifact without slowing startup meaningfully?
2. **The memory ceiling:** at what graph size does in-memory stop being viable, and is SQLite or tiling the right next step?
3. **Update cadence:** if this became a product, is rebuild-and-ship acceptable, or does live data force a service?

┃ "Match the storage to the access pattern — read-only whole-graph traversal wants a file, not a database."
┃ "There's no backend, and that's a decision, not an omission."
