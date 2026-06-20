# Chapter 5 — The failure story

This is your strongest chapter, and you should know that going in. Most portfolio projects have no failure story — they work on the happy path and crash otherwise. flattr has a real one, because you *lived* the failures: the elevation API throttled you into an all-green map, distant points returned "no route," and you built deliberate, honest degradation for each. When an interviewer asks "what happens when things go wrong," you don't have to hypothesize. You can say "here's what broke, here's what the system does now, and here's the principle."

The principle that runs through every failure surface in flattr is the same: **degrade honestly, never lie.** When elevation is unavailable, don't show fake-flat grades as if they're real — show them and mark them approximate. When a route crosses a steep block, don't say "no route" — return it and flag it. When the graph genuinely can't connect two points, *that's* when you say no. The system distinguishes "degraded" from "broken" everywhere, and that distinction is the whole answer.

```
  FAILURE SURFACES — and the system's response to each

  ┌─ EXTERNAL: elevation API (Open-Meteo) ──────────────────┐
  │  fails/429 ─► best-effort: build region FLAT, mark it    │
  │              degraded, retry quietly, cache real values. │
  │              UI: route card says "grades approximate."   │
  │              Degraded regions excluded from the heatmap   │
  │              so flat-green never masks real grades.       │
  └──────────────────────────────────────────────────────────┘
  ┌─ EXTERNAL: street data (Overpass) ──────────────────────┐
  │  fails ─► retry w/ backoff; if still down, that tile     │
  │           just doesn't load. Base graph still routes.     │
  └──────────────────────────────────────────────────────────┘
  ┌─ EXTERNAL: geocoder (Nominatim) ────────────────────────┐
  │  no match ─► "From/To not found"; rate-limited ─► debounce│
  │              keeps it under the ~1 req/s policy.          │
  └──────────────────────────────────────────────────────────┘
  ┌─ ALGORITHMIC: only-steep route ─────────────────────────┐
  │  every path crosses a too-steep edge ─► RETURN it,       │
  │  BLOCKED=1e9 keeps cost finite, flag steepEdges.          │
  │  NOT the same as "no route."                             │
  └──────────────────────────────────────────────────────────┘
  ┌─ ALGORITHMIC: disconnected graph ───────────────────────┐
  │  open set drains, goal never reached ─► return null,      │
  │  "No route between those points." (the honest no)        │
  └──────────────────────────────────────────────────────────┘
  ┌─ INPUT/DEVICE: GPS denied, malformed artifact ──────────┐
  │  GPS denied ─► fall back to the bundled area center.      │
  │  graph.json malformed ─► UNGUARDED today (a real gap).   │
  └──────────────────────────────────────────────────────────┘
```

Read that map top to bottom and notice: every external and algorithmic failure has a designed response. The one box that says "unguarded" is the honest gap, and naming it yourself is stronger than getting caught on it.

## "What happens when the elevation API is down?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Your elevation comes from a free API. What     │
│    happens when it fails or rate-limits?"          │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you handle external-dependency failure, and  │
│   do you handle it HONESTLY — or does the app      │
│   silently show wrong data?                        │
└─────────────────────────────────────────────────┘

> "This is the failure I actually hit — heavy testing exhausted the free quota and Open-Meteo started returning 429s. The system degrades best-effort: instead of failing the whole graph build, it builds that region with flat elevation so the streets still render and routing still connects — but it *marks the region degraded*. Two things follow from that flag. First, the route summary card shows 'grades approximate' so the climb number is never presented as real when it isn't. Second — and this is the bug I had to fix — degraded regions are excluded from the heatmap, because a flat-green region was painting over the real grades underneath and making the whole map look flat. Then a quiet, capped retry re-fetches once the API recovers, and every successful fetch is cached to disk so that cell never gets requested again. The principle is: degrade, but never lie about it."

This is the answer that wins the chapter, because the throttling, the all-green masking, and the persistent cache are all things you built and can describe from memory. The "never lie" framing is the senior signal.

┃ "Degrade, but never lie about it — a flat fallback gets *marked* approximate, it doesn't masquerade as real terrain."

| WEAK ANSWER | STRONG ANSWER |
|---|---|
| "If the API fails I catch the error and just use zero elevation so it doesn't crash." | "Best-effort flat fallback, but the region is *marked degraded*: the route card says 'grades approximate,' degraded regions are kept out of the heatmap so they don't mask real grades, a capped retry upgrades them, and a disk cache means a fetched cell never re-requests." |
| **Why it's weak:** zero-elevation-on-error without marking it is exactly the lie — the user sees a flat map and believes it. "Doesn't crash" is a low bar. | **Why it works:** it handles the failure *and* the honesty problem, names the real bug (masking), and closes the loop with retry + cache. |

## "How do you tell 'steep route' from 'no route'?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "If everything's too steep, what does the user   │
│    get? An error?"                                 │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you distinguish 'constraint can't be          │
│   satisfied' from 'genuinely impossible'? Most     │
│   routers collapse these into one failure.        │
└─────────────────────────────────────────────────┘

> "These are two different graph states and I keep them separate. When every route crosses a block steeper than your `userMax`, I still return a route — the steep edges get a `BLOCKED` penalty that's a huge but *finite* number, 1e9, so the cost stays comparable and A\* picks the least-bad path. Then `summarizePath` flags which segments are over-limit, and the UI shows 'flattest available' with the steep blocks marked. I reserve actual 'no route' — returning null — for when the graph is genuinely disconnected: the search drains its frontier without ever reaching the goal. If I'd used `Infinity` instead of 1e9, those two states would collapse into one, because every steep route would look infinitely expensive and indistinguishable from no route at all."

The `1e9`-not-`Infinity` detail is a small decision that signals real care. It's also testable in your repo (the steep-vs-null tests), so you can back it up.

```
  IF THEY PUSH ON THE BLOCKED SENTINEL

  "BLOCKED is 1e9, finite, not Infinity."
        │
        ├─► "Why does finite matter?"
        │     "So an only-steep path stays a returnable, comparable
        │      answer — 'flattest available' — distinct from null,
        │      which means disconnected. Infinity collapses them."
        │
        ├─► "Wouldn't Infinity also work for blocking?"
        │     "It blocks, but it destroys information, and
        │      Infinity−Infinity is NaN, which my heap rejects.
        │      1e9 blocks without breaking arithmetic."
        │
        └─► "How do you test that distinction?"
              "Two fixtures: an only-steep graph asserts a path with
               steepEdges flagged; a disconnected graph asserts null."
```

## "What's NOT handled?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                          │
│   "Where are the gaps in your error handling?"    │
│                                                   │
│ WHAT THEY'RE TESTING                              │
│   Do you know your own weak spots, or will you    │
│   claim it all works? Naming the gap first is the │
│   senior move.                                    │
└─────────────────────────────────────────────────┘

Volunteer this before they find it:

> "The biggest gap is the graph artifact itself. `graph.json` is loaded and cast straight to the graph type with no runtime validation — if a build shipped a malformed or schema-drifted artifact, it wouldn't fail at load with a clear error; it'd fail deep inside A\* with an undefined dereference, which is a miserable way to find out. There's also no schema version on the artifact, so an old file would silently mis-read. For a single-developer project where I control the build that's a calculated risk, but it's the first hardening I'd add — validate the artifact on load and fail fast with a real message."

╔═══════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                ║
║                                                   ║
║   They ask about a failure class flattr doesn't    ║
║   have — partial writes, transaction rollback,     ║
║   split-brain, message redelivery. flattr has no   ║
║   writes and no distributed state, so these don't  ║
║   apply.                                          ║
║                                                   ║
║   Say:                                            ║
║   "flattr has no writes and no distributed state   ║
║    — it's a read-only client over a static graph,  ║
║    so partial-write and consistency failures       ║
║    don't arise here. I've reasoned about           ║
║    delivery-semantics failures conceptually, but   ║
║    I haven't operated a system where they bite —   ║
║    that's honest. The failures that ARE real here  ║
║    are external-API and algorithmic, and those I   ║
║    designed for."                                  ║
║                                                   ║
║   What this signals: you know which failure        ║
║   classes your architecture even HAS, and you      ║
║   don't claim experience with ones it doesn't.    ║
║                                                   ║
║   Do NOT say:                                      ║
║   "I'd use idempotency keys and a saga pattern…"   ║
║   for a system with no writes — naming patterns    ║
║   that don't apply shows you're pattern-matching,  ║
║   not thinking about your actual system.          ║
╚═══════════════════════════════════════════════════╝

▸ "No route" is a promise, not a shrug. flattr only says it when the graph is truly disconnected — everything else degrades to "flattest available."

## What you'd change

The failure handling I'd change is the unguarded artifact load. Everything *external* — the APIs — degrades gracefully, but the one piece of data the whole app depends on, `graph.json`, is trusted blindly. I'd add a lightweight schema check and a version field on load, so a bad artifact fails immediately with "graph.json failed validation" instead of surfacing as a cryptic crash mid-search. I left it unguarded because I control the build and never shipped a bad one — but that's exactly the kind of "it's fine because I'm careful" reasoning that stops being true the moment someone else touches the pipeline. Honest failure handling means the *internal* trust boundary gets the same treatment as the external ones.

## One-page summary

**Core claim:** flattr's failure principle is "degrade honestly, never lie" — it distinguishes degraded from broken everywhere, and reserves hard failures (null, errors) for genuinely impossible states.

- **Elevation API down/429:** best-effort flat build, region *marked degraded*, "grades approximate" on the card, degraded regions excluded from heatmap, capped retry + disk cache. (The failure you actually lived.)
- **Steep vs no route:** only-steep returns a path with `BLOCKED=1e9` (finite) flagged as "flattest available"; disconnected returns null = "no route." Infinity would collapse them.
- **Overpass/geocode:** retry/backoff; tile just doesn't load, base still routes; geocode debounced under the rate policy; "not found" on no match.
- **The gap (volunteer it):** `graph.json` is cast unvalidated with no schema version — fails deep in A\* instead of fast at load.

┃ "Degrade, but never lie about it."
┃ "1e9, not Infinity — so 'flattest available' stays distinct from 'no route.'"

**What you'd change:** Validate `graph.json` on load with a schema check and version field — give the internal trust boundary the same honest failure handling the external APIs already get.
