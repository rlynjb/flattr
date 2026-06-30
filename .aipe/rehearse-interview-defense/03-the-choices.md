# Chapter 3 — The Choices

Now the interviewer probes the *why*. Why did you hand-roll a router when
OSRM exists? Why Expo and not the Next.js the spec called for? Why a free
elevation API? Why a static file and not a database? These questions test
one thing: do you make decisions, or do you default to whatever you'd heard
of?

The senior move on every one of these is the same shape: name the
alternative, name the actual decision criterion (not a vibe), and name the
cost you're paying. A choice with no named cost reads as a choice you didn't
really make. This chapter gives you that shape four times.

---

## The decision tree — the major choices at a glance

This is the chapter's spine: four load-bearing choices, the alternative you
rejected, and the one criterion that decided each.

```
  flattr's load-bearing choices — picked path highlighted [★]

  ROUTING ENGINE
    OSRM / Valhalla / GraphHopper ──── can't express my custom cost
    ★ hand-rolled A* ─────────────────► the directional grade cost IS
                                         the project; off-the-shelf
                                         engines route on distance/time

  FRONTEND
    Next.js web (what the spec said) ── wrong target for a walking app
    ★ Expo / React Native ────────────► routing happens on the sidewalk,
                                         on a phone, with GPS

  ELEVATION DATA
    Google Elevation (paid, reliable) ─ costs money + API key per build
    ★ Open-Meteo (free) ──────────────► build-time only, retries absorb
                                         429s, $0 — cost is throttling

  GRAPH STORAGE
    Postgres / PostGIS / SQLite ─────── server or migration for static data
    ★ static graph.json (bundled) ────► graph never changes at runtime;
                                         a DB buys nothing, costs a hop
```

Every picked path has a one-line criterion attached. That's the discipline:
the choice is the criterion, not the technology.

---

## Choice 1 — Hand-rolled router vs OSRM

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Why did you build your own router instead of using    │
│    OSRM or Valhalla?"                                    │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Did you reinvent a wheel out of ignorance? Or did you  │
│   understand the existing tools well enough to know they │
│   couldn't do the thing you needed? "Not invented here"  │
│   is a red flag; "they structurally can't express my     │
│   cost" is a green one.                                  │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "The whole project is the cost function. flattr's cost is a *directional*
> grade penalty — uphill is penalized quadratically once it gets steep,
> downhill is free, and over your `userMax` it's effectively blocked. That's
> not a weight you can hand to OSRM. OSRM and Valhalla route on distance or
> travel time with a fixed cost model; you can't pass them 'penalize the
> signed grade in the direction of travel against this user's max.' So
> hand-rolling wasn't reinventing the wheel — the wheel doesn't turn the way
> I needed.
>
> Concretely, the cost lives in `cost.ts`. `gradeCostDirected` takes the
> edge, the node you're entering from, and `userMax`, and returns
> `length * (1 + penalty(directedGrade, userMax))`. The `directedGrade`
> flips the sign based on travel direction — that's the directional part,
> in graph.ts:17 — and `penalty` returns 0 for any grade at or below zero,
> which is why downhill is literally free (cost.ts:16).
>
> The cost I'm paying for hand-rolling: I own the correctness. OSRM is
> battle-tested over millions of routes; my A* is tested over 22 test files,
> not millions of users. So I traded a proven engine for an expressive one,
> and I covered the gap with tests rather than scale."

That last paragraph is the whole answer. You named the cost (you own
correctness) and you named the mitigation (tests). That's a complete
decision.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I wanted to learn how   │ "OSRM routes on a fixed │
│ routing works, so I       │ cost model. My cost is  │
│ built it from scratch     │ a directional grade     │
│ instead of using a        │ penalty — uphill costs, │
│ library."                 │ downhill is free — and  │
│                          │ that's not a weight you │
│                          │ can pass to OSRM. The   │
│                          │ custom cost IS the       │
│                          │ project. The cost I pay: │
│                          │ I own correctness, so I  │
│                          │ tested it hard."         │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "To learn" is a fine     │ Names the structural    │
│ personal reason but a    │ reason OSRM can't do it,│
│ weak engineering one.    │ anchors to the actual   │
│ It tells the interviewer │ cost function, and owns │
│ you'd have used the       │ the tradeoff (correctness│
│ library if you'd known    │ ownership) with the     │
│ about it.                 │ mitigation (tests).     │
└─────────────────────────┴─────────────────────────┘
```

```
┃ "The custom cost function isn't a feature of the router.
┃  It IS the router. That's why it's hand-rolled."
```

---

## Choice 2 — Expo / React Native vs the spec's Next.js

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Your spec says Next.js on Netlify, but you built it   │
│    in React Native. Why did you diverge from your own    │
│    plan?"                                                │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Can you change your mind for a real reason and own it? │
│   Diverging from a written spec is fine — pretending you │
│   never wrote it, or having no reason, is not. They want │
│   to see judgment, not loyalty to a doc.                 │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "The spec proposed Next.js on Netlify — that was the early plan. When I
> got into it, the use case argued against it. flattr is a *walking and
> scooter* router. You use it on the sidewalk, on a phone, while you're
> deciding which way to go up a hill. That's a native mobile context with
> GPS, not a desktop browser tab. So I moved the client to Expo / React
> Native — Expo ~56, RN 0.85, React 19 — rendering with MapLibre's React
> Native bindings. The engine didn't care: it's pure TypeScript under
> `features/`, framework-agnostic, so the same `directedAstar` runs
> unchanged. Only the shell changed.
>
> The cost: React Native is a heavier toolchain than a web app, and Expo
> pins you to versioned native modules — I keep a note in `mobile/AGENTS.md`
> to read the exact Expo v56 docs before touching native code, because the
> APIs shift between versions. That's real friction I accepted to get the
> right form factor."

The move here: you diverged from your *own* spec and you frame it as the
spec being wrong, caught early. That's a strength. The engine being
framework-agnostic is the detail that makes it credible — you didn't rewrite
anything, you swapped the shell.

---

## Choice 3 — Open-Meteo (free) vs Google Elevation (paid)

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Why a free elevation API? Doesn't that hurt           │
│    reliability?"                                         │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Did you think about WHERE the dependency sits? A flaky │
│   free API in a user's hot path is a problem. A flaky    │
│   free API at build time is an inconvenience. Do you see │
│   the difference?                                        │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "The key thing is *where* that dependency sits. Open-Meteo is only used at
> build time, in `pipeline/elevation.ts`, when I generate `graph.json`. It is
> never in a user's path. So 'reliability' means 'does my offline build
> occasionally have to retry,' not 'does a user's route fail.'
>
> And it does throttle — under heavy testing it returns 429s, which is
> exactly why `elevation.ts` retries with exponential backoff, up to three
> attempts (elevation.ts:97, :114). When the quota's genuinely exhausted, the
> build degrades to flat-fallback elevation and marks that region degraded
> rather than stalling. So I get free elevation data, and the cost — request
> throttling — lands at build time where I can absorb it with retries, not on
> a user mid-route. If this were a paid product I'd put Google behind the
> same interface; the point is the seam, not the vendor."

That answer reframes the whole question. The interviewer is implying "free =
unreliable = bad," and you correct the frame: reliability only matters in the
hot path, and this dependency isn't in the hot path. That reframe is the
senior move.

```
┃ "A flaky dependency at build time is an inconvenience.
┃  A flaky dependency in the user's path is an outage.
┃  Open-Meteo is the first kind."
```

---

## Choice 4 — Static graph.json vs a database

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Why a static JSON file and not a database?"           │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Do you reach for a database reflexively? Or do you ask │
│   what a database would actually buy you here? The right │
│   answer to "do I need a DB" is sometimes no, and the    │
│   engineers who know that are the ones who've felt the   │
│   cost of a DB they didn't need.                         │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "A database earns its place when data changes at runtime, needs querying
> you can't precompute, or has to be shared across clients. None of those is
> true here. The graph is static — it's computed once, offline, and it never
> changes while the app runs. The only query against it is 'find me the
> nearest node' and 'route between two nodes,' and both are graph traversals
> over an in-memory structure, not SQL. And it's not shared — each app has
> its own copy bundled in.
>
> So a database would add a server, a network hop on every route, an
> availability dependency, and an operational surface, in exchange for
> nothing. I bundle `graph.json` — 1600-odd nodes — and load it into memory
> once with `loadGraph` (loadGraph.ts:9). The cost I'm paying: the graph
> ships with the app, so updating coverage means shipping a new build, not
> running a migration. At this scope, that's the right trade. The moment I
> add user accounts or saved routes — mutable, per-user, shared state — a DB
> becomes the right call, and that's the boundary where my answer flips."

The phrase "that's the boundary where my answer flips" is gold. It tells the
interviewer you didn't choose "no DB" as a permanent religion — you chose it
for *this* shape of data and you know exactly what would change your mind.

---

## When the choices question goes past your depth

The trap on choices is the comparative-internals follow-up: "how does OSRM's
contraction hierarchy actually work?" You picked *not* to use OSRM — you
don't owe its internals.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "OSRM uses contraction hierarchies to get         ║
║   sub-millisecond routes on a continent-scale graph. How      ║
║   does that work, and could you have used it here?"           ║
║                                                               ║
║   You know CHs exist and roughly why (precomputed shortcuts    ║
║   that let you skip most of the graph), but you haven't        ║
║   implemented one, and the details — the contraction order,    ║
║   the witness search — are genuinely outside what you've       ║
║   built.                                                       ║
║                                                               ║
║   Say:                                                        ║
║   "At a high level I know contraction hierarchies precompute   ║
║    shortcut edges so a query can skip most of the graph,       ║
║    which is how OSRM gets continental routes fast. I haven't   ║
║    implemented one — the contraction ordering and the witness  ║
║    search are details I'd have to study before I claimed I     ║
║    understood them. The reason it didn't come up for me is     ║
║    scale: at 1600 nodes a plain A* is already sub-millisecond, ║
║    so the precompute would be solving a problem I don't have   ║
║    yet. At a million nodes it'd be exactly where I'd look."    ║
║                                                               ║
║   What this signals: you know the concept, you're honest       ║
║   about the depth limit, AND you tie it back to YOUR scale —   ║
║   you didn't need it, so not having implemented it is a        ║
║   reasonable gap, not a hole. That last move turns "I don't    ║
║   know" into "I didn't need to."                               ║
╚═══════════════════════════════════════════════════════════════╝
```

For the algorithm-internals deep dive (A* admissibility, why the heuristic
must be a lower bound, heap mechanics), point yourself at
**`.aipe/study-dsa-foundations/`**.

---

## What you'd change

The choice I'd most reconsider is the elevation provider being hardwired into
the pipeline. Open-Meteo was right for a free build, but the call to it isn't
behind a clean interface — if I wanted to drop in Google's paid API for
reliability, I'd be editing `elevation.ts` rather than swapping a provider
behind a seam. The *decision* (free elevation, build-time only) was right;
the *structure* (no provider abstraction) is what I'd fix. Chapter 7 makes
the `ElevationProvider` seam a full counterfactual.

---

## One-page summary — read this the night before

**Core claim:** Every load-bearing choice gets the same defense: name the
alternative, name the real criterion, name the cost. A choice with no named
cost reads as a choice you didn't make.

**Questions covered:**
- *Hand-rolled vs OSRM* → OSRM can't express a directional grade cost; the
  custom cost IS the project. Cost: I own correctness, covered by tests.
- *Expo vs the spec's Next.js* → walking app = phone + GPS, not browser. The
  pure-TS engine moved unchanged; only the shell swapped.
- *Open-Meteo vs Google* → build-time only, never the hot path; 429s absorbed
  by retries (elevation.ts:97). Reliability only matters in the user path.
- *Static graph vs DB* → data is static, unqueried beyond traversal,
  unshared. A DB buys nothing, costs a hop. Answer flips at user accounts.

**Pull quotes:**
- "The custom cost function IS the router. That's why it's hand-rolled."
- "A flaky dependency at build time is an inconvenience; in the user's path
  it's an outage."

**What you'd change:** Put elevation behind an `ElevationProvider` seam so a
paid API is a swap, not an edit. The decision was right; the structure isn't.
