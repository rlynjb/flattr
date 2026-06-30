# Retry & circuit breaker — wrapping the external calls

**Industry name(s):** retry / exponential backoff / circuit breaker.
**Type:** Industry standard. **Has a REAL home in flattr** — geocode/elevation throw on failure with no retry today.

## Zoom out — flattr's external calls fail hard, with no retry wrapper

flattr makes real network calls that *throw* on failure, and right now
nothing catches-and-retries them. `geocode()` does `if (!res.ok) throw`
(`geocode.ts:24`); the elevation API 429s under quota. The UI handles the
throw cosmetically — autocomplete swallows it (`ignore transient/rate-limit
errors`), and a failed route just shows "From not found." There's no
retry, no backoff, no circuit breaker. That's an honest gap, and it's the
*real* home for these patterns — the same wrapper that would protect a
future LLM describe call belongs first around `geocode` and elevation.

```
  Zoom out — flattr's external calls, unprotected today

  ┌─ UI (mobile/) ──────────────────────────────────────────┐
  │  catch → "From not found" / swallow suggest errors       │
  └────────────────────────────┬─────────────────────────────┘
              throws straight up ▼ (no retry/backoff)
  ┌─ Engine (pipeline/) ────────────────────────────────────┐
  │  geocode.ts:24  if (!res.ok) throw new Error(...)        │
  │  elevation fetch — 429 on quota                         │
  └────────────────────────────┬─────────────────────────────┘
              ★ this is where a retry/breaker wrapper belongs
```

## Structure pass

- **Layers:** UI (handles failure cosmetically) → engine (throws) →
  external service (transient failures).
- **Axis — failure transience:** a 429 or a network blip is *transient*
  (retry helps); a 404 or malformed query is *permanent* (retry wastes
  calls). Retry logic must split these — flattr currently treats every
  `!res.ok` identically (`geocode.ts:24`).
- **Seam:** `geocode.ts:24` (`if (!res.ok) throw`) is the seam where a
  retry/breaker wrapper attaches. It's a clean choke point — *every*
  geocode failure flows through this one line, so wrapping it covers the
  whole surface.

## How it works

### Move 1 — the mental model

Two patterns, two jobs. **Retry with backoff**: on a *transient* failure,
wait and try again, increasing the wait each time (and jittering it so a
fleet doesn't retry in lockstep) — recovers from blips. **Circuit
breaker**: after N consecutive failures, *stop calling* for a cool-down
window and fail fast — protects a struggling dependency (and your UX)
from a hammering retry storm. Retry handles single failures; the breaker
handles sustained outages.

```
  Pattern — retry vs breaker, by failure shape

  transient blip   → RETRY w/ backoff+jitter (try 2-3×)
  sustained outage → CIRCUIT BREAKER (stop, cool down, fail fast)
  permanent (404)  → neither — surface immediately

  closed ──N fails──► open ──cool-down──► half-open ──ok──► closed
```

### Move 2 — the walkthrough

**The seam — `geocode.ts:24`.** Every failure exits here:

```ts
// geocode.ts:24 — single choke point, throws on ANY non-ok
if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);
```

This is *good*: one place to wrap. But today it's undifferentiated — a
429 (retry-worthy) and a 400 (don't retry) throw the same way.

**What flattr does instead of retry — cosmetic catch.** The UI absorbs
the throw rather than recovering from it:

```ts
// MapScreen.tsx:85 — autocomplete: swallow and move on
} catch {
  // ignore transient/rate-limit errors
}
```

and a route failure becomes `setRouteError("From not found")`
(`MapScreen.tsx:184`). The user just sees "no result" even when a single
retry would have succeeded — that's the gap.

**Where retry belongs — around the elevation 429.** The build-pipeline
elevation fetch 429s under quota; that's the textbook transient case for
backoff. Today `elevCache` reduces *how often* it's hit, but a cold cell
that 429s has no second attempt. A retry-with-backoff wrapper there
(plus the cache) is the right pairing: cache to avoid the call,
retry+backoff for the calls you can't avoid.

**Where the breaker belongs.** If Nominatim is fully down, retrying every
geocode hammers a dead service and freezes the UI. A breaker at the
`geocode.ts:24` seam would, after a few failures, fail fast for a
cool-down window — the user gets an instant "search unavailable" instead
of a spinner. The same breaker would later wrap a describe call.

### Move 3 — the principle

Differentiate the failure, then retry the transient and trip the breaker
on the sustained. flattr has the ideal attach point — one throwing choke
point at `geocode.ts:24` — but no logic behind it yet. The discipline:
retry blips with backoff+jitter, fail fast under sustained outage, and
never retry a permanent error. A future LLM call inherits the exact same
wrapper.

## Primary diagram

```
  Retry + breaker wrapping flattr's choke point

  ┌─ caller (MapScreen) ────────────────────────────────────┐
  │  geocode(from) / elevation fetch                        │
  └───────────────┬──────────────────────────────────────────┘
                  ▼  wrapper around geocode.ts:24
  ┌─ retry/breaker ─────────────────────────────────────────┐
  │  429/5xx/network → retry (backoff+jitter, ≤3)           │
  │  4xx (400/404)   → fail now, no retry                   │
  │  N fails in a row→ OPEN breaker, fail fast, cool down    │
  └───────────────┬──────────────────────────────────────────┘
                  ▼
  ┌─ Nominatim / Open-Meteo ──── (future) cloud describe ───┐
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The subtle interaction is between retry and the *rate limit* from the
previous file: naive retry makes a 429 *worse* — you got throttled, so
you immediately call again. Correct retry on a 429 must back off
*past* the rate-limit window (respect `Retry-After` if present), and the
circuit breaker is what stops a retry loop from becoming a
self-inflicted DDoS on a service that already told you to slow down. In
flattr, retry and the ~1 req/sec spacing must be designed together, not
bolted on separately — the breaker is the safety net that keeps the two
from fighting.

## Project exercises

### B6-RETRY.1 — backoff retry on transient geocode failures

- **Exercise ID:** B6-RETRY.1
- **What to build:** a `withRetry` wrapper around the `geocode.ts:24`
  failure path that retries 429/5xx/network errors up to 3× with
  exponential backoff + jitter, and does *not* retry 4xx.
- **Why it earns its place:** it turns the undifferentiated throw into a
  recovery path, fixing the "no result on a transient blip" UX gap.
- **Files to touch:** `pipeline/geocode.ts` (wrap the fetch),
  new `pipeline/geocode.test.ts` with a flaky `fetchImpl`.
- **Done when:** a `fetchImpl` that 429s once then succeeds returns a
  result; a 400 fails immediately with no retry.
- **Estimated effort:** 2–3 hrs.

### B6-RETRY.2 — circuit breaker on the geocode seam

- **Exercise ID:** B6-RETRY.2
- **What to build:** a breaker that opens after N consecutive geocode
  failures, fails fast during a cool-down, then half-opens to probe
  recovery.
- **Why it earns its place:** it stops a retry storm from hammering a
  down Nominatim and freezing the search UI.
- **Files to touch:** new `pipeline/circuitBreaker.ts`, wired at
  `geocode.ts:24`; surface the open state in `MapScreen.tsx` route error.
- **Done when:** with the service forced down, the breaker opens and the
  UI fails fast instead of spinning per call.
- **Estimated effort:** 3–4 hrs.

## Interview defense

**Q: how does flattr handle a flaky geocode or a 429?** Answer: honestly,
it doesn't retry today — `geocode.ts:24` throws on any non-ok and the UI
just shows "From not found" or swallows the error
(`MapScreen.tsx:85`). That's a real gap, and `geocode.ts:24` is the ideal
place to fix it: one throwing choke point every failure flows through. I'd
wrap it with retry+backoff+jitter for transient 429/5xx (not 4xx) and a
circuit breaker that fails fast under sustained outage — designed
*together* with the ~1 req/sec spacing so retries don't worsen the
throttle. The same wrapper would later protect a cloud describe call.
Load-bearing point: differentiate transient from permanent, retry the
first, trip the breaker on sustained — and flattr already has the clean
seam for it.

```
  geocode.ts:24 throw → [retry transient · breaker on outage] → recover
```

Anchor: *"flattr's retry story is a single line today — `if (!res.ok)
throw` — which is exactly the seam where the wrapper belongs."*

## See also

- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — retry and rate spacing must be designed together.
- [01-llm-caching.md](01-llm-caching.md) — serve stale cache when the call fails.
- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — retries cost calls; the breaker caps the waste.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — retry counts and breaker trips as span attributes.
