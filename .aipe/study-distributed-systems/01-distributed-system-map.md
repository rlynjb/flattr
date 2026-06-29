# The Distributed-System Map

**Industry name(s):** system context / coordination map / failure-domain diagram · *Industry standard*

## Zoom out, then zoom in

Before any concept, you need the map: who talks to whom, where a message can be lost, and which boxes can fail independently. In a big system this is a fan-out of services. In flattr it's almost embarrassingly small — and that smallness *is* the first lesson. Most of "distributed systems" doesn't apply here because there's only one node. The discipline is finding the *one* boundary that does.

```
  Zoom out — the whole system as failure domains

  ┌─ FAILURE DOMAIN 1: your client process (one node) ──────────────┐
  │  ┌──────────────┐   ┌─────────────────┐   ┌──────────────────┐  │
  │  │ MapScreen    │──►│ useTileGraph    │──►│ A* router        │  │
  │  │ (UI)         │   │ (pump, debounce)│   │ (in-memory graph)│  │
  │  └──────────────┘   └────────┬────────┘   └──────────────────┘  │
  │   ┌─ local state ─┐          │  ┌─ local persistence ─┐         │
  │   │ graph.json    │          │  │ elevCache (Async-   │         │
  │   │ (bundled)     │          │  │ Storage)            │         │
  │   └───────────────┘          │  └─────────────────────┘         │
  └──────────────────────────────┼──────────────────────────────────┘
                                 │  ★ THE ONLY BOUNDARY ★  ← we are here
            ════════════ HTTP over the public internet ════════════
                                 │
  ┌─ FAILURE DOMAIN 2 ─┐ ┌─ DOMAIN 3 ─┐ ┌─ FAILURE DOMAIN 4 ────────┐
  │ Overpass (OSM)     │ │ Open-Meteo │ │ Nominatim (geocode)       │
  │ not yours          │ │ not yours  │ │ not yours                 │
  └────────────────────┘ └────────────┘ └───────────────────────────┘
```

**Zoom in.** A *failure domain* is a set of components that fail together. Inside domain 1, if the router throws, the UI throws — same process, same crash, no network in between, so it's not a *distributed* failure, it's an ordinary exception. The interesting thing happens only when a message crosses into domains 2–4: those can be slow, throttled, or down *while your process keeps running*. That asymmetry — one side alive, the other unreachable — is the entire definition of partial failure, and it only exists across that one double line.

## Structure pass

**Layers.** Three, stacked:

```
  UI / interaction   — MapScreen.tsx
  Coordination       — useTileGraph.ts (the pump), build pipeline
  External providers  — Overpass · Open-Meteo · Nominatim (HTTP)
```

**The axis to trace: `failure` — where does it originate, and where does it get contained?**

```
  One axis (failure) traced down the layers

  ┌─ UI layer ────────────────┐  failure here = a render bug
  │ MapScreen                 │  (in-process, deterministic)
  └───────────┬───────────────┘
              │
  ┌─ Coordination layer ──────▼┐  failure here = a throttle / hang /
  │ useTileGraph pump          │  network drop — NON-deterministic,
  │  try/catch contains it     │  ARRIVES from below, contained here
  └───────────┬───────────────┘
              │
  ┌─ Provider layer ──────────▼┐  failure ORIGINATES here:
  │ Overpass / Open-Meteo /    │  429, 503, timeout, DNS fail —
  │ Nominatim                  │  outside your control entirely
  └────────────────────────────┘

  the answer flips at the boundary: above it failure is a bug you
  fix; below it failure is a fact you absorb. That flip is the seam.
```

**The seam.** It's the HTTP call itself — `fetchOverpass`, `provider.sample`, `geocode`. That's where the contract between "code I control" and "service I don't" lives, where every retry/timeout/fallback decision has to be made, and where every bug in this guide originates. Map the seam first; the mechanics in `02`–`04` all hang off it.

## How it works

### Move 1 — the mental model

You already know the shape from any frontend app: a component calls `fetch()` and has to handle loading / success / error. A distributed-system map is just that picture drawn for *every* external call at once, with one extra column — *can this call fail independently of the rest of my app?* If yes, it crosses a failure-domain boundary and earns a place on the map. If no (same process), it's just a function call.

```
  The map kernel — one row per external dependency

  caller        │ boundary    │ provider    │ failure modes you must absorb
  ──────────────┼─────────────┼─────────────┼──────────────────────────────
  pump/build    │ HTTP POST   │ Overpass    │ 429 502 503 504, hang, offline
  pump/build    │ HTTP GET    │ Open-Meteo  │ 429, hang, offline
  geocode UI    │ HTTP GET    │ Nominatim   │ 5xx, hang, offline (1 req/s cap)
```

That three-row table *is* flattr's distributed system. Everything else is one node.

### Move 2 — walking the map

**The caller side — who initiates, and from where.** There are two distinct callers hitting the same three providers, at two different lifecycle moments.

```
  Two callers, two lifecycles, same providers

  BUILD TIME (once, on a dev laptop)        RUN TIME (on the user's phone)
  ┌────────────────────────┐                ┌────────────────────────┐
  │ pipeline/run-build.ts  │                │ useTileGraph.ts pump   │
  │  → fetchOverpass(BBOX) │                │  → fetchOverpass(bbox) │
  │  → provider.sample()   │                │  → openMeteoProvider() │
  └───────────┬────────────┘                └───────────┬────────────┘
              │ writes data/graph.json                   │ merges into live graph
              ▼                                          ▼
        bundled into app  ───────── shipped ──────► read by loadGraph.ts
```

The build-time caller is in `pipeline/run-build.ts:43-46`: `fetchOverpass(BBOX)` then `buildGraph(...)`. It runs on your machine, writes `data/graph.json`, and that file gets copied into `mobile/assets/graph.json` (per `loadGraph.ts:2-4`). The run-time caller is the pump in `useTileGraph.ts:186-197`, which fetches *additional* viewport/corridor tiles on top of the bundled base.

The lifecycle split matters: a build-time failure is a developer staring at a stack trace who can just re-run; a run-time failure is a user mid-pan whose elevation API just 429'd. **Same provider, completely different blast radius** — the build-time path can crash loudly (`run-build.ts:54-57` sets `exitCode = 1`), the run-time path must degrade silently (`02`, `04`).

**The provider side — what you don't control.** All three are free public endpoints with rate limits and no SLA to you. Open-Meteo's 429 is a documented hazard (the project context literally warns "check `curl` before debugging the pipeline"). Nominatim asks for ~1 req/sec and a `User-Agent` (set in `geocode.ts:22`). You can't make these faster or more reliable — you can only decide what your side does when they misbehave.

**The message side — what crosses, and the key it carries.** Every message across the seam is a read keyed by geography: a bbox (Overpass, Open-Meteo) or a query string / coordinate (Nominatim). No message carries a write. That single fact — *the boundary is read-only* — is what makes delivery semantics trivial (`03`) and retries safe.

### Move 3 — the principle

Drawing the map is the move that tells you which 90% of "distributed systems" to *skip*. flattr has one boundary, so it needs partial-failure handling and graceful degradation — and needs nothing about consensus, replication, or sagas. The map is how you earn the right to say `not yet exercised` instead of cargo-culting infrastructure you don't have a second node to justify.

## Primary diagram

```
  flattr distributed-system map — final recap

  ┌─ NODE (single process: client + build) ─────────────────────────┐
  │  UI ──► coordination (pump / build) ──► in-memory graph + router │
  │         local state: graph.json (stale-by-design)                │
  │         local persistence: elevCache (eventual, self-healing)    │
  └───────────────────────┬──────────────────────────────────────────┘
                          │ keyed READ messages (bbox / coord)
       ═══════════════════╪═══════ the ONE coordination boundary ═════
                          │ partial failure lives here, nowhere else
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   ┌──────────┐     ┌──────────┐       ┌───────────┐
   │ Overpass │     │Open-Meteo│       │ Nominatim │   ← failure domains
   │ retry ✓  │     │ retry ✓  │       │ retry ✗   │     you don't own
   │ timeout ✗│     │ timeout ✗│       │ timeout ✗ │
   └──────────┘     └──────────┘       └───────────┘
```

## Elaborate

The "system context diagram" is the outermost ring of the C4 model — the picture you draw before any other. In distributed systems the same diagram doubles as a *failure-domain* diagram: each external box is a thing that can fail without taking you down. flattr's version is small enough to teach the discipline cleanly: the whole map is three rows, and only those three rows need any of the machinery in this guide. When this app grows a backend (the trigger discussed in `05`/`07`/`08`), the map grows new boxes inside *your* failure domain — and that's the moment the rest of distributed systems stops being `not yet exercised`.

## Interview defense

**Q: "Is flattr a distributed system?"**
Lead with the verdict, then the nuance.

```
  one node + three external deps it doesn't own

  [ your process ] ──HTTP──► [ Overpass / Open-Meteo / Nominatim ]
        controlled                    not controlled
```

"Strictly, no — it's a single client with no server, replicas, or workers, so there's nothing to coordinate *internally*. But it has one genuine distributed boundary: it calls three third-party HTTP APIs it doesn't own, and those can be slow, throttled, or down while my process keeps running. That's partial failure, and it's where I put retries, backoff, and graceful degradation. I'd resist calling the whole thing 'distributed' because that word implies coordination between nodes I control — there are none yet."

**Anchor:** *One boundary, three read-only deps — the map tells you what to skip.*

**Q: "Where would partial failure actually hurt you here?"**
The run-time pump path, not the build path. Build-time failures crash loudly and you re-run; run-time failures hit a user mid-interaction, so they have to degrade. Point at `useTileGraph.ts:186` vs `run-build.ts:43`.

**Anchor:** *Same provider, different blast radius — lifecycle decides the failure policy.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — the seam's failure handling in detail.
- `04-consistency-models-and-staleness.md` — why graph.json is stale and how the cache converges.
- `09-distributed-systems-red-flags-audit.md` — the ranked risks on this map.
- sibling `study-system-design` — the same map read for architecture/scale instead of failure.
