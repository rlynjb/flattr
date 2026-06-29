# LLM Cost Optimization

*Industry name: inference cost management — a production-serving discipline.*

## Zoom out

```
  The three cost levers (per request)
  ┌──────────────────────────────────────────────┐
  │  cost ≈ (input_tokens + output_tokens) × $/tok │
  │                                                │
  │   ① FEWER TOKENS   trim prompt, cap output     │
  │   ② CHEAPER MODEL  route easy calls to small   │
  │   ③ FEWER CALLS    cache + batch                │
  └──────────────────────────────────────────────┘
```

LLM cost is almost entirely tokens × price. Every optimization is one of three moves: send fewer tokens, use a cheaper model for the request, or avoid the call entirely. The discipline is knowing *which* lever a given workload responds to before reaching for it.

## How it works

### Move 1 — the pattern: measure, then pull a lever

```
  workload ─► measure tokens/call ─► find the fat ─► pull ONE lever ─► re-measure
```

Mental model: cost optimization is profiling with a dollar y-axis. You never guess; you instrument tokens per call, find where the volume is (usually a bloated system prompt or oversized context), and cut there first.

### Move 2 — step by step

```
  ① FEWER TOKENS
     - drop redundant context, summarize history
     - set max_tokens; stop sequences
     - structured output (JSON) over prose
  ② CHEAPER MODEL  (model routing)
     - classify request difficulty
     - easy → small/cheap model; hard → large model
  ③ FEWER CALLS
     - cache identical/near-identical prompts (→ 01)
     - batch many items into one call
     - prompt caching for stable prefixes
```

The biggest wins are usually structural: a 4k-token system prompt sent on every request is the thing to fix, not shaving a word off the user message.

### Move 3 — the principle

**Cost is a function of volume × unit price; optimize the dominant term.** This generalizes beyond LLMs to *any* metered external dependency — the unit might be tokens, API requests, or quota slots. The skill is identical: find the dominant cost term and attack it.

## In this codebase

**N/A for LLM cost — there is no inference, so there is no token bill.** Inventing one would be dishonest. But flattr has a *real, structurally identical* cost concern, and it's worth naming because the optimization muscle transfers exactly:

```
  flattr's metered dependency: the Open-Meteo Elevation API
  ┌────────────────────────────────────────────────────────┐
  │  cost unit = HTTP requests against a free-tier quota     │
  │  failure mode = 429 Too Many Requests                    │
  │  this is BUILD-TIME, not inference-time                  │
  └────────────────────────────────────────────────────────┘
```

The same three levers, applied to elevation requests:

- **① "Fewer tokens" → fewer points per request / coarser sampling.** `pipeline/elevation.ts` `sampleElevations` takes a `dedupePrecision` — nodes in the same ~90m DEM cell collapse to *one* query (`keyOf`, `repByKey`), because sampling finer than the DEM resolution is wasted spend. That is trimming the payload to the useful resolution. Batching is here too: `OPEN_METEO_BATCH = 100` packs 100 points per call.
- **② "Cheaper model" → cheaper provider.** `ElevationProvider` is a pluggable interface (`fixtureProvider`, `openMeteoProvider`, `googleProvider`). Open-Meteo is the free default; Google (paid, higher fidelity) is the upgrade. That *is* model routing — pick the cheap source unless you need the expensive one's quality.
- **③ "Fewer calls" → cache.** `mobile/src/elevCache.ts` persists samples forever (DEM values never change), so a covered area never re-hits the quota. See `01-llm-caching.md`.

So every classic LLM cost lever already has a working analog here — just pointed at an elevation API quota instead of a token bill. **Not exercised for LLM** because there is no LLM; if narration were added at `features/routing/summary.ts:11`, lever ① (short prompt, cap output) + lever ③ (route cache) would be the first two moves.

## See also

- `01-llm-caching.md` — lever ③, the highest-leverage cost cut
- `04-rate-limiting-backpressure.md` — the flip side: staying *under* the quota in real time
- `pipeline/elevation.ts` — dedup, batching, and provider routing in real code
