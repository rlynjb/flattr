# 01 — Distributed System Map

**Industry names:** coordination map / system context diagram / failure-domain
map. **Type:** Industry standard (the "draw the boxes and the boundaries" move
that opens every distributed-systems design).

## Zoom out, then zoom in

You know how before you debug a request you draw "browser → API → DB" on a
napkin so you know which box to blame? The distributed-system map is that napkin,
drawn deliberately, with one extra column most napkins skip: **which boxes can
fail independently of the others.** That column is the whole point.

Here's flattr as labelled bands. The thing to internalize: almost everything is
in *one* node you own, and there's exactly *one* line that leaves it.

```
  Zoom out — flattr's nodes and the one boundary that leaves your control

  ┌─ Build-time node (you own) — pipeline/, Node ─────────────────┐
  │  run-build.ts → fetchOverpass → buildGraph → graph.json       │
  └───────────────────────────┬───────────────────────────────────┘
                              │  bakes a static artifact (no live link)
                              ▼
  ┌─ Client node (you own) — mobile/, Expo/RN ────────────────────┐
  │  MapScreen → useTileGraph → A* router over the merged graph    │
  │  reads graph.json + fetches more tiles on demand              │
  └───────────────────────────┬───────────────────────────────────┘
                              │  ★ THE ONE DISTRIBUTED SEAM ★   ← we are here
                              │  HTTP, over a network you don't control
  ┌─ Third-party nodes (you do NOT own) ──────────────────────────┐
  │  Overpass   ·   Open-Meteo   ·   Nominatim                     │
  │  independently slow / throttled / down                        │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is the **failure domain** — the set of components that fail
together. flattr has three failure domains (build node, client node, the
third-party fleet), and a distributed-systems bug is almost always a wrong
assumption about what one domain promises another across that HTTP line. Map the
domains first; every other file in this guide is a mechanism hanging off this
map.

## The structure pass

**Layers.** Three: the build pipeline (Node, runs once, offline-after),
the client (Expo app, runs continuously on a phone), and the third-party API
fleet (Overpass / Open-Meteo / Nominatim). The first two you own and ship; the
third you only *call*.

**Axis — trace `failure ownership` down the layers.** Hold one question
constant: *when this layer's work fails, who notices and who recovers?*

```
  One axis — "when work fails here, who recovers?" — held down the layers

  ┌─ build pipeline ────────────────────┐
  │ Overpass/elevation fails →          │  → a HUMAN recovers
  │ run-build.ts exits non-zero         │     (re-run the build later)
  └──────────────────┬──────────────────┘
                     │  the answer flips here ↓
  ┌─ client app ────▼───────────────────┐
  │ tile fetch fails →                  │  → the CODE recovers
  │ flat fallback + self-heal retry     │     (degrade, retry, keep last data)
  └──────────────────┬──────────────────┘
                     │  the answer flips again ↓
  ┌─ third-party fleet ▼────────────────┐
  │ THEY fail →                         │  → NOBODY on your side recovers them;
  │ you only observe a status code      │     you can only classify + react
  └─────────────────────────────────────┘
```

The answer flips at every layer — and *that contrast is the lesson*. The build
pipeline fails loud and lets a human retry (acceptable: it's a one-shot offline
job). The client must never fail loud — a hiker mid-route can't "re-run the
build" — so it recovers in code. The third party you can't recover at all; you
can only classify its response and decide what to do.

**Seams.** The load-bearing seam is the HTTP line to the third parties, because
*two* axes flip across it at once: **trust** (your code → code you can't see or
change) and **failure containment** (a clean function call → a thing that can
hang, 429, or 503). That double-flip is why this seam gets its own file for
retries (`02`), its own file for why retries are safe (`03`), and its own file
for what stale data it leaves behind (`04`). The build→client seam is *not*
distributed at all — it's a file on disk, no live coordination — which is itself
a design choice worth seeing (`04`).

## How it works

### Move 1 — the mental model: nodes, messages, failure domains

A distributed-system map is three lists and one rule. The lists: **nodes**
(things that run), **messages** (what crosses between them), **ownership** (who
controls each node). The rule: **draw a box around every set of components that
fails together** — that box is a failure domain, and messages crossing a
failure-domain boundary are where all your distributed bugs live.

```
  The pattern — a system map is nodes + messages + failure-domain boxes

       ┌── failure domain A ──┐        ┌── failure domain B ──┐
       │   node 1  ──msg──►   │ ══════►│   node 3             │
       │   node 2             │  the   │   (independent fate) │
       └──────────────────────┘ boundary└─────────────────────┘
                                 ▲
                          bugs live HERE: A assumes
                          something about B that B
                          doesn't actually promise
```

For flattr: domain A = {build pipeline} OR {client app} (they never run at the
same time, so they're separate maps), domain B = {the third-party fleet}. The
message is an HTTP request carrying a bbox or coordinate; the response carries
OSM ways or elevation numbers. The bug class: *the client assumes elevation will
come back; sometimes Open-Meteo 429s instead.* The whole of `02`–`04` is flattr
handling that one assumption gap correctly.

### Move 2 — walk the map, one node at a time

**The build node — `pipeline/run-build.ts`.** This runs once, on your machine,
to produce `data/graph.json` (shipped as `mobile/assets/graph.json`). It's a
node in the distributed sense only while it's making outbound calls.

```
  Build node — one outbound seam, fail-loud recovery

  ┌─ pipeline/run-build.ts (Node) ──────────────────┐
  │  main():                                         │
  │    fetchOverpass(BBOX)  ──HTTP──►  Overpass      │  hop 1: streets
  │    buildGraph(...)                               │
  │       └ sampleElevations ──HTTP──► Open-Meteo    │  hop 2: heights
  │    writeGraph("data/graph.json")                 │  hop 3: to local disk
  └──────────────────────────────────────────────────┘
        any HTTP hop throws → main().catch → process.exitCode = 1
        (run-build.ts:54-57)  → a human re-runs it
```

`run-build.ts:40-52` is the whole node: pick an elevation provider, fetch OSM,
build, write to disk. The recovery contract is the last three lines
(`run-build.ts:54-57`) — uncaught error sets a non-zero exit code. That's
correct for a build step: loud failure, no auto-retry of the whole job, a human
decides when to re-run. (Note the elevation provider itself *does* retry
internally — see `02` — so "fail loud" only triggers after the inner retries are
exhausted.)

**The client node — `mobile/src/useTileGraph.ts`.** This is the live node: it
runs the whole time the app is open, fetching extra street tiles as you pan and
route. It crosses the *same* seam (Overpass + Open-Meteo) but has the opposite
recovery contract — it must never fail loud.

```
  Client node — same seam, code-recovers instead of fail-loud

  ┌─ mobile/src/useTileGraph.ts (Expo/RN) ──────────────────┐
  │  pump():                                                 │
  │    fetchOverpass(bbox)  ──HTTP──►  Overpass              │  hop 1
  │    buildGraph(... bestEffortElevation(...) )             │
  │       └ sample ──HTTP──► Open-Meteo                      │  hop 2
  │          └ on throw → flat 0m + mark degraded            │  ← recover in code
  │    setView/setCorridor(region)                           │
  └──────────────────────────────────────────────────────────┘
       Overpass throws (line 219) → keep last region, retry on next pan
       elevation throws (line 20-31) → degrade, self-heal later (02, 04)
```

Same two hops as the build node, but read `useTileGraph.ts:184-226`: every
failure path keeps the app alive. Overpass failure (`:219`) silently keeps the
last good region. Elevation failure degrades to flat grades. *That* is the
failure-ownership flip from the structure pass, made concrete in code.

**The third-party fleet — Overpass / Open-Meteo / Nominatim.** Three nodes you
don't own, each with its own independent fate. They share one trait that
dominates flattr's whole design: **they're free, public, and rate-limited.** The
comments say it directly — "stay under the free Overpass/Open-Meteo rate limits"
(`useTileGraph.ts:7`), "free-tier friendly" (`elevation.ts:96`), Nominatim's
"~1 req/sec" policy (`geocode.ts:2`). Every defensive mechanism downstream
(retry/backoff, dedup, cache, single-flight) exists because these three nodes
will throttle you the moment you're impolite.

### Move 3 — the principle

A distributed-system map is worth drawing the instant *one* line in your
architecture crosses into something you don't control. flattr proves the
contrapositive too: the build→client handoff is a file on disk, no live line, so
it's *not* a distributed problem and needs none of this machinery. **The map's
job is to find the one line that matters and put a failure box on each side —
the number of those lines, not the number of boxes, is your distributed-systems
complexity.** flattr has one. That's why this is a short field with a few deep
files, not a wide one.

## Primary diagram

The full map: nodes, the one seam, the failure-ownership flip, and where each
later file plugs in.

```
  flattr — the complete coordination map

  ┌─ DOMAIN: build node (offline, fail-loud) ─────────────────────┐
  │  run-build.ts ─► fetchOverpass ─► buildGraph ─► graph.json    │
  └───────────────────────┬───────────────────────────────────────┘
            bakes ↓ (static file, NO live link — see 04 staleness)
  ┌─ DOMAIN: client node (live, code-recovers) ───────────────────┐
  │  useTileGraph.pump ─► fetchOverpass ─► buildGraph(bestEffort)  │
  │     graph (routing, incl. degraded)   displayGraph (excl.)     │
  └───────────────────────┬───────────────────────────────────────┘
                          │  ★ THE SEAM ★  trust flips + failure flips
                          │  HTTP · retries(02) · safe-by-read(03)
                          ▼
  ┌─ DOMAIN: third-party fleet (uncontrolled, rate-limited) ──────┐
  │  Overpass        Open-Meteo         Nominatim                  │
  │  502/503/504/429  429               4xx/5xx                    │
  │  → retry (02)     → backoff (02)    → throw (no retry yet)     │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "failure domain" framing comes from reliability engineering (the blast-radius
question: if X dies, what dies with it?). In a big system you draw dozens of
these — every service, every replica set, every availability zone. flattr's value
as a *study* object is that it has the minimum non-trivial count: one seam, two
sides. That makes it the perfect place to learn the moves (`02`–`04`) without the
combinatorial mess of a real microservice fleet — and an honest baseline for the
`not yet exercised` files (`05`, `07`, `08`), which all begin with "the day flattr
grows a *second* line that crosses into something it doesn't control."

What's deliberately absent: no service mesh, no load balancer, no service
discovery, no inter-service auth. There's nothing to discover — the three
third-party endpoints are hardcoded URLs (`overpass.ts:4`, `elevation.ts:106`,
`geocode.ts:5`). That's correct at this scale and a thing you'd add the day you
front these calls with your own server.

## Interview defense

**Q: "Walk me through this system's distributed architecture."**
Lead with the verdict: "It's a single client plus an offline build step, and the
only distributed boundary is the HTTP line to three free third-party APIs —
everything else is one node." Then draw the three bands and name the
failure-ownership flip: build node fails loud (human re-runs), client node
recovers in code (degrade + self-heal), third parties you can only classify and
react to. The signal is that you found the *one* seam instead of treating every
box as a distributed problem.

```
  the sketch you draw while answering

  you own ──────────────────────────┐   you don't own
  build (fail loud) │ client (recover)│   Overpass/Open-Meteo/Nominatim
                    └─── one HTTP seam ┴──► (slow/429/down, independent fate)
```

**Q: "Why isn't the build → app handoff a distributed problem?"**
Because it's a static file, not a live link — `graph.json` is written once and
read forever, no coordination, no partial failure, no shared mutable state across
a network. The cost is staleness (`04`), not a consistency bug. Naming that the
absence of a network line removes the whole problem class is the point.

**Anchor:** *One seam, two failure boxes — and the build handoff is a file, not a
network call, so it isn't on the map at all.*

## See also

- `02-partial-failure-timeouts-and-retries` — the mechanics on the one seam.
- `03-idempotency-deduplication-and-delivery-semantics` — why crossing it twice
  is safe.
- `04-consistency-models-and-staleness` — what the static-file handoff leaves
  stale.
- `09-distributed-systems-red-flags-audit` — the ranked risks on this map.
- sibling **system-design** — the same boxes viewed as architectural shape.
