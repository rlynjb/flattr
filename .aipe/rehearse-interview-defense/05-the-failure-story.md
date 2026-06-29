# Chapter 5 — The failure story

"What happens when things go wrong?" tests something the scale question doesn't:
operational thinking. An interviewer wants to know whether you thought past the
happy path — what your system *does* when the elevation API throttles, when two
points can't be connected, when the data file is corrupt. flattr has a genuinely
good answer for two of these and a real gap on the third, and the senior move is
to walk all three honestly, including the gap.

The theme of this chapter is **degrade honestly.** flattr's best operational
decision is that when something fails, it doesn't crash and it doesn't lie — it
returns the best answer it can *and marks it as degraded*. The elevation API
throttles? Route over flat-marked-degraded data and tell the user the grades are
approximate. No flat route exists? Return the steep one and flag the steep
edges. The one place this discipline breaks down — loading an unvalidated
`graph.json` — is your gap, and you'll own it.

---

## The chapter-opening diagram — the failure-mode map

Every failure surface as a box, with what the system actually does. The two
green-path boxes are your strengths; the red-path box is your gap.

```
  flattr — failure surfaces and the system's response

  ┌─ BUILD TIME ──────────────────────────────────────────────────┐
  │                                                                │
  │  Open-Meteo 429 (quota exhausted)                              │
  │    → retry w/ exponential backoff (elevation.ts:114)          │
  │    → still failing? bestEffortElevation returns flat 0m        │
  │       and FLAGS the region degraded (useTileGraph.ts:20)      │
  │    → degraded region quietly re-queued to self-heal           │
  │    ✔ DEGRADE HONESTLY: streets still render, grades marked    │
  │                                                                │
  │  Overpass down/offline                                         │
  │    → keep the last region; a later pan retries                │
  │    ✔ no crash, stale-but-usable                                │
  └────────────────────────────────────────────────────────────────┘

  ┌─ RUNTIME ─────────────────────────────────────────────────────┐
  │                                                                │
  │  No FLAT route (every path crosses a too-steep edge)          │
  │    → BLOCKED = 1e9 finite, so A* STILL returns a path         │
  │    → steepEdges flagged (astar.ts:126), shown to user         │
  │    ✔ "no flat way" ≠ "no way"                                  │
  │                                                                │
  │  No route AT ALL (start/end in disconnected components)       │
  │    → search() returns path: null (astar.ts:77)               │
  │    → MapScreen shows found: false                             │
  │    ✔ distinct, honest "no route"                              │
  │                                                                │
  │  Corrupt / malformed graph.json                               │
  │    → loadGraph() does `graph as unknown as Graph` — NO        │
  │       validation (loadGraph.ts:10)                            │
  │    ✘ THE GAP: trusts the file completely. Bad data =          │
  │       undefined behavior deep in the search, not a clean      │
  │       error at the boundary.                                  │
  └────────────────────────────────────────────────────────────────┘
```

Two ✔ stories to tell with pride, one ✘ to own. Walk all three.

---

## "What happens when the elevation API fails?"

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What happens when an external dependency fails — say the       │
│    elevation API goes down or rate-limits you?"                  │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Did you handle the unhappy path, or does one 429 crash the     │
│   whole build? Do you fail loud, fail silent, or degrade? And    │
│   critically — when you degrade, does the system LIE about it,   │
│   or tell the truth?                                              │
└─────────────────────────────────────────────────────────────────┘
```

> "This one I actually hit during development — Open-Meteo's free tier 429s when
> you hammer it. So I handle it in layers. First, the provider retries 429s with
> exponential backoff (`elevation.ts:114`). Second — and this is the part I'm
> happy with — if it still can't get elevation, the build doesn't fail. There's
> a wrapper, `bestEffortElevation` (`useTileGraph.ts:20`), that catches the
> failure, returns flat 0-meter elevation so the streets still render and routing
> still connects, and *flags that region as degraded*.
>
> The 'degraded' flag is the important bit. A degraded region's grades are bogus
> — everything reads flat — so I exclude it from the heatmap (`displayGraph`)
> while keeping it in the routing graph (`graph`), because flat grades are fine
> for connectivity. The UI shows 'Grades approximate — elevation unavailable,
> retrying'. And the region gets quietly re-queued to self-heal once the API
> recovers, capped at a retry budget so it doesn't loop forever during a
> sustained outage.
>
> Also, I cache every successfully-fetched elevation by DEM cell, persisted
> across restarts — so revisited areas need zero requests, which is the main
> thing that kept me under the rate limit."

```
┃ "When it degrades, it doesn't lie. It routes over flat
┃  data, marks the region degraded, and tells the user
┃  the grades are approximate."
```

That's the headline. "Degrade honestly" — return the best available answer *and*
surface that it's degraded — is exactly the operational maturity the question is
fishing for.

---

## "What if there's no route?"

This is the cleverest piece of operational design in flattr, and it's a *graph*
decision, not a UI patch.

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What does the user see when you can't find a route?"          │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Did you collapse two different failures into one generic        │
│   'no route' error? Or did you notice they're different graph    │
│   states and surface each honestly?                              │
└─────────────────────────────────────────────────────────────────┘
```

> "There are two different 'failures' here and I treat them as different graph
> states. One is 'there's no *flat* way' — every path crosses an edge steeper
> than your max. The other is 'there's no way *at all*' — the start and end are
> in disconnected components.
>
> The trick is the BLOCKED value. A too-steep edge costs `BLOCKED`, which is
> `1e9` — large but *finite*, not Infinity (`cost.ts:5`). So if the only route is
> steep, A* still finds and returns it — it just costs a billion — and I flag the
> offending segments via `steepEdges` (`astar.ts:126`). The user sees a route
> with the steep parts marked, not a dead end. But if start and end are genuinely
> disconnected, `search()` returns `path: null` (`astar.ts:77`), and the UI shows
> a true 'no route'. If I'd used Infinity for BLOCKED, those two states would
> collapse — a steep-only route would look identical to no route at all."

```
        ▸ "no flat way" and "no way at all" are two
          different graph states. A finite BLOCKED keeps
          them distinct. Infinity would erase the difference.
```

This is a phenomenal interview answer because it's a subtle, correct, *named*
decision (the spec calls it out at §14.4) that most people would get wrong by
reflex-reaching for Infinity.

---

## "What about bad input data?" — the gap, owned

This is where you tell the truth about the weak spot. Don't hide it — owning it
is the senior move.

```
┌─────────────────────────────────────────────────────────────────┐
│ THEY ASK                                                          │
│   "What happens if the graph file is corrupt or malformed?"      │
│                                                                   │
│ WHAT THEY'RE TESTING                                              │
│   Do you validate at your trust boundaries? Do you know WHERE    │
│   your boundaries are? And when there's a gap, do you know it's  │
│   there — or does it surprise you in the room?                   │
└─────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                   │ STRONG ANSWER                 │
├──────────────────────────────┼──────────────────────────────┤
│ "It shouldn't be corrupt, I   │ "That's a real gap. loadGraph │
│ generate it myself, so that's │ (loadGraph.ts:10) does a bare │
│ not really a concern."        │ `graph as unknown as Graph`   │
│                               │ cast — zero validation. I     │
│                               │ trust the build artifact      │
│                               │ completely. So a malformed    │
│                               │ file wouldn't fail cleanly at │
│                               │ the boundary; it'd surface as │
│                               │ undefined behavior deep in    │
│                               │ the search — a missing node    │
│                               │ in adjacency, an undefined     │
│                               │ edge lookup. I'd add a         │
│                               │ schema validation pass on      │
│                               │ load. Chapter 7 covers the     │
│                               │ exact fix."                    │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:                │ Why it works:                  │
│ Dismisses the question. "I    │ Names the exact line, names    │
│ generate it" ignores disk     │ the failure MODE (undefined    │
│ corruption, a broken build,   │ behavior deep in the search,   │
│ a partial write. It signals   │ not a clean boundary error),   │
│ you don't think in trust      │ and names the fix. Owning a    │
│ boundaries.                   │ gap precisely beats hiding it. │
└──────────────────────────────┴──────────────────────────────┘
```

The `loadGraph()` cast is your real validation gap — `graph as unknown as
Graph` (loadGraph.ts:10) means the runtime trusts the file with no check. Saying
this plainly, with the line number, is far stronger than pretending it's not a
concern.

```
┃ "loadGraph does a bare cast with zero validation. A bad
┃  file surfaces as undefined behavior deep in the search,
┃  not a clean error at the boundary. That's a real gap."
```

---

## Where the failure conversation goes next

```
  You explained the degrade-honestly elevation handling.
        │
        ├─► IF THEY ASK "why route over flat data at all?"
        │     "Connectivity over fidelity. Flat grades are
        │      wrong, but they keep the graph connected so
        │      routing still works. Failing the whole build
        │      would leave the user with nothing. Degraded-
        │      but-usable beats correct-but-broken."
        │
        ├─► IF THEY ASK "how do you avoid the retry looping
        │   │   forever?"
        │     "Retry budget — MAX_RETRIES (useTileGraph.ts:65).
        │      A real (non-degraded) build stops it. During a
        │      sustained outage it gives up after N tries and
        │      keeps the last data rather than thrashing."
        │
        └─► IF THEY ASK "what about the geocoding APIs failing?"
              "Wrapped in try/catch — a failed lookup sets a
               user-facing error ('From not found', 'Lookup
               failed — try again', MapScreen.tsx) rather than
               crashing. Autocomplete swallows transient
               rate-limit errors silently."
```

---

## The "I don't know" box — observability under failure

The gap an experienced operator will probe: how would you *know* a failure
happened in production?

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "In production, how would you know the elevation  ║
║   API started failing for real users? What's your alerting,   ║
║   your error-rate dashboards, your on-call story?"            ║
║                                                               ║
║   flattr has graceful degradation but essentially NO          ║
║   observability — no metrics pipeline, no alerting, no        ║
║   centralized logging. And you haven't operated production    ║
║   monitoring at scale. Don't invent a Datadog setup.          ║
║                                                               ║
║   Say:                                                         ║
║   "Honestly, the observability story is thin. The system      ║
║    degrades gracefully but it doesn't REPORT — there's a      ║
║    `degraded` flag that drives the UI, but nothing emits      ║
║    that to a metrics backend, so I'd have no aggregate view   ║
║    of how often it's happening. If this were a real product   ║
║    the first thing I'd add is a counter on the degraded-      ║
║    fallback path and an alert on its rate. I haven't          ║
║    operated production monitoring at scale, so I'd be         ║
║    learning the alerting tooling, but I know exactly where    ║
║    the signal already exists in my code to emit."             ║
║                                                               ║
║   What this signals: you know the difference between          ║
║   handling a failure and OBSERVING it, you know your code     ║
║   has the signal but not the pipeline, and you're honest      ║
║   about not having run production monitoring.                 ║
║                                                               ║
║   Do NOT say:                                                  ║
║   "I'd set up Prometheus and Grafana and PagerDuty with       ║
║    SLOs..." naming a stack you haven't run. The follow-up     ║
║   ("what SLO would you set?") exposes it.                     ║
╚═══════════════════════════════════════════════════════════════╝
```

Deeper on failure surfaces, structured logging, and the observability you'd add
→ `.aipe/study-debugging-observability/`. The 429 / retry / network-failure
mechanics → `.aipe/study-networking/`.

---

## What you'd change about failure handling

The clear one: validate `graph.json` on load. Right now the trust boundary at
`loadGraph()` has no guard — a bad file becomes undefined behavior deep in the
search instead of a clean error where the data enters the system. A schema check
on load (verify every adjacency id resolves to a real edge, every edge's
endpoints exist, grades are finite) would turn a mystery crash into a precise
boundary error. It's the highest-leverage operational fix in the codebase and
Chapter 7 lays out exactly how. Everything else — degrade-honestly elevation,
finite BLOCKED, the steep-vs-disconnected distinction — I'd keep as-is; those
are the strong parts.

---

## One-page summary — Chapter 5

**Core claim:** flattr degrades honestly — it returns the best available answer
*and marks it degraded* — for two failures, and has one real gap (unvalidated
graph load) you should own precisely.

**The failure surfaces:**
- **Elevation 429** → retry+backoff, then flat-marked-degraded fallback, self-heal retry, persistent cache (elevation.ts, useTileGraph.ts:20). ✔
- **No flat route** → finite BLOCKED (1e9) means A* returns the steep route with `steepEdges` flagged (cost.ts:5, astar.ts:126). ✔
- **No route at all** → disconnected components → `path: null` (astar.ts:77). Distinct from steep. ✔
- **Corrupt graph.json** → `graph as unknown as Graph` cast, zero validation (loadGraph.ts:10). ✘ The gap.
- **Observability** → degradation exists, reporting doesn't. ✘ Gap.

**Pull quotes:**
- ┃ "When it degrades, it doesn't lie — it marks the region degraded and tells the user."
- ▸ "no flat way" and "no way at all" are two graph states; finite BLOCKED keeps them distinct.
- ┃ "loadGraph does a bare cast with zero validation — a real gap."

**What you'd change:** Validate `graph.json` on load — turn the unguarded trust boundary into a precise boundary error. Highest-leverage operational fix in the repo.
