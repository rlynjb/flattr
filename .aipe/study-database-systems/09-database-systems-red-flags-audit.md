# Database systems — red-flags audit

**Industry name(s):** storage-engine risk audit / consistency-risk ledger ·
**Type:** Project-specific audit

## Zoom out, then zoom in

This is the ranked-risk file. It does two things: lists the storage-and-index
risks the repo *does* carry (grounded in real `file:line`), and ledgers every
classic DB topic that's `not yet exercised` with the trigger that would activate
it. The framing matters — most "risks" here are not bugs; they're the deliberate
absences that fall out of the read-only-artifact design.

```
  Zoom out — what this audit covers

  ┌─ Real risks (in the read path) ──────────────────────────────────┐
  │  full scans · transient index rebuild · unchecked FKs · non-     │
  │  atomic build write · version skew                               │
  └───────────────────────────┬──────────────────────────────────────┘
  ┌─ The not-yet-exercised ledger ────▼──────────────────────────────┐
  │  query planner · transactions · concurrency control · WAL ·      │
  │  replication — each with its activation trigger                  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: the verdict is that **flattr's data layer is correct for its scope, with
exactly one actionable bug (non-atomic build write) and a short list of latent
scale risks (full scans).** Everything else marked a "risk" is a tradeoff the
design made on purpose.

## The structure pass

**Layers.** Two risk classes: read-path risks (live code, ranked by consequence)
and absent-machinery risks (the `not yet exercised` ledger, ranked by when
they'd bite).

**The axis: consequence — what specifically breaks, and when?** Every finding is
scored on "what's lost" and "at what scale/trigger." That's the only axis worth
holding here.

**Seams.** The seam between "real today" and "real later" is **the first runtime
write to shared state.** Files `05`–`08` all hinge on it. The audit makes that
seam explicit so you know which risks are live and which are gated behind a
feature flattr doesn't have yet.

## Ranked findings — real risks in the current code

### 1. Build write is not crash-atomic (the one actionable bug)

**Consequence:** a crash, kill, or full disk during the build leaves a corrupt
`graph.json`. A corrupt artifact fails to parse at load, breaking the app's data
entirely. **Evidence:** `pipeline/run-build.ts:12` —
`writeFileSync(path, JSON.stringify(graph))`, written in place with no temp+rename.
**Fix:** write to `graph.json.tmp`, then `rename` over the target (atomic on
POSIX). One small change. **Severity: medium** — low probability, high blast
radius, trivial fix.

### 2. `nearestNode` is an un-indexed full scan (latent scale risk)

**Consequence:** O(N) over all nodes, run twice per route (snap start + goal). At
1621 nodes it's sub-millisecond; at whole-city scale (100k+ nodes) it becomes the
dominant cost of a route request. **Evidence:** `features/routing/nearest.ts:8-15`
— loops `Object.keys(graph.nodes)` computing haversine to each. **Fix when it
bites:** a spatial index (k-d tree / R-tree), O(log N). **Severity: low now,
high at scale** — the single highest-leverage index the repo doesn't have.

### 3. `indexEdges()` rebuilds a transient hash index every search call

**Consequence:** re-pays O(E) index-build cost on every route. At 1879 edges it's
negligible; under a high route-request rate it's wasted work. **Evidence:**
`features/routing/astar.ts:12-16`, called at `astar.ts:34` inside every
`search()`. **Fix when it bites:** memoize the index on the `Graph` (keyed by
graph identity) so it's built once and reused — at the cost of `search()` no
longer being purely stateless. **Severity: low** — correct tradeoff at MVP scale.

### 4. Foreign keys (`fromNode`/`toNode`) are unchecked

**Consequence:** nothing enforces that an edge's `fromNode`/`toNode` point at real
nodes. A pipeline bug could ship an edge referencing a missing node; A* would
throw (`graph.nodes[next]` undefined) or silently misroute. **Evidence:**
`features/routing/types.ts:11-12` (plain `string` FKs, no constraint); the build
is trusted to produce valid refs (`pipeline/build-graph.ts:29`). **Fix:** a
build-time validation pass (assert every edge endpoint exists in `nodes`).
**Severity: low** — the pipeline is deterministic and tested, but a real DB's FK
constraint would catch this class of bug for free.

### 5. Version skew across app installs (consistency, by design)

**Consequence:** users on an old app version run an older `graph.json` until they
update — a "stale read" measured in days. **Evidence:** `mobile/src/loadGraph.ts:7`
(bundled copy, frozen at install). **Fix:** none needed at this cadence; if the
graph needed to be fresher than the app-update cycle, you'd move it out of the
bundle (Netlify Blobs, per spec §5) and fetch it. **Severity: negligible** — a
street graph changes slower than app updates.

### 6. `edgeById` is an O(E) scan (mitigated where it matters)

**Consequence:** finding one edge by id scans all edges. **Evidence:**
`features/routing/graph.ts:3-7`. **Mitigation:** the hot path (A*) avoids it via
`indexEdges()`; `edgeById` is only used off the hot path (e.g. `routeToGeoJSON`
over a short resolved path). **Severity: negligible** — already routed around
where it would matter.

## The `not yet exercised` ledger — absent DB machinery, ranked by activation

All of these are correct absences for a read-only artifact. They're ranked by how
soon they'd activate as the app grows a write path.

| # | Topic | Status | Activation trigger | File |
|---|---|---|---|---|
| 1 | **Query planner / execution engine** | `not yet exercised` | a declarative query layer (SQL/ORM) over the data | `04` |
| 2 | **Transactions / atomicity / isolation** | `not yet exercised` | first runtime write to shared state (e.g. "report sidewalk closed") | `05` |
| 3 | **Locks / MVCC / concurrency control** | `not yet exercised` | concurrent writers on shared data | `06` |
| 4 | **WAL / fsync / crash recovery** | `not yet exercised` | persisted runtime writes that must survive a crash | `07` |
| 5 | **Replication / lag / stale reads / failover** | `not yet exercised` | a central writable store with read replicas | `08` |

```
  The activation seam — all five wake at the same trigger

  read-only artifact (today)
        │
        │  ── add: first runtime write to shared state ──►
        ▼
  transactions ─► concurrency control ─► WAL/durability ─► replication
  (#2)             (#3)                    (#4)              (#5, if reads scale)
        ▲
        └─ query planner (#1) is independent: it activates with a declarative
           query layer, with or without writes
```

The single most important thing to know: **four of the five absent topics share
one trigger** — the first persisted runtime write. Until flattr lets users change
the data, they all stay correctly dormant. That's not technical debt; it's scope
discipline.

## What's genuinely good here (the positive audit)

A risk audit that only lists risks lies by omission. The data layer does several
things *right*:

- **Immutability deletes the four hardest DB problems** (txns, locks, WAL,
  replication) instead of half-implementing them. (`loadGraph.ts:9`)
- **The hot path is properly indexed** — `adjacency` + `indexEdges()` give O(1)
  neighbor expansion, the one read that runs millions of times. (`graph.ts:22`,
  `astar.ts:64`)
- **Denormalization is safe by construction** — `absGradePct` can't drift from
  `gradePct` because the store never changes. (`types.ts:18`)
- **The artifact is reproducible** — recovery is `npm run build:graph`, no backup
  infra needed. (`run-build.ts`)
- **Runtime tile builds are honestly a cache, not a fake replica** — the design
  doesn't pretend to consistency it doesn't provide. (`useTileGraph.ts:72`)

## Implementation in codebase — the evidence map

```
  Risk-to-evidence map

  #1 non-atomic build write   → pipeline/run-build.ts:12
  #2 nearestNode full scan    → features/routing/nearest.ts:8-15
  #3 transient index rebuild  → features/routing/astar.ts:12-16, 34
  #4 unchecked FKs            → features/routing/types.ts:11-12
  #5 version skew             → mobile/src/loadGraph.ts:7
  #6 edgeById O(E) scan       → features/routing/graph.ts:3-7

  not-yet-exercised → see files 04 (planner), 05 (txns), 06 (CC),
                              07 (WAL), 08 (replication)
```

## Interview defense

**Q: "If you audited this data layer, what's the one thing you'd fix and the
things you'd deliberately leave alone?"**

> One real fix: the build write isn't crash-atomic — `writeFileSync` in place at
> `run-build.ts:12` — so an interrupted build can corrupt `graph.json` and break
> the app's data load. Fix is temp-file-plus-rename, one line. Everything else I'd
> leave alone on purpose: the full scan in `nearestNode` is fine at neighborhood
> scale (it's the spatial index I'd add *if* the graph grew), and the absence of
> transactions, locks, WAL, and replication is correct — they all activate only
> when you add a runtime write to shared data, and flattr has none. The
> immutability is a feature, not a gap.

```
  fix now: non-atomic build write (temp+rename)
  leave: full scans (scale-gated), absent DB machinery (write-gated)
```

Anchor: *one actionable bug; the rest are write-gated absences, not debt.*

## Validate

1. **Reconstruct:** list the six real findings ranked by consequence, and the one
   trigger that activates four of the five absent topics.
2. **Explain:** why is finding #1 (non-atomic write) ranked above #2 (full scan)
   despite the full scan being more visible? (Blast radius: corruption breaks the
   whole app; the scan is just slow at scale.)
3. **Apply:** product wants user-submitted sidewalk closures. Walk the ledger —
   which `not yet exercised` topics activate, in what order?
4. **Defend:** a reviewer flags "no transactions, no replication, no WAL" as three
   critical gaps. Reframe each as a write-gated absence with its trigger, citing
   files `05`, `07`, `08`.

## See also

- `00-overview.md` — the ranked findings in the overview
- `01`–`08` — each finding's home file
- `.aipe/study-data-modeling/` — the schema-integrity view of finding #4 (unchecked FKs)
- `.aipe/study-system-design/` — the scale path that activates findings #2 and #5
