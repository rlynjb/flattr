# Chapter 2 — The Architecture

After the pitch lands, the interviewer says "walk me through the system."
This is the whiteboard moment. The goal is to draw flattr's architecture
from scratch, confidently, in ninety seconds or less — and to trace a single
request end-to-end so they see you understand the *flow*, not just the box
diagram.

flattr's architecture has one organizing idea, and if you lead with it
everything else falls into place: there are **two systems, not one**. A
build-time pipeline that produces a static artifact, and a runtime app that
reads it. They never run at the same time. They share exactly one thing —
`graph.json`. Get that split on the board first, and every follow-up has a
home.

---

## The architecture — full diagram

This is the diagram you draw at the whiteboard. Practice it until you can
reproduce it cold. The horizontal line in the middle is the whole story.

```
  flattr architecture — build time above the line, runtime below

  ══════════════════ BUILD TIME (pipeline/, your machine, offline) ══════
                                                                          
   ┌──────────┐   ┌─────────┐   ┌──────────────┐   ┌─────────┐   ┌──────┐ 
   │ Overpass │──►│ split   │──►│  Open-Meteo  │──►│ grade   │──►│build-│ 
   │ OSM ways │   │ to edges│   │  elevation   │   │ per edge│   │graph │ 
   │overpass.ts│  │split.ts │   │elevation.ts  │   │grade.ts │   │.ts   │ 
   └──────────┘   └─────────┘   └──────┬───────┘   └─────────┘   └───┬──┘ 
                                free API, 429s        signs grade        │ 
                                under load            by direction       ▼ 
                                                              ┌────────────────┐
                                                              │  graph.json    │
                                                              │ seattle-mvp    │
                                                              │ 1621 nodes     │
                                                              │ 1879 edges     │
                                                              └───────┬────────┘
  ════════════════════════════════════════════════════════════════════│══════
                                                       bundled, read-only│
  ══════════════════ RUNTIME (mobile/, Expo ~56 / RN 0.85 / React 19) ──▼──────
                                                                          
   ┌─ UI LAYER ──────────────────┐      ┌─ ENGINE LAYER (features/, pure TS)─┐
   │ MapScreen.tsx               │      │                                    │
   │  ├ AddressBar (geocode)     │      │  loadGraph()      reads graph.json │
   │  ├ GradeSlider → userMax    │ ───► │  nearestNode()    coord → node id  │
   │  ├ MapLibre <Map>           │      │  directedAstar()  ONE search()     │
   │  └ RouteSummaryCard         │ ◄─── │    ├ cost.ts   directed penalty    │
   │                             │      │    ├ pqueue.ts hand-rolled heap    │
   └─────────────────────────────┘      │    └ summary.ts climb/dist totals  │
                                        └────────────────────────────────────┘
                                                                          
   NO server. NO database. NO network in the routing hot path.            
```

The arrows below the line are all in-process function calls — no HTTP, no
sockets, no query. That absence is a design choice, and Chapter 3 defends
it. Here, the job is to make the interviewer *see* it.

---

## The big question — "walk me through the system"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Walk me through the architecture of flattr."          │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Can you operate at the right altitude — start at the   │
│   system shape, not a function? Do you know where state  │
│   lives and where the boundaries are? Can you trace a    │
│   request without getting lost? And: is the "no backend" │
│   a thing you understand, or a thing you didn't get to?  │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice — start wide, then trace one request:

> "There are really two systems. There's a build-time pipeline that runs on
> my machine, offline, and produces a single static artifact — `graph.json`.
> And there's the runtime app, an Expo / React Native client, that reads
> that artifact and does all the routing on-device. They never run together;
> they meet at the one file.
>
> The pipeline pulls street geometry from OpenStreetMap via Overpass, splits
> ways into edges, hits the Open-Meteo elevation API to get elevation at each
> node, computes the grade per edge — signed, by direction — and writes
> `graph.json`. For the Seattle slice that's about 1600 nodes and 1900 edges.
>
> At runtime, when you tap two points, here's the flow: the UI snaps each tap
> to the nearest graph node with `nearestNode`, then calls `directedAstar`
> with the two node ids and your `userMax`. That runs my A* search over the
> graph, returns a path, and the UI renders it as a colored line on MapLibre
> plus a summary card with distance and total climb. No server is involved at
> any point — the graph is in memory, the search is a function call.
>
> The deliberate part is that 'no backend.' The graph is small and static,
> so a server would just add a network hop and an availability dependency for
> no benefit. I build offline and bundle."

That last paragraph is the one that separates you. You're not apologizing
for the missing backend — you're explaining why it isn't missing, it's
*absent on purpose*.

---

## Trace one request — the move that proves you understand it

A box diagram shows you can draw. A request trace shows you understand. When
they say "what happens when I tap two points," walk this:

```
  One route request — every hop labelled (all in-process)

  ┌─ UI: MapScreen.tsx ─────────────────────────────────────────┐
  │ user taps START, then END                                    │
  │   startPt = {lat, lng}     endPt = {lat, lng}                │
  └───────────────────────────┬─────────────────────────────────┘
              hop 1: snap each coord to a node
                              │  nearestNode(graph, pt)   nearest.ts:5
                              ▼
  ┌─ ENGINE: nearest.ts ────────────────────────────────────────┐
  │ scan every node, haversine distance, keep the closest        │
  │   → startId, endId                                           │
  └───────────────────────────┬─────────────────────────────────┘
              hop 2: route under the grade limit
                              │  directedAstar(graph, startId,
                              │    endId, userMax)        astar.ts:156
                              ▼
  ┌─ ENGINE: astar.ts search() ─────────────────────────────────┐
  │ A* with gradeCostDirected + haversineHeuristic               │
  │   pop frontier → relax edges → cost = len*(1+penalty(grade)) │
  │   → Path { nodes, edges, cost, lengthM, steepEdges }         │
  └───────────────────────────┬─────────────────────────────────┘
              hop 3: shape for display + totals
                              │  routeToGeoJSON + routeSummary
                              ▼
  ┌─ UI: MapScreen.tsx ─────────────────────────────────────────┐
  │ MapLibre draws the colored line; RouteSummaryCard shows       │
  │ distance, total climb, steep-edge count                       │
  └─────────────────────────────────────────────────────────────┘
```

Three hops, zero network calls. Name that explicitly while you draw it:
"notice every arrow here is a function call — there's no HTTP in this path."
That sentence is worth more than the whole diagram.

```
┃ "There are two systems — a build-time pipeline and a
┃  runtime app — and they meet at exactly one file."
```

---

## Where they'll interrupt — and what to say

Interviewers interrupt the architecture walk. It's a probe. Here's the tree
of the three most likely interruptions and your line for each.

```
  You're mid-walk through the architecture.
        │
        ├─► "Wait — there's no database at all?"
        │     "Correct. The graph is the only state, it's static, and it's
        │      bundled with the app. There's nothing to persist between
        │      sessions, so there's no DB. If I added saved routes or user
        │      accounts, that's the first thing that changes." (→ Ch. 3, 7)
        │
        ├─► "How does the tap know which node to route from?"
        │     "nearestNode does a linear scan — haversine to every node,
        │      keep the closest (nearest.ts:5). It's O(N). At 1600 nodes
        │      it's nothing; it's the first thing I'd index if N grew."
        │      (→ Ch. 4: the k-d tree is the first bottleneck)
        │
        └─► "Where does the route actually get computed — client or server?"
              "Client. On-device. The graph's in memory after loadGraph(),
               and directedAstar is a synchronous function call. No round
               trip." (→ Ch. 2 request trace, Ch. 5 failure surfaces)
```

The `nearestNode` interruption is a gift — it's the natural on-ramp to your
scale story (Chapter 4). When they ask about it, you get to volunteer "it's
O(N), the k-d tree is my first optimization," which is exactly the
forward-looking signal Chapter 4 is built on.

---

## When the architecture question goes past your depth

The architecture walk has one trapdoor: they ask you to redesign it as a
served system, live. That's the gap.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "OK, now make the graph server-side and serve     ║
║   routing as an API. Walk me through that architecture."      ║
║                                                               ║
║   You can reason about this, but you haven't BUILT a served   ║
║   routing system, and the real distributed-systems questions  ║
║   underneath it — how you shard a graph that doesn't          ║
║   partition cleanly, how you cache routes, how you handle a   ║
║   cross-shard query — are genuinely outside what you've       ║
║   shipped.                                                    ║
║                                                               ║
║   Say:                                                        ║
║   "I can sketch the obvious version — the graph loads into a  ║
║    stateless service, routing becomes a request that returns  ║
║    a path, and you scale by adding instances since each       ║
║    request is independent. Where I'd be honest about my       ║
║    limits is sharding: a road graph doesn't partition         ║
║    cleanly the way a user table does, because routes cross    ║
║    any boundary you draw. I know that's the hard problem; I   ║
║    haven't had to solve it in production. I'd want to read    ║
║    how the real routing engines handle cross-shard queries    ║
║    before I claimed a design."                                ║
║                                                               ║
║   What this signals: you can produce the stateless-service    ║
║   answer, you can NAME the genuinely hard sub-problem          ║
║   (graph partitioning), and you don't pretend to have solved  ║
║   it. That's exactly the senior posture.                      ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "I'd shard the graph by region and use consistent hashing." ║
║   — said fast, it invites "what happens to a route that       ║
║   crosses two regions?" and now you're underwater on a        ║
║   design you invented thirty seconds ago.                     ║
╚═══════════════════════════════════════════════════════════════╝
```

```
┃ "Every arrow below the line is a function call.
┃  There is no network in the routing path — on purpose."
```

---

## What you'd change

The one architectural decision worth reconsidering is the data-loading seam.
Today `loadGraph()` (loadGraph.ts:9) just casts the bundled JSON to a `Graph`
and trusts it completely — no validation, no schema check. That's fine while
you're the only one producing the file, but it's the boundary I'd harden
first: a real system has a validated, versioned graph-loading interface so a
malformed or stale artifact fails loudly at load instead of silently
mis-routing. Chapter 7 expands this into the full counterfactual.

---

## One-page summary — read this the night before

**Core claim:** flattr is two systems — a build-time pipeline and a runtime
app — meeting at one static file (`graph.json`). Lead with that split, trace
one request, and name "no backend" as a decision.

**Questions covered:**
- *"Walk me through the architecture"* → two systems, the file between them,
  one request traced UI → nearest → astar → render. All in-process.
- *"No database at all?"* → graph is the only state, static, bundled.
- *"Client or server routing?"* → client, on-device, synchronous call.
- *"Make it a served system"* → stateless service is easy; graph sharding is
  the hard part I haven't shipped. Say so.

**Key files to name:** `nearestNode` (nearest.ts:5, O(N)), `directedAstar`
(astar.ts:156), `loadGraph` (loadGraph.ts:9, unvalidated), the build pipeline
under `pipeline/`.

**Pull quotes:**
- "Two systems, meeting at exactly one file."
- "Every arrow below the line is a function call — no network, on purpose."

**What you'd change:** Harden the `loadGraph` seam — validate and version the
graph artifact instead of trusting the cast.
