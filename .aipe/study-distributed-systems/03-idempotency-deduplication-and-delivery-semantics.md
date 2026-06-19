# Idempotency, de-duplication, and delivery semantics
### why retrying is safe, and how duplicate work is collapsed
**Industry name:** idempotency, request de-duplication, at-least-once / effectively-once · **Type:** Industry standard

## Zoom out, then zoom in

`02` left a loose end: it retries remote calls freely. That's only safe if a retry can't do damage — if calling twice equals calling once. This file is about *why* flattr's retries are safe (idempotency by construction) and where it actively *collapses* duplicate work (de-duplication and batching) to stay under rate limits.

```
  Zoom out — where idempotency & dedup live

  ┌─ Coordination layer (yours) ────────────────────────────────┐
  │  retry loops (02) ──► call remote                           │
  │  ┌──────────────────────────────────────────────────────┐  │
  │  │ ★ sampleElevations: dedup to 1 query per DEM cell ★    │  │ ← we are here
  │  │ ★ providers: batch N points per request ★             │  │
  │  └──────────────────────────────────────────────────────┘  │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK ═══ (every hop is a READ)
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  Overpass / Open-Meteo / Nominatim — pure GET/POST, no       │
  │  server-side state you mutate → retry can't double-apply     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: two questions. *Delivery semantics* — "if my retry means the request actually ran twice, is that a problem?" Answer for flattr: no, because every call is a read keyed only by its inputs. *De-duplication* — "am I sending the same expensive request more than I need to?" Answer: flattr collapses near-duplicate elevation queries to one per DEM cell, then batches. The first is why retries are *correct*; the second is why they're *cheap*.

## Structure pass

**Layers.** Caller → dedup/batch shaping (`sampleElevations`, the batch loops) → retry loop (`02`) → remote read.

**The axis: guarantees — "what's promised about how many times work happens?"** Trace it:

```
  One question — "how many times does the work actually run?" — traced

  ┌──────────────────────────────────────┐
  │ retry loop (02)                       │  → AT-LEAST-once: a retry may
  └──────────────────────────────────────┘    re-send a request that succeeded
      ▲ but the operation is...
  ┌──────────────────────────────────────┐
  │ the remote operation                  │  → IDEMPOTENT (pure read): running
  └──────────────────────────────────────┘    it N times == running it once
      ▲ so the observable effect is...
  ┌──────────────────────────────────────┐
  │ caller's result                       │  → EFFECTIVELY-once: same answer
  └──────────────────────────────────────┘    regardless of how many sends
```

**The seam.** The seam is the operation's *nature*: read vs. write. at-least-once delivery (which any retry gives you) becomes effectively-once *for free* the moment the operation is idempotent. flattr never crosses that seam into mutation, so it never needs idempotency keys or de-dup tokens. That absence is a *design property*, not a gap.

## How it works

#### Move 1 — the mental model

You know idempotency from HTTP already: `GET` and `PUT` are idempotent, `POST` generally isn't. The mental model is a function whose output depends only on its inputs — call it again, get the same answer, change nothing.

```
  Idempotency — same input, same result, no side effect to double

   f(bbox)  ──► streets          f(bbox)  ──► streets   (identical)
   f(bbox)  ──► streets          ───────────────────────
                                 calling twice == calling once
   contrast — a NON-idempotent op:
   charge($5) ──► balance -5     charge($5) ──► balance -10  (BAD on retry)
```

flattr lives entirely in the top row. There is no `charge($5)` anywhere — no remote call mutates state you'd double-apply.

#### Move 2 — walk the parts

**Part 1 — idempotency by construction.** Bridge from a pure function. Every remote call flattr makes is a read keyed only by its arguments: `fetchOverpass(bbox)` returns the streets in a box, `sample(points)` returns elevations for points, `geocode(query)` returns matches for a string. None writes anything server-side. *Consequence:* the `02` retry loops can re-send blindly. If a 504 actually arrived *after* Overpass processed the request, re-sending just re-reads the same streets — no harm. This is why flattr needs **no idempotency key**: the inputs *are* the key, and the operation has no effect to de-duplicate.

```
  At-least-once delivery + idempotent op = effectively-once result

  send #1 ──► [ maybe processed, response lost ] ──► (timeout)
  send #2 ──► [ processed again, same answer    ] ──► 200 streets
                        │
                        └─ second processing is harmless: it's a read.
                           caller sees one consistent result. no key needed.
```

**Part 2 — de-duplication (one query per DEM cell).** Bridge from a `Set` dropping duplicates before a `.map()`. Many graph nodes fall inside the same ~90m elevation cell; sampling each individually is wasted work *and* burns rate-limit budget. `sampleElevations` with `dedupePrecision` snaps each node's lat/lng to a cell key, picks one representative per cell, queries only representatives, then maps the answer back to every node in that cell.

```
  De-duplication — collapse N nodes → 1 query per cell, fan back out

  nodes:   a(47.6000)  b(47.6003)  c(47.6100)
              │            │            │
   keyOf:  "59500,..."  "59500,..."  "59512,..."   ← a,b same cell
              └─────┬──────┘            │
                    ▼                   ▼
   queries:   [ rep(a) ]          [ rep(c) ]        ← 2 queries, not 3
                    │                   │
   map back:  a=e0, b=e0            c=e1            ← b reuses a's answer
```

*What breaks if removed:* without dedup you sample finer than the 90m DEM resolution — wasteful, and worse, you'd compute grades over sub-DEM baselines that spike wildly at cell steps (`run-build.ts:33-37`). So dedup here is simultaneously a *correctness* fix and a *rate-limit* fix. That double-duty is the elegant part.

**Part 3 — batching.** Bridge from `Promise.all` vs. a loop, except here it's the opposite — fewer requests, not more parallelism. Open-Meteo accepts 100 points/request, Google 256. The provider loops over the point list in chunks and packs each chunk into one request. *Consequence:* 150 points become 2 requests, not 150 — fewer round-trips, fewer 429 opportunities, with a throttle `sleep(delayMs)` between batches to stay polite.

```
  Batching — pack the point list into the largest legal request

  150 points ──► [ 0..99 ] ──► one GET ──► 100 elevations
              ──► [100..149] ──► one GET ──► 50 elevations
                                  (throttle sleep between)
   2 requests instead of 150. tested at elevation.test.ts:52-64
```

#### Move 2.5 — the runtime single-flight (a different kind of dedup)

There's a *second* de-duplication mechanism at runtime, and it's worth distinguishing. `useTileGraph`'s `busyRef` (`06`) ensures only one graph build runs at a time, and `covers()` (`:45-49`) skips a fetch entirely if the current region already contains the requested bbox. That's **request-level** single-flight de-dup — "don't fetch what I already have, and don't fetch twice concurrently" — whereas Part 2 is **point-level** dedup *within* one build. Same instinct (don't do duplicate work), two altitudes.

#### Move 3 — the principle

Idempotency is what makes naive retries safe; de-duplication is what makes them cheap. The deepest version of the lesson: if you keep every remote operation a *pure read keyed by its inputs*, you get effectively-once semantics with zero machinery — no keys, no dedup tables, no transaction log. flattr gets exactly-once-observable behavior for free because it never earns the right to need it. The moment a call mutates remote state, all of that machinery becomes mandatory.

## Primary diagram

The full picture — delivery semantics on top, the two dedup mechanisms below.

```
  Idempotency + dedup + batching — recap

  ┌─ caller ─────────────────────────────────────────────────┐
  │  buildGraph(...)                                          │
  │      │                                                    │
  │      ▼                                                    │
  │  sampleElevations(nodes, provider, {dedupePrecision})     │
  │      │  POINT-LEVEL dedup: N nodes → unique cells         │
  │      ▼                                                    │
  │  provider.sample(uniquePoints)                            │
  │      │  BATCH: chunk into 100/256 per request             │
  │      ▼                                                    │
  │  retry loop (02): AT-LEAST-once send                      │
  └──────┼────────────────────────────────────────────────────┘
         │ ═══ NETWORK ═══
  ┌──────▼─────────────────────────────────────────────────────┐
  │  remote: PURE READ, idempotent → re-send harmless           │
  │  ⇒ caller observes EFFECTIVELY-once. no idempotency key.    │
  └──────────────────────────────────────────────────────────────┘

  (runtime: useTileGraph busyRef + covers() = REQUEST-level single-flight)
```

## Implementation in codebase

**Use cases.** Dedup + batch fire on every build that samples real elevation. Build-time uses `dedupePrecision: 0.0008` (`run-build.ts:37`); the phone uses `DEDUPE = 0.0008` (`useTileGraph.ts:34`) for the same reason. The dedup behavior is directly tested at `pipeline/elevation.test.ts:73-92`.

The de-duplication core:

```
  pipeline/elevation.ts  (lines 42–59, sampleElevations dedup branch)

  const keyOf = (lat, lng) => `${Math.round(lat/prec)},${Math.round(lng/prec)}`; ← cell key
  const repByKey = new Map();
  for (const id of ids) {
    const k = keyOf(n.lat, n.lng);
    if (!repByKey.has(k)) repByKey.set(k, { lat, lng });   ← keep ONE rep per cell
  }
  const elevs = await provider.sample([...rep points]);    ← query reps only
  ...
  out[id] = { ...n, elevationM: elevByKey.get(keyOf(...)) };← fan the answer back to all
       │
       └─ the Map IS the dedup: first node in a cell wins, rest reuse its elevation.
          Remove it and you'd issue one query per node — same answer, far more
          requests, guaranteed free-tier 429 on a real city.
```

The batching loop (idempotent reads, packed):

```
  pipeline/elevation.ts  (lines 100–124, openMeteoProvider.sample)

  for (let i = 0; i < points.length; i += OPEN_METEO_BATCH) {  ← chunk by 100
    const batch = points.slice(i, i + OPEN_METEO_BATCH);
    const url = `...?latitude=${lats}&longitude=${lngs}`;       ← all 100 in one URL
    ... fetch + retry ...
    if (delayMs && i + OPEN_METEO_BATCH < points.length)
      await sleep(delayMs);                                     ← throttle between batches
  }
       │
       └─ each request is keyed purely by its point list (idempotent). a retried
          batch re-reads the same elevations. the inter-batch sleep is the
          politeness that keeps at-least-once from becoming a flood.
```

## Elaborate

Idempotency keys exist precisely for the case flattr avoids: a *mutation* you might retry (Stripe's `Idempotency-Key` header on charge creation is the canonical example — it lets the server recognize "I've already processed this exact charge" and return the original result instead of charging twice). flattr needs none of that because it never mutates a remote. The lesson generalizes: **the cheapest way to handle duplicate delivery is to make the operation idempotent so duplicates don't matter** — far cheaper than building a dedup table keyed on request IDs.

The dedup-as-correctness insight (Part 2) is the non-obvious one. Sampling at sub-DEM resolution isn't just wasteful, it's *wrong* — it manufactures grade spikes at cell boundaries. Snapping to the cell grid is the same move as quantizing to your data's true resolution. That's a data-modeling instinct (`.aipe/study-data-modeling/`) doing double duty as a rate-limit defense.

What would force real delivery-semantics machinery: a server-side build farm (§11 E2) where a job queue delivers tile-build tasks at-least-once and a *write* (persisting the built tile) could be double-applied. Then you'd need an idempotency key on the persist, or an upsert keyed by tile bbox — see `06` and `08`.

## Interview defense

**Q: "Your retries can re-send a request that already succeeded. Isn't that a bug?"**
No — and that's the whole point. Every remote call I make is a pure read keyed by its inputs: streets-in-a-bbox, elevation-for-points, geocode-of-a-string. Re-sending re-reads the same answer with no side effect. So at-least-once delivery (which any retry gives you) collapses to effectively-once *observable* behavior, with zero machinery — no idempotency key, no dedup table. I get exactly-once semantics for free because I never made a remote call that mutates state.

```
   retry ──► at-least-once send ──► [idempotent read] ──► same answer
                                          │
                                          └─ no effect to double ⇒ no key needed
```
*Anchor: at-least-once + idempotent = effectively-once, for free.*

**Q: "Where do you de-duplicate, and why does it matter beyond performance?"**
Two places. Point-level: I snap elevation samples to one query per ~90m DEM cell — that's not just fewer requests, it's *correctness*, because sampling finer than the DEM creates fake grade spikes at cell steps. Request-level: at runtime `busyRef` + `covers()` skip a fetch I already have or one already in flight. The point-level dedup doing double duty as both a rate-limit defense and a correctness fix is the part I'd highlight. *Anchor: dedup to the data's true resolution — cheaper AND more correct.*

## Validate

1. **Reconstruct:** explain why flattr needs no idempotency key. What property of every remote call makes a blind retry safe?
2. **Explain:** in `pipeline/elevation.ts:42-59`, what is the cell key and why does collapsing to one query per cell improve *correctness*, not just cost?
3. **Apply:** a build samples 1,000 nodes that fall in 120 distinct 90m cells, batched 100/request. How many HTTP requests? (2 — 120 unique points, ceil(120/100).) Walk it through `sampleElevations` → `openMeteoProvider.sample`.
4. **Defend:** the spec adds server-side tile persistence (§11 E2) behind an at-least-once queue. Argue what new delivery-semantics machinery becomes mandatory and why none of it is needed today.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retries this file proves safe.
- `06-queues-streams-ordering-and-backpressure.md` — request-level single-flight dedup via `busyRef`.
- `04-consistency-models-and-staleness.md` — the stale-but-converging copies these reads produce.
- `.aipe/study-data-modeling/` — the DEM-resolution quantization as a modeling decision.
