# Replication, Partitioning & Quorums

**Status: `not yet exercised`.** flattr has no second copy of any data, no shards, no quorum. There's one process and one bundled `graph.json`. This file teaches the concepts and names the exact trigger that would force each into flattr's design — because *that* is the honest, useful thing to study here.

> Per `me.md`: horizontal-scale distributed systems (multi-region replication, sharding under load) is the named gap in Rein's portfolio. This file teaches it; it does not pretend the repo evidences it.

## Zoom out, then zoom in

```
  Zoom out — where replication/partitioning WOULD live (all empty today)

  ┌─ Local state layer ─────────────────────────────────────────┐
  │  graph.json — ONE copy, ONE file, no replicas, no shards     │ ← we are here
  │              (replication slot: EMPTY)                        │
  │              (partitioning slot: EMPTY — though bbox tiling   │
  │               is a *spatial* partition seed, see below)       │
  └────────────────────────┬─────────────────────────────────────┘
                           │
  ┌─ would-be storage tier ▼ (does not exist) ───────────────────┐
  │  [ no database, no primary/replica, no quorum reads/writes ]  │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** Replication = keeping more than one copy of the same data so a copy can fail without losing the data (or so reads can spread across copies). Partitioning (sharding) = splitting *different* data across nodes so no single node holds it all. Quorums = the rule for how many copies must agree before a read/write counts, so you can tolerate some copies being down. flattr needs none of these yet because it has one copy of one dataset on one node. But it has *one* latent seed of partitioning worth naming.

## Structure pass

**Layers.** Today: just the bundled artifact. Future: a storage tier with primary/replicas/shards.

**The axis: `state` — how many copies exist, and who owns each?**

```
  The state axis — copy count, today vs the trigger

                   │ today (flattr)       │ when it changes
  ─────────────────┼──────────────────────┼─────────────────────────
  copies of data   │ 1 (graph.json)       │ N replicas for HA / read scale
  ownership        │ the bundle           │ a primary, M followers
  split across     │ none (one dataset)   │ shards by region / bbox
  agreement rule   │ n/a (one copy)       │ quorum (W + R > N)
```

**The seam that doesn't exist yet — but almost does.** flattr already partitions *space* into bbox tiles (`features/map/tiles.ts`, the corridor/viewport split in `useTileGraph.ts`). That's a partition *key* (geography) sitting right there. It's used today only to decide *what to fetch*, not *where data lives* — but it's the natural shard key the day flattr needs one. Naming that latent seam is the real finding: the partitioning scheme is already implied by the data model.

## How it works

### Move 1 — the mental model

You've shipped these shapes already, per `me.md`: buffr is SQLite-primary + Supabase-secondary (a primary/replica split), and dryrun uses GitHub-as-backend. So you know the *what*. The piece flattr would add is the *coordination*: keeping copies in sync and deciding what counts as "enough copies agreed."

```
  Replication vs partitioning — orthogonal axes

  REPLICATION (same data, many copies)    PARTITIONING (different data, split)
  ┌─────┐  ┌─────┐  ┌─────┐               ┌──────────┐ ┌──────────┐
  │ A   │= │ A'  │= │ A'' │               │ Seattle  │ │ Portland │
  └─────┘  └─────┘  └─────┘               │ graph    │ │ graph    │
   primary  follower follower             └──────────┘ └──────────┘
   survives a node loss                    no node holds the whole world

  QUORUM ties replication together:
   N copies, write needs W acks, read needs R copies; W + R > N → reads see latest
```

### Move 2 — the walkthrough (concept + the trigger in flattr)

**Part 1 — replication, and its trigger.** Replication buys two things: durability (lose a node, keep the data) and read throughput (spread reads across copies). flattr's `graph.json` is bundled into every app install — so in a loose sense it's "replicated" to every phone, but read-only and never coordinated, which is distribution, not replication. Real replication needs a *write* that must propagate to copies.

```
  Trigger for replication in flattr

  TODAY                        TRIGGER                    THEN YOU NEED
  ─────                        ───────                    ─────────────
  read-only bundled graph  →   user accounts that store → primary DB + replicas
  (no writes to replicate)     saved routes / prefs       sync + failover
```

Until there's writable, server-owned state, there's nothing to replicate. The trigger is "flattr grows a backend with user data."

**Part 2 — partitioning, and the shard key that's already chosen.** Sharding splits data so one node never holds it all. flattr's data is naturally spatial, and it *already tiles by bbox*:

```
  flattr's latent shard key — geography

  the world graph (too big for one node / one bundle)
        │  partition by bbox (the SAME key tiles.ts already uses)
        ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ shard:   │ │ shard:   │ │ shard:   │  ← each node owns a geographic region
  │ Seattle  │ │ Portland │ │ SF       │
  └──────────┘ └──────────┘ └──────────┘

  a cross-region route (rare) = the cross-shard query problem
  (today handled in-process by mergeGraphs/stitchGraph — same idea, one node)
```

The interesting honest observation: `mergeGraphs` + `stitchGraph` in `tiles.ts` already solve the *cross-partition stitching* problem in-process — joining two bbox tiles at their shared boundary nodes. If flattr ever sharded by region, that exact stitching logic is what a cross-shard route query would need, just promoted across a network boundary. The algorithm exists; only the boundary would change.

**Part 3 — quorums, and why they're far off.** A quorum is the agreement rule for replicated writes: with N copies, require W acknowledge a write and R respond to a read, set W + R > N, and any read is guaranteed to overlap at least one copy that has the latest write. It's how you stay correct while tolerating down nodes. flattr is *two* triggers away from needing this — it needs replication first (a backend with writes), then enough replicas that you'd tolerate some being down. Don't reach for quorums before you have replicas to count.

### Move 2.5 — current vs future

```
  Phase A (now)                  Phase B (backend + user data)        Phase C (scale)
  ─────────────                  ─────────────────────────────        ───────────────
  1 copy, read-only              primary DB + read replicas           shard by bbox
  bbox tiling = fetch hint       replication for saved routes         quorum reads/writes
  mergeGraphs in-process         failover on primary loss             cross-shard stitch
                                                                       (mergeGraphs, networked)
```

The migration cost is real and sequential: you can't skip to Phase C. Each phase introduces exactly one new coordination problem, which is why naming the trigger per concept matters more than teaching all three at once.

### Move 3 — the principle

Replication and partitioning are answers to two different questions — "how do I survive losing a node?" (replicate) and "how do I hold more than one node's worth of data?" (partition) — and quorums are the rule that lets replication tolerate failure without lying about freshness. The discipline flattr models *by absence* is not adding any of them until a write or a too-big dataset forces the question. The shard key, though, is worth knowing in advance: it's already geography.

## Primary diagram

```
  Replication / partitioning / quorums — flattr's status

  ┌─ TODAY ──────────────────────────────────────────────────────┐
  │  graph.json: 1 copy · read-only · bbox-tiled (fetch hint only)│
  │  replication: ✗   partitioning: ✗ (key latent)   quorum: ✗    │
  └──────────────────────────────────────────────────────────────┘
        │ trigger 1: backend + user writes
        ▼
  ┌─ replication appears ─────────────────────────────────────────┐
  │  primary + replicas for saved routes; failover                │
  └──────────────────────────────────────────────────────────────┘
        │ trigger 2: dataset outgrows one node
        ▼
  ┌─ partitioning + quorums appear ───────────────────────────────┐
  │  shard by bbox (key already chosen) · W+R>N reads/writes       │
  │  cross-shard route = mergeGraphs/stitchGraph over the network  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The canonical references are the Dynamo paper (quorums + consistent hashing for partitioning) and any primary/replica RDBMS setup (Postgres streaming replication). Consistent hashing is the standard way to assign partitions to nodes so adding a node only moves a fraction of the data — flattr's spatial key is simpler (a 2D grid), which is actually a nicer fit for geographic data than a hash ring. The reason this whole file is `not yet exercised` is structural, not a deficiency: a single-client app with a read-only dataset has no node to replicate to and no data too big to hold. Sibling `study-database-systems` owns datastore-local replication mechanics; `study-system-design` owns the scale-tradeoff decision of when to shard.

## Interview defense

**Q: "How would you scale flattr's graph beyond one city?"**
Lead with the shard key, because it's already there.

```
  shard by bbox (the key tiles.ts already uses)

  [Seattle node] [Portland node] [SF node]
        cross-region route → stitch at shared boundary nodes
        (mergeGraphs/stitchGraph, promoted across the network)
```

"The data is spatial and I already tile by bbox for fetching, so the shard key is geography — each node owns a region. A cross-region route is a cross-shard query, and I already have the in-process version of the fix: `mergeGraphs` + `stitchGraph` join two tiles at their shared boundary nodes. Sharding would promote that stitch across a network boundary. I'd add replication *before* sharding though — only once there's writable user data worth not losing. Quorums come last, when there are enough replicas that I'd tolerate some being down."

**Anchor:** *The shard key is already geography; the cross-shard stitch already exists in-process.*

**Q: "Why no replication today?"**
"Nothing to replicate — the graph is read-only and bundled, so it's distributed-to-every-client but never coordinated. Replication needs a write that must propagate. The trigger is a backend with user data."

**Anchor:** *Replication needs a write to propagate; flattr has none yet.*

## See also

- `01-distributed-system-map.md` — the single node this would multiply.
- `04-consistency-models-and-staleness.md` — quorums are how replicated reads stay fresh.
- `07-clocks-coordination-and-leadership.md` — replicas need a way to order writes (clocks/leadership).
- sibling `study-database-systems` — datastore replication mechanics.
- sibling `study-system-design` — when-to-shard as a scale decision.
