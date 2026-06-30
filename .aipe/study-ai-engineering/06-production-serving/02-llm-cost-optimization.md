# LLM cost optimization — cheap-model-first, on-device-first

**Industry name(s):** model routing / cost-tiering / on-device inference.
**Type:** Industry standard (study material). **Not present in flattr** — there's no LLM call to cost.

## Zoom out — flattr's real cost lever is on-device, not model choice

flattr's marginal cost per route is already near zero: routing is local
graph math, the only network calls are free (Nominatim, Open-Meteo), and
there's no model to pay for. So LLM cost optimization is study material
here — but you've shipped its strongest form in your portfolio (dryrun:
on-device Gemini Nano; contrl: on-device MediaPipe). The lesson that
transfers: a route-describe feature should turn three numbers into a
short sentence, which is so small it belongs *on-device*, where
cost-per-call rounds to zero. The real cost lever isn't "cheap model vs
expensive model" — it's **on-device vs cloud**.

```
  Zoom out — where cost would enter flattr (it doesn't today)

  ┌─ Routing (local graph math) — $0 marginal ──────────────┐
  └────────────────────────────┬─────────────────────────────┘
  ┌─ Network (TODAY) ──────────▼─────────────────────────────┐
  │  Nominatim geocode · Open-Meteo elevation — FREE         │
  └────────────────────────────┬─────────────────────────────┘
              ★ no paid model call exists
  ┌─ (future) describe ────────▼─────────────────────────────┐
  │  3 numbers → 1 sentence → tiny → ON-DEVICE → ~$0         │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** local compute (free) → free network → (future) inference.
- **Axis — cost per call:** flattr sits at the zero end. The biggest
  movement along this axis isn't model tier; it's the device boundary —
  cloud inference has a per-token price, on-device inference has a
  fixed-hardware price (effectively zero marginal).
- **Seam:** the future describe call sits on `RouteSummary`
  (`summary.ts:5`). Because the input is *tiny and bounded* (three
  numbers, never user free-text), the task is small enough that the
  on-device tier is viable — that's the cost decision, made at the seam.

## How it works

### Move 1 — the mental model

LLM cost optimization is a routing problem: send each request to the
*cheapest tier that can do it*. Tiers, cheapest first: **cache hit** ($0),
**on-device small model** (~$0 marginal), **cheap cloud model**,
**expensive cloud model**. The discipline is to *escalate only on need* —
try the cheap tier, fall back to the expensive one only when quality
fails. flattr's describe task is small enough that it never needs to
escalate past on-device.

```
  Pattern — cost tiers, escalate only on need

  cache hit        $0          ← try first (see 01-llm-caching)
  on-device small  ~$0 marg.   ← flattr's describe lives HERE
  cheap cloud      $           ← escalate if quality fails
  expensive cloud  $$$         ← last resort
```

### Move 2 — the walkthrough

**Why flattr's describe is a tiny task.** The whole input is three
numbers:

```ts
// summary.ts:5 — bounded numeric input, no free text
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

Producing *"Mostly flat, one steep block, 40 m climb"* from that needs no
world knowledge and no long context — it's near-templating. That's the
class of task on-device small models handle well, at zero marginal cost.

**Why "cheap model first" routing is mostly moot here.** Cheap-model-first
routing pays off when tasks *vary* in difficulty and you want to avoid
sending easy ones to an expensive model. flattr's describe task is
*uniformly easy*, so there's one tier (on-device) and nothing to route
between. The cost lever that *does* matter is whether you go on-device at
all — which your dryrun/contrl work already proves is viable on the
hardware flattr targets.

**The cost flattr actually pays — free APIs with quotas.** The honest
"cost" today isn't dollars, it's *quota*: Open-Meteo elevation 429s under
load and Nominatim asks for ~1 req/sec. Those are handled by caching
(`elevCache.ts`) and rate-limiting, not by model tiering — see
[01-llm-caching.md](01-llm-caching.md) and
[04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md).

### Move 3 — the principle

Cost optimization is "cheapest tier that meets quality, escalate only on
need." flattr's describe task is small and uniform, so the answer is the
bottom tier — on-device — and there's nothing above it to route to. The
big cost decision in an Expo app like flattr is the device boundary, not
the model size; you've already shipped the on-device side of that
boundary twice.

## Primary diagram

```
  Cost decision for flattr's describe (it stays at the bottom)

  ┌─ RouteSummary (3 numbers) ──────────────────────────────┐
  │   tiny, bounded, no world knowledge                     │
  └───────────────┬──────────────────────────────────────────┘
                  ▼ cheapest tier that fits
  ┌─ cache hit ($0) ─┐ miss → ┌─ ON-DEVICE small (~$0) ─────┐
  │ 01-llm-caching   │ ─────► │ enough for templated prose  │
  └──────────────────┘        └──────────────────────────────┘
                  (cheap/expensive cloud tiers: not needed)
```

## Elaborate

The subtle trap is over-engineering the cost story for a task that
doesn't have one. A lot of "LLM cost optimization" content assumes a
high-volume, varied-difficulty cloud workload — flattr is the opposite: a
local-first app with a tiny, uniform inference need. The correct staff
answer is to *not* build a model-routing layer here, cache aggressively
(which makes most calls free), and keep inference on-device. Recognizing
when the expensive machinery is unnecessary is itself the optimization.

## Project exercises

### B6-COST.1 — prove the describe task fits on-device

- **Exercise ID:** B6-COST.1
- **What to build:** a spike that generates describe prose from sample
  `RouteSummary` values with a small on-device model (or a deterministic
  template as the floor), measuring latency on a real device.
- **Why it earns its place:** it validates the cost thesis — the task is
  small enough for the zero-marginal tier.
- **Files to touch:** new `features/routing/describe.ts`, reuse
  `RouteSummary` from `summary.ts:5`.
- **Done when:** prose generates on-device under a fixed latency budget
  with no network call.
- **Estimated effort:** 3–4 hrs (model integration spike).

### B6-COST.2 — cache-then-template fallback floor

- **Exercise ID:** B6-COST.2
- **What to build:** a fallback so that on cache miss *and* model
  unavailable, a deterministic template still produces prose — the $0
  floor below the on-device tier.
- **Why it earns its place:** it guarantees the feature never *needs* a
  paid call, anchoring cost at zero.
- **Files to touch:** `features/routing/describe.ts`,
  `features/routing/describe.test.ts`.
- **Done when:** with the model disabled, describe still returns correct
  prose from `RouteSummary` alone.
- **Estimated effort:** 1–2 hrs.

## Interview defense

**Q: how would you control LLM cost in flattr?** Answer: the cost is
already near zero, so the honest answer is to *not* build cloud
model-routing. A route-describe feature turns `RouteSummary`'s three
numbers (`summary.ts:5`) into one short sentence — a tiny, uniform task
that belongs on-device, where marginal cost rounds to zero, which I've
shipped before in dryrun and contrl. Cache hits make most calls free
anyway. The real cost lever in an Expo app is the device boundary, not
model tier — cheap-model-first routing only pays off when task difficulty
varies, and flattr's doesn't. Load-bearing point: pick the cheapest tier
that meets quality and recognize when the expensive routing machinery is
unnecessary.

```
  tiny uniform task → on-device (~$0) → no cloud tier to route to
```

Anchor: *"flattr's describe is small enough that the cost question
answers itself — on-device, $0 — and the staff move is not building a
routing layer it doesn't need."*

## See also

- [01-llm-caching.md](01-llm-caching.md) — a cache hit is the cheapest tier.
- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — quota, flattr's real non-dollar cost.
- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — retries cost calls; budget them.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — cost-per-call as a tracked span attribute.
