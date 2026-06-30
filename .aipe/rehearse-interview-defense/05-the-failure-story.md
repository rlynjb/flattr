# Chapter 5 — The Failure Story

"What happens when things go wrong?" tests operational thinking. For most
apps the failure surfaces are network calls, database outages, and bad input.
flattr has fewer of those than most — no server means no server outage, no DB
means no read-only failover — but the ones it has are *interesting*, and
flattr's whole posture toward them has a name worth saying out loud:
**degrade honestly.** When the system can't give you the real answer, it gives
you a marked-as-approximate answer rather than a lie or a crash.

The single best concept in this chapter is the `BLOCKED` sentinel. flattr
draws a deliberate distinction between "there's no *flat* route" and "there's
no route *at all*," and it does it with a number — `BLOCKED = 1e9`, large but
finite (cost.ts:5). That choice is a small thing that signals a lot, and
it's the thing to lead with.

---

## The failure-mode map

This is the chapter's spine: every failure surface flattr actually has, and
what the system does when it hits. Notice how many resolve to "degrade and
mark it," not "crash."

```
  flattr failure surfaces — and the system's response

  ┌─ BUILD TIME ────────────────────────────────────────────────────┐
  │                                                                  │
  │  Open-Meteo 429 (quota)  ──► retry w/ backoff x3 (elevation.ts)  │
  │                              then flat-fallback, mark DEGRADED    │
  │                                                                  │
  │  bad OSM geometry        ──► split/grade handle at build;        │
  │                              never reaches the user              │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ RUNTIME ───────────────────────────────────────────────────────┐
  │                                                                  │
  │  no FLAT route exists    ──► BLOCKED=1e9 (finite) — return the   │
  │  (all paths too steep)       steep path, FLAG steepEdges         │
  │                              "here's a route, but it's steep"    │
  │                                                                  │
  │  no route AT ALL         ──► path = null — start/end in          │
  │  (disconnected graph)        separate components, "no route"     │
  │                              MapScreen pre-loads corridor tiles   │
  │                              to PREVENT this                      │
  │                                                                  │
  │  degraded-grade region   ──► RouteSummaryCard note:              │
  │  loaded                      "Grades approximate — elevation     │
  │                              unavailable, retrying"              │
  │                                                                  │
  │  malformed graph.json    ──► ⚠ NO GUARD. loadGraph() casts and   │
  │  (the GAP)                   trusts. This is the real hole.       │
  └──────────────────────────────────────────────────────────────────┘
```

Two of those boxes are the strong story (degrade honestly + the BLOCKED
distinction). One — the unvalidated graph load — is the genuine gap, and this
chapter teaches you to volunteer it rather than hope they don't find it.

---

## The headline — "no flat route" vs "no route at all"

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What happens if there's no route between the two      │
│    points the user picks?"                               │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   Do you distinguish failure MODES, or do you treat      │
│   "couldn't give a good answer" as one undifferentiated  │
│   error? The strong systems thinker knows that "no route │
│   that meets your constraint" and "no route, period" are │
│   different failures that deserve different responses.   │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "There are two different failures here, and flattr treats them differently
> on purpose. The first is 'there's no *flat* route' — every path from A to
> B has a segment steeper than your `userMax`. The second is 'there's no
> route *at all*' — the two points are in disconnected parts of the graph.
>
> The trick is in the cost function. When a grade exceeds `userMax`, the
> penalty returns `BLOCKED`, which is `1e9` — a huge number, but *finite*,
> not `Infinity` (cost.ts:5). That's deliberate. Because it's finite, an
> only-steep path still has a real, comparable cost, so the search still
> returns it — and I flag every over-limit segment in `steepEdges` on the
> resulting path (astar.ts:126). So the user gets 'here's a route, but these
> parts are steep' instead of a dead end. If I'd used `Infinity`, those paths
> would be unreachable and 'too steep' would collapse into 'no route.'
>
> The genuine 'no route at all' case — disconnected components — is the one
> where `search` returns `path: null` (astar.ts:77). And I actually work to
> prevent it: when both endpoints are set, `MapScreen` pre-loads every graph
> tile spanning them plus a margin, so a distant start and end don't land in
> separate components and fail spuriously (MapScreen.tsx:139). The failure I
> can't prevent — genuinely disconnected geography — surfaces honestly as 'no
> route.'"

The `BLOCKED = 1e9` finite-vs-infinite distinction is the single most
interview-worthy detail in flattr's failure handling. It's a one-character
design decision (`1e9` not `Infinity`) that encodes a whole product
philosophy: never say "no" when you can say "yes, but steep."

```
┃ "BLOCKED is 1e9, not Infinity — on purpose. Finite means
┃  'no flat route' stays a returnable, flagged path instead
┃  of collapsing into 'no route at all.'"
```

---

## The degrade-honestly pattern — the elevation 429

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What happens when the elevation API fails or rate-    │
│    limits you?"                                          │
│                                                          │
│ WHAT THEY'RE REALLY ASKING                               │
│   When a dependency degrades, does your system lie,      │
│   crash, or tell the truth? "Degrade honestly" — return  │
│   a usable-but-marked-approximate result — is the mature │
│   answer, and they want to see if you reach for it.      │
└─────────────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "Open-Meteo is build-time only, so a user never waits on it — but the build
> still has to handle it degrading. `elevation.ts` retries 429s with
> exponential backoff, three attempts (elevation.ts:97, :114). If the quota's
> genuinely exhausted, instead of stalling forever on doomed retries, the
> build degrades that region to flat-fallback elevation and *marks it
> degraded* — that's a real flag on the region (useTileGraph.ts:75).
>
> The honesty part is what happens next. A degraded region's grades are
> fallback, not real, so two things follow: the display graph *excludes*
> degraded regions from the heatmap so I'm never coloring a street with a
> grade I made up (useTileGraph.ts:147), and the route summary card shows the
> user 'Grades approximate — elevation unavailable, retrying'
> (MapScreen.tsx:372). And the system keeps trying to upgrade the region in
> the background, bounded by a max retry count so it doesn't loop forever
> during a sustained outage (useTileGraph.ts:209). So the failure mode is:
> show a usable result, mark it as approximate, and quietly try to make it
> real. Never crash, never silently lie."

"Degrade honestly" is the phrase to plant. It names a coherent operational
philosophy, and flattr genuinely implements it in three places — exclude from
heatmap, mark on the card, bounded background retry.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "If the elevation API   │ "It retries 429s with   │
│ fails the build would    │ backoff, then degrades  │
│ probably error out, but  │ to flat-fallback and    │
│ it's only at build time  │ MARKS the region        │
│ so it doesn't really     │ degraded. The heatmap   │
│ matter."                 │ excludes those regions  │
│                          │ so I never show a fake  │
│                          │ grade, the card tells   │
│                          │ the user 'approximate', │
│                          │ and it retries in the   │
│                          │ background, bounded.    │
│                          │ Degrade honestly."      │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "Probably errors out"    │ Names the actual        │
│ means you don't know     │ behavior with file      │
│ what your own build      │ refs, names the         │
│ does. "Doesn't matter"   │ philosophy (degrade     │
│ dismisses the question   │ honestly), and shows    │
│ the interviewer cared    │ the three places it's   │
│ enough to ask.           │ enforced. Confident,    │
│                          │ specific, true.         │
└─────────────────────────┴─────────────────────────┘
```

---

## The follow-up tree — where failure questions branch

```
  "What happens when things go wrong?"
        │
        ├─► IF THEY ASK about the elevation API
        │     → degrade honestly. Retry x3 → flat-fallback → mark
        │       degraded → exclude from heatmap → card warns → bounded
        │       background retry. (elevation.ts, useTileGraph.ts)
        │
        ├─► IF THEY ASK about "no route"
        │     → two modes. Too-steep = BLOCKED finite = flagged path
        │       returned. Disconnected = path null. Corridor pre-load
        │       prevents the spurious-disconnect case. (cost.ts:5,
        │       astar.ts:77, MapScreen.tsx:139)
        │
        ├─► IF THEY ASK about bad user input
        │     → endpoints stored as coords, re-snapped to nearest node
        │       on the current graph (MapScreen.tsx:133). A tap in the
        │       ocean snaps to the nearest land node — degraded, but not
        │       a crash.
        │
        └─► IF THEY ASK about a corrupt or malformed graph.json
              → THE GAP. loadGraph just casts and trusts (loadGraph.ts:10).
                No schema validation. Own it — see the box below.
```

The bad-input branch is quietly strong: because endpoints are stored as
*coordinates* and re-snapped to the nearest node on every graph change
(MapScreen.tsx:133), there's no "stale node id" failure class at all. Mention
it — it's a design decision that eliminated a whole category of bug.

---

## When the failure question hits the real gap

This is the one place in the chapter where the honest answer is "that's not
guarded, and here's what I'd do." Volunteer it.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW (or: when the honest answer is "no guard") ║
║                                                               ║
║   They ask: "What happens if graph.json is malformed or       ║
║   corrupt — wrong schema, missing a field, truncated          ║
║   download?"                                                  ║
║                                                               ║
║   This is a real hole. loadGraph() just casts the bundled     ║
║   JSON to a Graph and returns it — no validation, no schema    ║
║   check (loadGraph.ts:10). A malformed graph wouldn't fail at  ║
║   load; it'd fail later, somewhere deep in the search, with a  ║
║   confusing error — or worse, silently mis-route. Do not       ║
║   pretend there's a guard.                                    ║
║                                                               ║
║   Say:                                                        ║
║   "Honestly, that's not guarded today. loadGraph just casts    ║
║    the JSON and trusts it — `graph as unknown as Graph`. It's  ║
║    safe in practice because I'm the only one producing the     ║
║    file and it's bundled, not downloaded, so it can't be       ║
║    tampered with at runtime. But it's a real gap: a            ║
║    malformed graph would fail late and confusingly instead of  ║
║    loudly at load. What I'd add is a validation step at the     ║
║    load seam — a schema check that asserts the node/edge       ║
║    shape and the adjacency integrity, so a bad artifact fails  ║
║    immediately with a clear message. That's actually my top    ║
║    counterfactual for this project."                          ║
║                                                               ║
║   What this signals: you KNOW your own gaps before the         ║
║   interviewer finds them, you explain WHY it's currently safe  ║
║   (bundled, single producer) without using that as an excuse,  ║
║   and you already have the fix specified. Volunteering a       ║
║   weakness with its remedy is a stronger signal than a clean   ║
║   answer to an easy question.                                 ║
╚═══════════════════════════════════════════════════════════════╝
```

```
┃ "The strongest failure answer names the failure mode the
┃  system handles well AND the one it doesn't — before the
┃  interviewer finds the second one for you."
```

---

## What you'd change

The failure gap to close is the unvalidated graph load. Today `loadGraph`
trusts the artifact completely (loadGraph.ts:10); the fix is a validation
layer at that seam that checks the schema and the adjacency integrity on load,
so a malformed or stale graph fails loudly and immediately instead of silently
mis-routing or crashing deep in the search. It's the highest-leverage change
in the codebase because it's the one place a bad input crosses a trust
boundary with no check — and Chapter 7 makes it the lead counterfactual.

---

## One-page summary — read this the night before

**Core claim:** flattr's failure posture is "degrade honestly" — when it
can't give the real answer, it gives a marked-approximate one, never a crash
or a silent lie. Lead with the `BLOCKED = 1e9` finite-vs-infinite distinction.

**Questions covered:**
- *"No route?"* → two modes. Too-steep: `BLOCKED` is finite (cost.ts:5), so a
  steep path is returned and flagged (`steepEdges`, astar.ts:126).
  Disconnected: `path = null` (astar.ts:77); corridor pre-load prevents
  spurious disconnects (MapScreen.tsx:139).
- *"Elevation API fails?"* → retry x3 (elevation.ts:97) → flat-fallback →
  mark degraded → exclude from heatmap → warn on card → bounded background
  retry. Degrade honestly.
- *"Bad input?"* → endpoints are coords, re-snapped to nearest node
  (MapScreen.tsx:133); no stale-id failure class exists.
- *"Malformed graph.json?"* → THE GAP. `loadGraph` casts and trusts
  (loadGraph.ts:10). No validation. Own it; the fix is a load-time schema
  check.

**Pull quotes:**
- "BLOCKED is 1e9, not Infinity — finite means 'no flat route' stays a
  returnable, flagged path."
- "Name the failure mode you handle well AND the one you don't, before they
  find the second."

**What you'd change:** Add a validation layer at the `loadGraph` seam so a
malformed graph fails loudly at load.
