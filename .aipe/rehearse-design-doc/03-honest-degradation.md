# Design Doc — Honest degradation under a throttled free elevation API

**One-line summary:** when the free Open-Meteo elevation API rate-limits (HTTP 429), flattr builds the affected region with flat fallback elevation so routing still works, but *marks the region degraded* — the route card says "grades approximate," degraded regions are excluded from the heatmap so flat-green never masks real grades, a capped retry upgrades them once the API recovers, and every real sample is cached to disk so a fetched cell never re-requests.

This is the decision that turns a failure into a design. Lead with the principle — degrade, but never lie — because that's the line a reviewer remembers and it's the thing that separates this from a bare try/catch.

## Context / problem

flattr's grades come from Open-Meteo's free elevation API. "Free" carries a hard cost: a per-minute/daily quota that real usage — and heavy testing — exhausts, after which every request returns 429. This is not a rare edge; it was hit repeatedly during development. The naive responses are both bad: failing the whole graph build on a 429 makes the app unusable, and silently substituting flat (0 m) elevation makes the *entire map look flat* — which silently lies about terrain in a product whose entire purpose is showing terrain. The problem: behave correctly *and honestly* when a load-bearing free dependency is throttled.

## Goals & non-goals

```
  GOALS                                 NON-GOALS
  ─────                                 ─────────
  routing keeps working when            guaranteeing fresh elevation
    elevation is unavailable              (it's a free API)
  NEVER present fake-flat grades as     paying for a reliable provider
    if they were real                     (free-by-default mandate)
  self-heal once the API recovers       eliminating rate limits
  stop re-hitting the API for data        (out of our control)
    we already have
```

The decisive goal is the honesty one: **a flat fallback must be visibly marked, not silently shown.** Everything else (retry, cache) supports keeping the app usable while that honesty holds.

## The decision

A `degraded` flag rides with every fetched region; it drives the UI, the display graph, the retry, and the cache.

```
  DEGRADATION FLOW — fail soft, mark it, heal, cache

  fetch region elevation (Open-Meteo)
        │
        ├─ 200 OK ──► real grades ──► cache cells to AsyncStorage ──┐
        │                                                            │
        └─ 429 / error ──► build region FLAT, mark degraded=true     │
                                  │                                  │
            ┌─────────────────────┼──────────────────────────┐      │
            ▼                     ▼                            ▼      │
     ROUTE CARD            DISPLAY GRAPH                 RETRY        │
     "grades approximate"  exclude degraded region       capped,     │
     (RouteSummaryCard)    from heatmap so it doesn't     quiet      │
                           mask real grades underneath    re-fetch ──┘
                                                          on recovery

  next visit to a cached cell ──► served from disk, ZERO requests, real grades
```

Three mechanisms hang off the flag. **UI honesty:** the route summary shows "grades approximate" so the climb number is never trusted when it's fabricated. **Display correctness:** degraded (flat) regions are kept out of the heatmap — the real bug this fixed was a flat-green region painting over the real grades beneath it and making the whole map read flat. **Recovery + thrift:** a capped, quiet retry re-fetches degraded regions when the quota frees, and a persistent AsyncStorage cache means any cell fetched once (at ~90 m resolution) never costs a request again — which is also the strongest defense against hitting the limit in the first place.

## Alternatives considered

| Alternative | Why it lost |
|-------------|-------------|
| **Fail the build on 429** | Correct-or-nothing. Makes the app unusable during throttling — and throttling is common on the free tier. Availability matters more than perfect grades here. |
| **Silently fall back to flat** | Keeps the app running but *lies*: a flat-green map looks like real flat terrain. Unacceptable in a product whose point is terrain honesty. This was the first instinct and the bug that forced the marked-degraded design. |
| **Pay for Google's elevation API** | Reliable and finer-grained, but violates the free-by-default mandate for a prototype. The right *future* move (behind the existing `ElevationProvider` interface), not the right call now. |
| **No cache, retry-only** | Retries alone keep hitting the quota. The persistent cache is what structurally reduces request volume so throttling becomes rare. |

## Tradeoffs accepted

We chose availability-with-honesty over correctness-or-failure, accepting that **during a throttle the user sees approximate (flat) grades clearly marked as such**, and that **the climb number on a degraded route is provisional**. We also accept the coarseness of the 90 m DEM even on the happy path. Both costs are surfaced to the user rather than hidden — that's the whole point.

> Coach note — where a reviewer pushes: "isn't showing flat grades, even marked, still misleading?" The framing that holds: "the alternative is failing the route entirely. A marked-approximate route the user can choose to trust or not is more useful than no route, and the mark means we never *claim* accuracy we don't have. Honesty isn't hiding the degradation — it's labeling it."

## Risks & mitigations

```
  RISK                               MITIGATION
  ────                               ──────────
  user trusts a fake-flat route      "grades approximate" label +
                                       degraded region kept off heatmap
  retry storms the throttled API     retry is capped and quiet, not
                                       a tight loop
  cache grows unbounded              keyed by ~90m cell; bounded by area
                                       visited; eviction if needed
  cache serves stale elevation       elevation doesn't change — a fetched
                                       cell is valid indefinitely
```

## Rollout / migration

Layered onto the existing pipeline without changing its happy path — a 200 still produces real grades and now also populates the cache. The forward path is the paid provider: because elevation is already behind the `ElevationProvider` interface, adding Google as an opt-in higher-fidelity source is a one-file change, and the degradation machinery applies to it unchanged.

## Open questions

1. **Cache invalidation:** elevation is effectively immutable, but is there any case (DEM corrections) where a cell should expire?
2. **Degraded UX:** is "grades approximate" enough signal, or should the heatmap show degraded regions in a distinct "unknown" treatment rather than omitting them?
3. **Provider fallback policy:** if a paid provider is added, should a free-tier 429 auto-escalate to it, or stay manual?

┃ "Degrade, but never lie about it — a flat fallback gets marked approximate, it doesn't masquerade as real terrain."
┃ "The persistent cache isn't just speed — it's the structural reason throttling becomes rare."
