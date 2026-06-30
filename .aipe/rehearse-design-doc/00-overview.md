# Design Docs — flattr

> Three decisions in this repo cleared the bar for a written RFC. This file ranks
> them, hands you the template, and tells you how to use the docs in a review or a
> promo packet. Coach voice — the goal is a skeptical reviewer nodding along, not
> suspense.

---

## What a design doc is for here

At staff level the code is rarely the bottleneck. The bottleneck is writing the
decision down so a room aligns behind it without a meeting. These three docs are
the decisions in flattr that someone *will* ask "why this way?" about — and the
written answer that holds up when they push.

flattr is a grade-aware router for self-powered travel ("optimized for flat, not
fast"). One user knob — `userMax`, the max comfortable uphill grade — drives a
hand-rolled A* router over a grade-annotated street graph, plus a grade heatmap.
No framework on the engine, no backend, no database. That last clause is itself a
decision, and it's doc #1.

---

## Which decisions warranted a doc (ranked)

The bar: hard to reverse, a real alternative was on the table, cross-cutting, and
someone will ask why. Here's how the repo's decisions sort against it.

```
  Decision                          reversible?  alt existed?  cross-cutting?  → doc?
  ─────────────────────────────────  ──────────  ───────────  ─────────────  ──────
  Build-time graph artifact /        no — data    yes: routing  yes: shapes    ★ 01
    no database                       is frozen    server + DB   the whole app
  Parametric directional router      no — the     yes: OSRM/    yes: every     ★ 02
    (one search(), 4 stages)          API shape    Valhalla      route + bench
  Honest degradation under a         no — the     yes: fail or  yes: build,    ★ 03
    throttled free elevation API      data model   fake-flat     display, cache
  ─────────────────────────────────  ──────────  ───────────  ─────────────  ──────
  Hand-rolled binary heap (pqueue)   yes          yes: npm      no: local      skip
  TypeScript strict ESM, no          yes          yes           no             skip
    framework on the engine
  Vitest + co-located *.test.ts      yes          yes           no             skip
  BLOCKED = 1e9 not Infinity         —            —             —              folded into 02
```

The bottom four are real choices but they don't clear the bar. The hand-rolled
heap is a swap-the-import away from reversible and contained to one file. `BLOCKED
= 1e9` is load-bearing and surprising — but it's one constant in service of the
router's cost model, so it lives *inside* doc 02 where it pays off, not as its own
RFC. Don't manufacture a doc for a constant.

```
  The three docs, by where they live in the system

  ┌─ BUILD TIME (pipeline/) ──────────────────────────────┐
  │  OSM + elevation  ──►  graph.json                      │  ← 01: artifact, no DB
  │                         ▲                               │  ← 03: degradation
  │                         │ honest-flat fallback         │     (build + on-device)
  └─────────────────────────┼─────────────────────────────┘
                            │  bundled, read-only
  ┌─ RUNTIME (features/, mobile/) ──────────▼──────────────┐
  │  loadGraph()  ──►  search(costFn, heuristicFn)         │  ← 02: parametric router
  │                     Dijkstra / A* / grade / directed   │
  └────────────────────────────────────────────────────────┘
```

---

## The doc template (the RFC spine)

Every doc here follows the same nine-part spine. When you write your next one,
copy this shape:

```
  1. Title + one-line summary   the decision in a sentence, up top
  2. Context / problem          the real constraint that forced it
  3. Goals & non-goals          what it must do — and won't (kills scope fights)
  4. The decision               chosen design + a MANDATORY diagram (shape first)
  5. Alternatives considered    2–3 real options, each with why it lost
  6. Tradeoffs accepted         what it costs, owned without flinching
  7. Risks & mitigations        what breaks, what guards it
  8. Rollout / migration        how it ships; what changes for callers / data
  9. Open questions             what's still undecided (honesty = staff signal)
```

The two parts reviewers actually grade: **alternatives** (a doc with no
alternatives reads as "I did the first thing I thought of") and **tradeoffs owned
without apology** ("we chose X, accepting Z" — never "unfortunately we had to").

---

## How to use these

- **In a review.** Lead with section 4 (the decision + diagram). Let the reviewer
  see the shape, then walk alternatives only if they push. Don't narrate the
  suspense.
- **In a promo packet.** These are the written-communication artifact. Doc 02 is
  the one that shows depth — a parametric algorithm where four textbook stages
  collapse into one function by varying two arguments.
- **When the decision changes in code.** These docs drift. If `search()`'s
  signature changes, or the graph stops being a static artifact, reconcile the
  affected doc against the code surgically — don't regenerate from scratch.

---

## Files

- `01-build-time-graph-artifact.md` — static bundled `graph.json`, no backend, no DB
- `02-parametric-directional-router.md` — one `search()`, four stages via `(costFn, heuristicFn)`
- `03-honest-degradation-elevation.md` — best-effort flat fallback, marked degraded, self-healing

## See also (study guides, for the comprehension layer)

- `.aipe/study-system-design/` — the architecture these decisions sit in
- `.aipe/study-dsa-foundations/` — the heap, the graph, the A* underneath doc 02
- `.aipe/study-distributed-systems/` — partial failure, the frame for doc 03
- `.aipe/study-networking/` — rate limits, retries, the transport behind doc 03
