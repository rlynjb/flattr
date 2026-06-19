# Replication, partitioning, and quorums
### replicas, shards, partition keys, quorum reads/writes, failover — `not yet exercised`
**Industry name:** replication, sharding/partitioning, quorum consensus · **Type:** Industry standard

## Zoom out, then zoom in

Verdict first, because honesty is the lesson here: **replication, partitioning, and quorums are `not yet exercised` in flattr.** There is no datastore you own with more than one copy, no shard map, no quorum read. There can't be — you have one process live at a time reading one static file. This file teaches the patterns anyway (they're load-bearing distributed-systems vocabulary) and names the *one* thing in the repo that rhymes with partitioning, plus the exact trigger that would make all of this real.

```
  Zoom out — where replication WOULD live (and why it's empty today)

  ┌─ UI layer (the phone) ──────────────────────────────────────┐
  │  reads ONE bundled graph.json — no replica to choose         │
  └───────────────────────────┬─────────────────────────────────┘
  ┌─ Coordination layer ──────▼─────────────────────────────────┐
  │  ┌ ★ where a replica set / shard router WOULD sit ★ ┐        │ ← empty
  │  │   (no owned datastore → nothing to replicate)     │        │
  │  └────────────────────────────────────────────────────┘      │
  └───────────────────────────┬─────────────────────────────────┘
                              │  (no quorum hop — single copy)
  ┌─ Storage layer ───────────▼──────────────────────────────────┐
  │  graph.json — ONE frozen file, bundled. zero replicas.        │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: replication answers "if one copy dies, can I still read/write?"; partitioning answers "the data is too big for one machine — how do I split it?"; quorums answer "with N copies, how many must agree before I trust a read or commit a write?" flattr asks none of these because N=1 and the data fits in a bundled JSON. The interesting bit is the *one near-miss*: the geographic bbox split in `useTileGraph` looks like partitioning but isn't (no separate owners, no routing layer that picks a shard).

## Structure pass

**Layers.** UI → (the empty replica/shard slot) → storage (one file). The structure pass here is mostly about seeing *why the middle layer is empty*.

**The axis: state ownership — "how many copies of the truth exist, and who arbitrates between them?"**

```
  One question — "how many authoritative copies?" — traced down

  ┌──────────────────────────────────────┐
  │ phone app                             │  → reads 1 copy. no choice to make.
  └──────────────────────────────────────┘
      ▼
  ┌──────────────────────────────────────┐
  │ (replica selector / shard router)     │  → DOES NOT EXIST. nothing to route.
  └──────────────────────────────────────┘
      ▼
  ┌──────────────────────────────────────┐
  │ graph.json                            │  → exactly 1 authoritative copy.
  └──────────────────────────────────────┘    no quorum, no failover, no conflict.
```

**The seam.** There is no seam, and that absence *is* the finding. A replication seam exists where two copies of the same data could disagree and something must reconcile them. flattr has exactly one copy of everything it owns, so there's no place for that disagreement to live. Name it plainly: no quorum because no replicas; no replicas because no owned multi-copy datastore.

## How it works

#### Move 1 — the mental model

You know replication from any "primary + read replica" Postgres setup: writes go to one node, reads can fan out to copies, and if the primary dies a replica gets promoted. Partitioning you know from "users A–M on shard 1, N–Z on shard 2." Quorums you know from "write succeeds when 2 of 3 replicas ack."

```
  The patterns flattr does NOT have — for vocabulary

  REPLICATION            PARTITIONING            QUORUM (N=3, W=2, R=2)
  ───────────            ────────────            ──────────────────────
   write ──► primary      key="seattle" ─┐        write ──► [r1 ✓][r2 ✓][r3 ✗]
              │ replicate            hash │                    2 of 3 ack ⇒ commit
        ┌─────┼─────┐                ▼                         read  ◄── [r1][r2]
        ▼     ▼     ▼          ┌──────────┐                    W+R>N ⇒ overlap ⇒
      replica replica         │ shard 0/1 │                    you read your write
```

flattr's actual shape is the degenerate one: a single box. No fan-out, no hash router, no ack-counting.

#### Move 2 — the one near-miss, walked honestly

**Geographic bbox coverage looks like partitioning — but it isn't.** Bridge from sharding by key. `useTileGraph` splits the world by *geography*: a base region, a viewport region, a corridor region, each a bbox-bounded `Graph`, merged and stitched at boundaries (`useTileGraph.ts:72-85`). That *resembles* spatial partitioning (the classic way map data is sharded). Here's why it falls short of the real pattern:

```
  Why bbox regions are NOT a partition scheme

  REAL partitioning              flattr's regions
  ─────────────────              ─────────────────
  N independent owners,          ONE process owns ALL regions; they're
  a router picks the shard       just merged in-memory, no router
  shards never overlap           regions deliberately OVERLAP + stitch
                                   at seams (covers()/stitchGraph)
  failure of a shard = data       failure of a region fetch = degrade,
  unavailable for its keys         base graph still covers it
```

*What this tells you:* the bbox split is a *caching/coverage* strategy (fetch only what's on screen), not a partitioning strategy (split ownership across machines). The tell is that there's no routing layer choosing *which owner* holds a bbox — one process holds them all and merges. Calling it partitioning in an interview would be wrong; calling it spatial coverage is right.

#### Move 2.5 — what makes this real (the trigger)

```
  Phase A (now) vs Phase B (§11 D2/E2 served multi-city graph)

  NOW                              SERVED MULTI-CITY GRAPH
  ───                              ───────────────────────
  1 bundled graph.json             graph per city, served from N instances
  no replicas                      read replicas for graph availability
  no shards                        PARTITION by city (or geohash tile):
                                     a router maps bbox → city graph → shard
  no quorum                        if writes (rebuilds) replicate, quorum
                                     to avoid serving a half-rebuilt graph
  failover irrelevant              instance dies ⇒ promote/route around it
```

This is precisely spec §11 D(2) ("server-side A* in an API route, graph cached from Blobs: scales to bigger cities") and §11 E(2) ("all of Seattle / multiple cities up front"). The moment the graph is *served* rather than *bundled*, and big enough to not fit one instance's memory, partitioning-by-city and read-replicas-for-availability become real. Quorum only appears if rebuilds write to replicated storage and you must avoid reading a half-applied rebuild.

#### Move 3 — the principle

Replication, partitioning, and quorums are the price of having *more than one copy of state you own*. flattr pays nothing because it owns exactly one copy. The general lesson worth carrying: **don't add replication machinery until you actually own multiple copies that can disagree** — these patterns are answers to problems (a copy died / data won't fit / copies diverged) that you should confirm you *have* before importing their complexity. flattr correctly has none of them.

## Primary diagram

The recap — what exists (one copy) vs. the slots that are empty.

```
  Replication/partitioning/quorum in flattr — recap

  ┌─ EXISTS ────────────────────────────────────────────────────┐
  │  graph.json (1 copy)  ·  in-memory bbox regions (coverage,    │
  │  not shards)  ·  merge+stitch at seams                        │
  └───────────────────────────────────────────────────────────────┘

  ┌─ `not yet exercised` (the empty slots) ─────────────────────┐
  │  ✗ read replicas      ✗ shard router / partition key         │
  │  ✗ quorum reads/writes ✗ failover / leader promotion         │
  │                                                              │
  │  trigger to fill them: §11 D2/E2 served multi-city graph     │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** There is no replication/partition/quorum code to walk. The honest implementation note is the *near-miss* — the bbox-region merge that an interviewer might mistake for sharding:

```
  mobile/src/useTileGraph.ts  (lines 72–85, the merged graph)

  baseGraph
    ? stitchGraph(
        mergeGraphs([
          baseGraph,                        ← region 1 (stale snapshot)
          ...(corridor ? [corridor.graph] : []),  ← region 2 (route bbox)
          ...(view ? [view.graph] : []),          ← region 3 (viewport bbox)
        ])
      )
    : null
       │
       └─ this MERGES overlapping regions into one in-memory graph. it is NOT
          partitioning: no router picks an owner, regions overlap on purpose,
          and one process holds all three. it's spatial COVERAGE/caching.
          (the runtime/coverage angle lives in study-runtime-systems.)
```

That's the whole implementation surface. Everything else in this file is `not yet exercised`.

## Elaborate

The reason to learn these patterns even though flattr lacks them: they're the vocabulary every system-design interview reaches for, and flattr is a *perfect foil* for explaining when they're *not* needed. The most common junior mistake is reaching for replication/sharding reflexively; the senior move is asking "do I own more than one copy that can disagree?" and, for flattr, answering "no — so I don't pay for any of it."

The connection to adjacent topics: replication is how `04`'s served-graph future stays *available* (a replica covers for a dead instance); partitioning is how it *scales* past one instance's memory; quorum is how its rebuilds stay *consistent* across replicas. All three are downstream of the same trigger (§11 D2/E2), and none should be added before it. For the datastore-local side of consistency — how a single store stays durable — see `.aipe/study-database-systems/`; this file owns only the *cross-copy* coordination, which is currently empty.

## Interview defense

**Q: "How is your graph data replicated and sharded?"**
It isn't, and that's correct for the design. There's one bundled `graph.json` — a single authoritative copy read by one device at a time. No replicas to keep in sync, no shard router, no quorum. The bbox-region merge in `useTileGraph` *looks* like spatial sharding but isn't: it's in-memory coverage caching, with overlapping regions merged by one process, no ownership split. I'd only introduce replication and partition-by-city if I built the spec's §11 D2 server-side served graph — replicas for availability, city shards for memory. Adding them now would be complexity with no problem to solve.

```
   one process ──► one graph.json   (no replica to choose, no shard to route)
   "do I own >1 copy that can disagree?"  → no  → no replication needed
```
*Anchor: don't replicate until you own copies that can disagree.*

**Q: "Isn't fetching tiles by region a form of sharding?"**
No — it's coverage caching. Real sharding splits ownership across machines with a router picking the shard and non-overlapping key ranges. My regions deliberately overlap, get stitched at boundaries, and are all owned by one process with no router. The giveaway is the overlap-and-stitch: shards don't overlap; caches do. *Anchor: shards split ownership; my regions just cache coverage.*

## Validate

1. **Reconstruct:** define replication, partitioning, and quorum in one line each. Why does flattr need zero of them today?
2. **Explain:** give two concrete reasons the bbox regions in `useTileGraph.ts:72-85` are coverage caching, not partitioning.
3. **Apply:** the spec ships §11 E2 (all cities up front, served). Which of the three patterns appears first, and what's the partition key?
4. **Defend:** a reviewer insists you "add a read replica for resilience." Argue why there's nothing to replicate at N=1 and what would have to exist first.

## See also

- `04-consistency-models-and-staleness.md` — the staleness story a served+replicated graph would inherit.
- `07-clocks-coordination-and-leadership.md` — failover/leader promotion, also `not yet exercised`.
- `.aipe/study-system-design/` — the served-graph scaling decision at the architecture altitude.
- `.aipe/study-runtime-systems/` — the in-memory region merge as an execution-model concern.
