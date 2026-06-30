# 04 — Consistency Models and Staleness

**Industry names:** consistency models (strong / eventual) / staleness / cache
coherence / read-your-writes / convergence. **Type:** Industry standard.

## Zoom out, then zoom in

You know how a `useState` value is *strongly consistent* with itself — you set it,
the next read is the value you set, no question? The moment data lives somewhere
you don't control and arrives over a network, that guarantee evaporates. The data
you're holding might be old. Consistency models are the vocabulary for *how* old
it's allowed to be, and what the system promises about catching up.

flattr's data has two different staleness stories sitting in two different layers.

```
  Zoom out — flattr's two staleness layers

  ┌─ Build-time (you own) ────────────────────────────────────────┐
  │  graph.json — baked once, read-only forever  ★ STALE BY DESIGN │ ← layer 1
  └───────────────────────┬───────────────────────────────────────┘
                          │  shipped as a static asset (no live link)
                          ▼
  ┌─ Runtime client (you own) ────────────────────────────────────┐
  │  elevation cache + on-demand tiles                            │
  │  best-effort, degraded-marked, self-healing  ★ EVENTUALLY     │ ← layer 2
  │                                              CONSISTENT        │
  └───────────────────────┬───────────────────────────────────────┘
                          │  HTTP
                          ▼
  ┌─ Third parties — the source of truth (you don't own) ─────────┐
  │  OSM streets (MUTABLE)      ·    DEM heights (IMMUTABLE)       │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **eventual consistency** — local data that may be stale
right now but *converges* toward the source of truth over time. flattr exhibits
two flavors: the graph is **stale-by-design** (baked at build, never refreshed at
runtime — a deliberate strong-staleness choice), while the runtime elevation data
is **eventually consistent** (best-effort, marked when degraded, self-healing
until it matches the real DEM). Knowing *which layer is which* is the file.

## The structure pass

**Layers.** Two, as the zoom-out shows: the baked graph (layer 1) and the runtime
cache/tiles (layer 2). They have *opposite* consistency contracts and that
opposition is the lesson.

**Axis — trace `how does this layer catch up to the source of truth?` down the
layers.**

```
  One axis — "how does stale data here become fresh?" — down the layers

  ┌─ baked graph (graph.json) ──────────┐
  │ catches up ONLY when a human runs    │  → manual, coarse-grained,
  │ `npm run build:graph` and reships    │     stale-by-design
  └──────────────────┬───────────────────┘
                     │  the answer flips ↓
  ┌─ runtime tiles ──▼───────────────────┐
  │ catches up AUTOMATICALLY: degraded    │  → automatic, fine-grained,
  │ regions self-heal every 12s until     │     eventually consistent
  │ real grades land (useTileGraph:209)   │
  └──────────────────┬───────────────────┘
                     │  the answer flips AGAIN ↓
  ┌─ elevation cache ▼───────────────────┐
  │ NEVER catches up — and never needs to │  → immutable: DEM heights don't
  │ (elevCache.ts:4: "valid forever")     │     change, so "stale" is undefined
  └───────────────────────────────────────┘
```

Three layers, three different convergence answers — manual, automatic, never-needed.
*That* spread is what makes flattr a good consistency study: it shows that
"stale" isn't one thing, it's a question you answer per-data-class.

**Seam.** The load-bearing seam is the `degraded` flag (`useTileGraph.ts:75`) — it
sits exactly at the boundary between "data I'm showing" and "data that's a
placeholder," and it's what lets flattr serve *available-but-wrong* data without
*lying* about it. That single boolean is flattr's entire consistency-marking
mechanism.

## How it works

### Move 1 — the mental model: the consistency spectrum

Consistency runs on a spectrum from "always correct, possibly slow/unavailable"
to "always available, possibly wrong":

```
  The pattern — the consistency spectrum, and where flattr sits

  STRONG ◄─────────────────────────────────────────────► EVENTUAL
  every read sees                                  reads may be stale;
  the latest write                                 system converges later
       │                                                    │
       │                            flattr graph ───────────┤ stale-by-design
       │                            flattr tiles ───────────┤ self-healing
       │                            (and CAP: when the network splits,
       │                             you pick A[vailable] or C[onsistent])
       └─ a single in-memory                                │
          variable lives here                               │
```

The CAP theorem makes the tradeoff sharp: when a network partition happens (here:
the elevation API is unreachable/throttled), a system can stay **C**onsistent
(refuse to serve rather than serve stale/wrong data) **or** stay **A**vailable
(serve something, accept it might be wrong). You cannot have both during the
partition. flattr picks **A** every time — and the `degraded` flag is how it picks
A *honestly*.

### Move 2 — walk flattr's two consistency stories

**Story 1 — the graph is stale-by-design.** `run-build.ts` fetches OSM, builds
the graph, and writes `data/graph.json` (`run-build.ts:46-48`). The app then only
*reads* it — `mobile/assets/graph.json`, loaded once. There is no live link back
to OSM.

```
  layers-and-hops — the graph's one-way, build-time freshness

  ┌─ OSM (source of truth, MUTABLE) ─┐
  │  streets edited continuously     │
  └──────────────┬───────────────────┘
       hop 1: fetchOverpass (ONCE, at build) ↓
  ┌─ build pipeline ─────────────────┐
  │  buildGraph → graph.json         │
  └──────────────┬───────────────────┘
       hop 2: ship static asset ↓ (NO further hops — the link ends here)
  ┌─ app ────────────────────────────┐
  │  reads graph.json forever        │  ← frozen at build time
  └──────────────────────────────────┘
       a street added in OSM today is invisible until the next
       `npm run build:graph` + reship. Staleness = time since last build.
```

This is a deliberate choice, not a bug. The cost is honest: a street that changed
in OSM after the last build is wrong in flattr until someone rebuilds. The benefit
bought: zero runtime dependency on Overpass for the base map, instant startup,
works offline. For a routing graph where streets change on the order of months,
trading freshness for a static artifact is the right call — name it as
"stale-by-design," not "out of date."

**Story 2 — the runtime tiles are eventually consistent.** On-demand tile builds
(`useTileGraph.ts`) layer fresher data on top, and *this* layer converges. Walk
the three-state lifecycle of a region:

```
  state — a region's path from wrong-but-available to consistent

  ┌─ fresh build, elevation OK ─┐   real grades, degraded=false
  │   → routing + display both  │   → fully consistent with the DEM
  └──────────────┬──────────────┘
                 │ elevation API 429s during build
                 ▼
  ┌─ DEGRADED (flat 0m grades) ─┐   degraded=true (useTileGraph.ts:75)
  │   routing graph: INCLUDES it │   → AVAILABLE: streets render, routes connect
  │   display graph: EXCLUDES it │   → HONEST: heatmap won't paint fake-flat green
  └──────────────┬──────────────┘      over real grades (:150-162)
                 │ self-heal: every 12s, re-queue build (:209-218)
                 ▼
  ┌─ healed: real grades land ──┐   degraded=false again
  │   → converged to the DEM    │   → eventual consistency reached
  └──────────────────────────────┘
```

The two-graph split (`useTileGraph.ts:132-162`) is the cleverest part and worth
reading closely:

```
  useTileGraph.ts:132-162 — two graphs, two consistency policies

  graph (ROUTING):    includes degraded regions     (:140-143)
    └ rationale (:130): flat grades are fine for CONNECTIVITY — excluding them
      would re-break "no route". Availability wins: route through bad-grade data.

  displayGraph (HEATMAP): EXCLUDES degraded regions  (:156-160)
    └ rationale (:147): bogus all-green grades must NOT paint over real grades.
      Honesty wins: show nothing rather than show a lie.
```

That's *the same data* given two different consistency policies depending on what
it's used for: for routing (where wrong-but-connected beats disconnected) it's
included; for the heatmap (where wrong-and-visible is a lie) it's hidden until
real. This is what mature eventual-consistency looks like — the staleness policy
is per-use, not global.

**Why the elevation cache never invalidates.** The third consistency answer from
the structure pass: `elevCache.ts:4` states it flatly — *"DEM samples never
change, so cached values are valid forever."* The height of a point on Earth is
immutable, so there's no staleness to manage and no invalidation logic to write.
Contrast with the graph: streets *are* mutable upstream, which is exactly why the
graph goes stale and the elevation cache doesn't. Same repo, two data classes,
opposite consistency needs — pick the model per data class, never globally.

**Read-your-writes — not exercised, and why.** Read-your-writes consistency (after
*you* write something, *you* immediately see it) requires user writes, and flattr
has none — every operation is a read (`03`). There's no "save" to read back. The
trigger: the day a user saves a route or a preference to a shared backend, you owe
them read-your-writes (they must see their own save immediately even if other
replicas lag), and that's where session-stickiness or read-from-primary enters.
`not yet exercised` — honestly.

### Move 3 — the principle

Consistency is not a property you turn up to "max" — it's a per-data-class
decision about how much staleness you can tolerate and how the data catches up.
flattr makes that decision three times correctly: the graph trades freshness for a
static artifact (stale-by-design), the runtime tiles converge automatically
(eventually consistent), the DEM cache needs no model at all (immutable). **The
skill isn't achieving strong consistency everywhere — it's knowing which data can
be stale, marking it when it is, and never letting wrong-but-available data
masquerade as fresh.** The `degraded` flag is that discipline in one boolean.

## Primary diagram

The full picture: three data classes, three consistency models, the `degraded`
seam that keeps availability honest.

```
  flattr — three data classes, three consistency models

  ┌─ graph.json ─────────────┐  STALE-BY-DESIGN
  │ baked at build, read-only│  converges only on manual rebuild + reship
  └────────────┬─────────────┘  cost: a new OSM street is invisible till rebuild
               │ overlaid by ↓
  ┌─ runtime tiles ──────────┐  EVENTUALLY CONSISTENT
  │ degraded flag (CAP: A)   │  ┌ routing graph: includes degraded (available)
  │ self-heal every 12s ×6   │  └ display graph: excludes degraded (honest)
  └────────────┬─────────────┘  converges as self-heal lands real grades
               │ heights from ↓
  ┌─ elevation cache ────────┐  IMMUTABLE — no consistency model needed
  │ "valid forever" (:4)     │  DEM heights don't change → nothing to invalidate
  └──────────────────────────┘
```

## Elaborate

The strong-vs-eventual split and CAP are the bedrock of distributed data. The
nuance flattr illustrates well is that "eventual consistency" is meaningless
without two things it actually has: a **convergence mechanism** (the self-heal
retry — without it, "eventual" never arrives) and a **staleness marker** (the
`degraded` flag — without it, you can't tell fresh from stale, so you can't serve
stale safely). Many systems claim eventual consistency but skip the marker, then
serve stale data as if it were fresh — the silent-corruption failure mode. flattr's
`degraded` flag, splitting the routing graph from the display graph, is the
textbook-correct version: serve stale where it's harmless (routing connectivity),
hide it where it'd mislead (the heatmap). The PACELC extension (else, even with no
partition, you trade Latency for Consistency) is the next concept up; flattr's
build-time bake is a pure latency-for-consistency trade with no partition
involved.

## Interview defense

**Q: "What's the consistency model of this app's data?"**
Verdict first: "There isn't one model — there are three, by data class. The base
graph is stale-by-design (baked at build, refreshed only by a human rebuild). The
runtime tile grades are eventually consistent (best-effort, marked `degraded` when
the elevation API throttles, self-healing every 12s until real grades land). The
elevation cache needs no model — DEM heights are immutable." Then the CAP framing:
"At every elevation failure it picks Availability over Consistency — renders flat
grades rather than failing — and the `degraded` flag keeps that honest." Naming
three models instead of one is the senior signal.

```
  the sketch you draw

  graph   ─► stale-by-design   (human rebuild)
  tiles   ─► eventual          (self-heal converges)   ── degraded flag
  cache   ─► immutable         (never stale)              keeps A honest
```

**Q: "Serving flat grades when elevation fails — isn't that wrong data?"**
"Yes, and it's a deliberate CAP choice: Availability over Consistency. But it's
*honest* wrong data — the `degraded` flag includes it in the routing graph (where
wrong-but-connected beats no-route) and *excludes* it from the heatmap (where it'd
paint a lie). Then the self-heal retry converges it to real grades. The crime
would be serving stale data *unmarked*; flattr never does." Naming the
two-graph split is the thing that proves you read the code.

**Anchor:** *Three data classes, three consistency models — and the `degraded`
flag is what lets flattr stay Available without lying about which grades are real.*

## See also

- `02` — the self-heal retry that drives convergence.
- `03` — why the elevation cache is immutable (DEM heights never change).
- `06` — backpressure: how the self-heal retries are paced so convergence doesn't
  storm the API.
- `09` — staleness risks ranked.
- sibling **database-systems** — datastore-local consistency; sibling
  **system-design** — the build-time-vs-runtime architectural split.
