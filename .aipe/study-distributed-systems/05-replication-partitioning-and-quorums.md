# 05 — Replication, Partitioning, and Quorums

**Industry names:** replication (leader/follower, multi-leader) / sharding
(partitioning) / quorum reads & writes / failover. **Type:** Industry standard.

> **Status in flattr: NOT YET EXERCISED.** flattr has exactly one copy of one
> read-only graph file and one client. There is no second replica to keep in
> sync, no shard to route a key to, no quorum to assemble. This file teaches the
> concepts so they're not a black box, and names the precise change that pulls
> each into scope. Per the anchoring rules, nothing below claims repo evidence —
> where flattr touches the *edge* of a concept, it's labelled as an analogy, not
> an implementation.

## Zoom out, then zoom in

You know how flattr keeps one `graph.json` and reads it? Replication and
partitioning are the two answers to "what happens when one copy on one machine
isn't enough" — and they answer *different* not-enough problems. Replication is
for **too risky** (one copy, one disk, one outage = total loss / total
downtime): keep N copies so losing one doesn't lose the data. Partitioning is for
**too big** (one copy won't fit on one machine, or one machine can't serve the
load): split the data across machines so each holds a slice.

```
  Zoom out — where these would sit IF flattr had a backend

  ┌─ Client (you own) ────────────────────────────────────────────┐
  │  app reads graph data                                         │
  └───────────────────────┬───────────────────────────────────────┘
                          │  HTTP (today: straight to third parties)
                          ▼
  ┌─ ★ A SERVER flattr DOES NOT HAVE ★ ───────────────────────────┐
  │  replication: N copies of the graph, survive a node loss      │ ← not yet
  │  partitioning: graph split by region, route bbox → shard      │   exercised
  │  quorum: agree across copies on what's current               │
  └───────────────────────┬───────────────────────────────────────┘
                          ▼
  ┌─ datastore replicas / shards ─────────────────────────────────┐
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concepts are **replication** (copies for durability + availability),
**partitioning** (slices for scale), and **quorums** (the voting rule that lets a
replicated system stay correct when some replicas are down). flattr exercises none
because it never grew the server band where they live.

## The structure pass

**Layers (hypothetical, the day flattr grows a backend).** Three: the routing
layer (which node owns this bbox?), the replication layer (how many copies, who's
authoritative?), the quorum layer (how many must agree before a read/write
counts?).

**Axis — trace `where does the single point of failure move?` as you add each
mechanism.**

```
  One axis — "what's the single point of failure?" — as you layer mechanisms on

  ┌─ today: one graph.json, one client ─┐
  │ SPOF = that one file / that device  │  → lose it, lose everything
  └──────────────────┬───────────────────┘
                     │  add replication ↓
  ┌─ N replicas of the graph ───────────┐
  │ SPOF moves to: the failover logic    │  → data survives a node loss; now
  │ (who promotes a new leader?)         │     "who's in charge?" is the risk → 07
  └──────────────────┬───────────────────┘
                     │  add partitioning ↓
  ┌─ graph split by region ─────────────┐
  │ SPOF moves to: the partition map     │  → one shard down ≠ whole system down,
  │ (which node owns Seattle?)           │     but a bad routing key is now the risk
  └───────────────────────────────────────┘
```

The lesson the axis exposes: these mechanisms don't *remove* the single point of
failure — they **move it** to a smaller, more recoverable place. That's the whole
game, and it's exactly the trade flattr hasn't had to make yet.

**Seam.** The seam that *would* matter is the partition key — the function
`bbox → which node owns it`. flattr already has the *shape* of a partition key
(everything is keyed by bbox — `01`, `03`) but no partition *map* (every bbox goes
to the same place: the bundled file). The bbox is a partition key waiting for a
second partition.

## How it works

### Move 1 — the mental model: copies vs slices

Two orthogonal ideas people constantly conflate:

```
  The pattern — replication and partitioning are perpendicular

         partitioning (slices) ──────────────►
        ┌─────────┬─────────┬─────────┐
   r    │ shard A │ shard B │ shard C │   each shard = a DIFFERENT slice
   e ▲  │ (full   │ (full   │ (full   │   of the data
   p │  │  copy)  │  copy)  │  copy)  │
   l │  ├─────────┼─────────┼─────────┤   each row = a COPY of the same slice
   i │  │ replica │ replica │ replica │
   c │  │   A'    │   B'    │   C'    │   partitioning → scale
   a    └─────────┴─────────┴─────────┘   replication  → durability + availability
   tion (copies)
```

Partitioning answers "too big for one node" (split it). Replication answers "one
node can die" (copy it). Real systems do both: shard for scale, replicate each
shard for safety. flattr does neither — one slice, one copy.

### Move 2 — the kernel of each, and what breaks without it

**Replication — the kernel.** Keep N copies; one is the **leader** (takes
writes), the rest are **followers** (copy the leader, serve reads). What breaks
when a part is missing:

- **drop the leader concept** → two copies both take writes, diverge, and you have
  a conflict you can't auto-resolve (multi-leader's hard problem).
- **drop failover** → leader dies, no follower gets promoted, writes stop — you
  bought durability but not availability.
- **drop replication lag awareness** → a read hits a follower that's behind the
  leader, returns stale data, and breaks read-your-writes (`04`).

**Partitioning — the kernel.** A **partition key** + a **routing function** that
maps key → node. What breaks:

- **drop a good key choice** → hot partition (one shard gets all the traffic, e.g.
  partitioning by `country` when 90% of users are in one country).
- **drop rebalancing** → add a node and either everything reshuffles (downtime) or
  nothing moves to it (wasted capacity). Consistent hashing exists to make adding
  a node move only `1/N` of keys.

**Quorums — the kernel.** With N replicas, require W replicas to ack a write and R
to serve a read. The rule that makes it correct:

```
  The pattern — the quorum overlap rule

  N = 3 replicas,  W = 2 (write must reach 2),  R = 2 (read must hear from 2)

  if  W + R > N   then every read set OVERLAPS every write set
      2 + 2 > 3   → any 2 readers include ≥1 replica that saw the latest write
                  → you read the latest value even with 1 replica down

  drop the W+R>N rule → a read can miss every replica that has the new write
                      → you serve stale data and call it consistent (the bug)
```

The `W + R > N` overlap is the load-bearing insight people forget — it's *why*
quorums give strong consistency without contacting every replica. flattr has N=1,
so W+R>N is trivially satisfied and there's nothing to tune.

### Move 2.5 — current vs future: the trigger

```
  Phase A (now)                vs   Phase B (the trigger that flips it)
  ─────────────────                ────────────────────────────────────
  one graph.json, one client        a SHARED server hosts the graph for many users
  no replica, no shard              ↓
  bbox is a key with one target     replication: ≥2 copies so a node loss isn't an
  W+R>N trivial (N=1)               outage  → failover logic, lag awareness (→ 07)
                                    partitioning: graph too big for one node OR
                                    multi-region → bbox becomes a real partition key
                                    quorum: tune W/R so reads see latest writes

  the bbox key already exists (01,03) — only the second partition is missing.
```

The concrete trigger from `00`: **a multi-user service** (the graph stops being a
bundled asset and becomes a hosted, possibly per-region dataset). Multi-region is
the partitioning trigger; "can't afford an outage" is the replication trigger.

### Move 3 — the principle

Replication and partitioning don't eliminate the single point of failure — they
relocate it somewhere smaller and more recoverable (failover logic, the partition
map) and then *that* becomes the thing you engineer. flattr hasn't paid this cost
because it has one read-only copy and one reader; the absence is correct, not a
gap. **Reach for replication when an outage is unacceptable, for partitioning when
one node can't hold the data or the load — and never confuse the two, because they
solve perpendicular problems.**

## Primary diagram

What flattr would grow, and the SPOF relocation at each step.

```
  the path flattr WOULD take (not yet taken)

  one file, one client          SPOF = the file
        │ multi-user service
        ▼
  hosted graph + N replicas     SPOF → failover logic (07)
        │ too big / multi-region
        ▼
  partition graph by bbox       SPOF → partition map; bbox = the key (already exists)
        │ need fresh reads under replica lag
        ▼
  tune quorum W+R > N           reads overlap writes → strong consistency
```

## Interview defense

**Q: "How would you scale flattr's graph to many users and regions?"**
Verdict first: "Today it's a single bundled read-only file, so there's no
replication or sharding — and that's correct at one client. To scale, I'd host the
graph and add two perpendicular things: replication (≥2 copies + failover) so a
node loss isn't an outage, and partitioning by bbox (the key already exists —
everything's keyed by bbox) once it won't fit one node or goes multi-region. If I
add replicas and need fresh reads, I tune quorum so W+R>N and reads overlap
writes." Naming that the bbox is *already* a partition key, and that the two
mechanisms solve different problems, is the signal.

```
  the sketch you draw

  too risky  → replication (copies)   → SPOF moves to failover
  too big    → partitioning (slices)  → SPOF moves to partition map
  stale reads→ quorum  W + R > N      → read set overlaps write set
```

**Q: "Why does W + R > N matter?"**
"It guarantees the read set and write set overlap by at least one replica, so any
read hears from at least one replica that has the latest write — that's how you
get strong consistency without contacting all N. Violate it and a read can miss
every replica that has the new value and serve stale data." That overlap is the
one quorum fact interviewers check for.

**Anchor:** *Replication is copies for durability; partitioning is slices for
scale; they're perpendicular. flattr has neither — one read-only copy, one reader
— and the bbox is a partition key waiting for a second partition.*

## See also

- `01` — why flattr has one node (the system map).
- `03` — the bbox as a natural key (here it'd become the partition key).
- `04` — replication lag is a read-your-writes / staleness problem.
- `07` — failover needs leader election, which flattr also doesn't have yet.
- sibling **system-design** — the scale tradeoffs; sibling **database-systems** —
  replication as a storage-engine feature.
