# Chapter 7 — The counterfactuals

"What would you do differently if you started today?" is a trap and a gift. It's
a trap because the weak instinct is to either say "nothing" (reads as no
self-reflection) or invent regrets about decisions that were obviously right
(reads as no judgment). It's a gift because the senior move — volunteering what
you'd reconsider *before being asked* — is one of the clearest seniority signals
there is, and this chapter hands you three real ones grounded in flattr's code.

The discipline: name what you'd change *and* name what you'd keep. A
counterfactual that changes everything signals you didn't believe in your
choices. A counterfactual that changes nothing signals you can't see your
blind spots. The strong answer is surgical — three specific changes, each with a
reason, against a backbone of decisions you'd make again identically.

---

## The chapter-opening diagram — the counterfactuals matrix

Every reconsiderable decision, what you'd change, and — critically — the
decisions you'd KEEP. The KEEP column is what stops this from sounding like
regret.

```
  flattr — counterfactuals matrix

  ┌─ WOULD CHANGE ───────────────┬─ WHY ─────────────────────────┐
  │ 1. validate graph.json on    │ loadGraph (loadGraph.ts:10)   │
  │    load                      │ is a bare cast — bad data =   │
  │                              │ undefined behavior deep in    │
  │                              │ the search, not a clean error │
  ├──────────────────────────────┼───────────────────────────────┤
  │ 2. wire paid elevation       │ ElevationProvider seam already│
  │    behind ElevationProvider  │ exists (elevation.ts:7); 90m  │
  │                              │ coarse data undercuts a GRADE │
  │                              │ router's whole point          │
  ├──────────────────────────────┼───────────────────────────────┤
  │ 3. design the data-loading   │ static base + runtime tiles   │
  │    seam UP FRONT             │ grew separately; one          │
  │                              │ GraphSource interface would   │
  │                              │ unify them (+ host validation)│
  └──────────────────────────────┴───────────────────────────────┘

  ┌─ WOULD KEEP (decisions that were right) ─────────────────────┐
  │  ✔ hand-rolled engine, not OSRM     the graph IS the project │
  │  ✔ no backend / no DB                runtime is read-only     │
  │  ✔ directional cost (A→B ≠ B→A)      the core idea, correct   │
  │  ✔ finite BLOCKED (1e9)             steep ≠ disconnected     │
  │  ✔ one parametric search()          elegant + provable       │
  └──────────────────────────────────────────────────────────────┘
```

Three changes, five keeps. That ratio is the tone you want — reflective, not
regretful.

```
┃ "The senior move is to volunteer what you'd reconsider
┃  before being asked — and to name what you'd keep in the
┃  same breath."
```

---

## "What would you do differently?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "If you were starting this over today, what would you do        │
│    differently?"                                                  │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Self-reflection with judgment attached. Can you critique your   │
│   own work without trashing it? Do your regrets show good taste   │
│   — are they real improvements, or fabricated nitpicks? Do you    │
│   know which decisions were actually right?                       │
└─────────────────────────────────────────────────────────────────┘
```

> "Three things, and they're all about hardening, not rethinking the core.
>
> First, I'd validate `graph.json` on load. Right now `loadGraph` (loadGraph.ts:10)
> does a bare `graph as unknown as Graph` cast — it trusts the file completely.
> A malformed file becomes undefined behavior deep in the search instead of a
> clean error at the boundary. I'd add a schema pass: every adjacency id resolves
> to a real edge, every edge's endpoints exist in `nodes`, grades are finite.
> Cheap to add, turns a mystery crash into a precise error.
>
> Second, I'd wire up the paid elevation provider behind a flag. The
> `ElevationProvider` interface is already there (elevation.ts:7) with a working
> `googleProvider` — I just default to the free Open-Meteo source. But its 90m
> resolution smooths short steep pitches, which for a *grade* router is the
> exact data I care most about. The seam to upgrade is built; I'd actually use
> it.
>
> Third, the architectural one: I'd design the data-loading seam up front. The
> static base graph and the runtime tile-loading (`useTileGraph.ts`) grew as two
> separate things stitched together. If both went through one `GraphSource`
> interface from the start, the architecture would be cleaner and validation
> would have one obvious home instead of being missing.
>
> What I'd keep, all of it: the hand-rolled engine, no backend, the directional
> cost, the finite BLOCKED, the single parametric search. Those were right and I'd
> make them again."

```
        ▸ Three changes, all hardening. Five keeps, the
          core. A good counterfactual sharpens the edges
          without rebuilding the machine.
```

---

## Weak vs strong — the counterfactual

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                   │ STRONG ANSWER                 │
├──────────────────────────────┼──────────────────────────────┤
│ "Honestly I'm pretty happy    │ "Three hardening changes: I'd │
│ with it. Maybe I'd use a      │ validate graph.json on load — │
│ different map library or add  │ loadGraph is a bare cast      │
│ more tests. Or rewrite it in  │ today; I'd wire the paid      │
│ Rust for speed."              │ elevation provider behind the │
│                               │ interface that's already      │
│                               │ there; and I'd design the     │
│                               │ data-loading seam as one      │
│                               │ GraphSource up front. The     │
│                               │ engine, no-DB, and directional│
│                               │ cost I'd keep exactly."       │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:                │ Why it works:                  │
│ "Pretty happy" + vague        │ Specific, code-anchored, each  │
│ nitpicks ("different map      │ with a reason. "Rust for       │
│ library") + a fake regret     │ speed" is absent because at    │
│ ("rewrite in Rust") that      │ 1,621 nodes speed isn't the    │
│ solves a problem you don't    │ problem — naming a non-problem │
│ have. Shows no real judgment  │ shows you know which problems  │
│ about which decisions mattered│ are real. The KEEP list proves │
│ or which were right.          │ conviction, not just critique. │
└──────────────────────────────┴──────────────────────────────┘
```

The "rewrite in Rust" line is the classic fake counterfactual — it sounds
impressive and solves nothing, because your bottleneck isn't language speed,
it's the O(N) snap and the validation gap. Naming a *real* improvement over a
flashy non-improvement is the judgment being tested.

---

## The validation fix, concretely

Since this is your top counterfactual, have the actual shape ready — interviewers
love when "I'd validate it" comes with the validation.

```
  The graph.json validation pass (the counterfactual, made real)

  loadGraph()  ── today ──►  graph as unknown as Graph   (trusts blindly)

  loadGraph()  ── proposed ──►  validateGraph(parsed):
       │
       ├─ every node has finite lat/lng/elevationM
       ├─ every edge.fromNode and edge.toNode exist in nodes
       ├─ every edge.gradePct / lengthM is finite
       ├─ every adjacency id resolves to a real edge
       └─ adjacency is symmetric with edge endpoints
              │
              ├─ valid   → return Graph
              └─ invalid → throw at the BOUNDARY with the
                           specific violation (not a crash
                           deep in search())
```

That's the difference between "the app crashed in `otherEnd` with a cryptic
undefined" and "the graph failed to load: edge e_412 references missing node
n_98." The error lands where the bad data enters, not three layers down.

Deeper on the validation seam, trust boundaries, and where to enforce them →
`.aipe/study-system-design/` and `.aipe/study-security/` (input validation).

---

## Where the counterfactual conversation goes next

```
  You named "design the data-loading seam up front."
        │
        ├─► IF THEY ASK "what would the GraphSource interface
        │   │   look like?"
        │     "One method — getGraph(bbox) → Graph — with two
        │      impls: a StaticSource over the bundled file and
        │      a TileSource over the live Overpass+elevation
        │      build. MapScreen wouldn't know which it's using.
        │      Validation lives in the interface, once."
        │
        ├─► IF THEY ASK "why didn't you do it that way
        │   │   originally?"
        │     "The static graph came first as the simplest
        │      thing that worked. Tile-loading was added later
        │      for panning and route corridors. The seam grew
        │      around the base instead of being designed — a
        │      real but understandable order-of-work artifact."
        │
        └─► IF THEY ASK "would you change the directional cost?"
              "No. That's the core idea and it's correct.
               Changing it would be changing what flattr IS,
               not improving how it's built. I'd defend it,
               not reconsider it."
```

That last branch matters: be ready to *refuse* a counterfactual when the
decision was right. "No, I'd keep that, and here's why" is a stronger answer
than inventing a change to seem humble.

---

## The "I don't know" box — when they ask about a change you haven't scoped

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They push past your three: "What about making the graph     ║
║   updatable in real time — a street closes, you re-route      ║
║   around it live. How would you architect that?"             ║
║                                                               ║
║   This is live-mutable-data + invalidation under load —       ║
║   distributed-data territory you haven't built. You can       ║
║   reason about the shape, but don't claim an architecture     ║
║   you've never shipped.                                       ║
║                                                               ║
║   Say:                                                         ║
║   "That's a real shift — it turns my read-only static graph   ║
║    into a mutable one, which is a different system. I can      ║
║    reason about the shape: I'd want an edge-level override     ║
║    layer (closed = set that edge to BLOCKED-disconnected)     ║
║    applied on top of the static graph at query time, so I      ║
║    don't re-bake the whole thing for one closure. The hard     ║
║    part I HAVEN'T solved is propagating those overrides to     ║
║    every device and invalidating consistently — that's        ║
║    distributed cache invalidation, and I haven't built that.   ║
║    I'd flag it as design-from-scratch, not recall."           ║
║                                                               ║
║   What this signals: you connected the new requirement to     ║
║   your existing primitives (BLOCKED, query-time override),    ║
║   AND drew the line at the distributed part you haven't        ║
║   done. Reasoning forward from your code beats both bluffing   ║
║   and freezing.                                                ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "I'd use websockets and a pub-sub system and eventually     ║
║    consistent caches..." — a stack list for a problem you      ║
║   haven't thought through. The "what consistency guarantee?"   ║
║   follow-up ends it.                                            ║
╚═══════════════════════════════════════════════════════════════╝
```

---

## What you'd change — the chapter's own close

The meta-lesson of this chapter is the move itself: walk into the interview with
your three counterfactuals already loaded, and volunteer them at the right
moment rather than waiting to be cornered. The single highest-leverage one is
graph validation on load — it's cheap, it closes the Chapter 5 gap, and it shows
you think in trust boundaries. If you only carry one counterfactual into the
room, carry that one.

---

## One-page summary — Chapter 7

**Core claim:** Volunteer three specific, code-anchored changes against a clear
list of decisions you'd keep. The KEEP list is what makes it judgment, not
regret.

**The three counterfactuals:**
- **Validate graph.json on load** → `loadGraph` is a bare cast (loadGraph.ts:10); add a schema pass so bad data fails at the boundary, not deep in `search()`. (Top priority — closes the Ch.5 gap.)
- **Wire paid elevation behind `ElevationProvider`** → seam exists (elevation.ts:7), `googleProvider` works; 90m free data undercuts a grade router. Use the off-ramp.
- **Design the data-loading seam up front** → one `GraphSource` interface for static base + runtime tiles, instead of one growing around the other.

**Would KEEP:** hand-rolled engine, no backend/DB, directional cost, finite BLOCKED, parametric `search()`.

**Pull quotes:**
- ┃ "Volunteer what you'd reconsider before being asked — and name what you'd keep in the same breath."
- ▸ Three changes, all hardening. Five keeps, the core.

**What you'd change (the close):** Carry the validation counterfactual into every interview as the lead — cheap, closes a real gap, signals trust-boundary thinking.
