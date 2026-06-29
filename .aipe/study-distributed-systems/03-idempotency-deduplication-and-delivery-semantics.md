# Idempotency, Deduplication & Delivery Semantics

**Industry name(s):** idempotency keys / at-least-once vs exactly-once / safe retries · *Industry standard*

## Zoom out, then zoom in

This concept *is* exercised — but as an absence you can justify, which is the more interesting version. flattr retries remote calls (see `02`), and retries normally raise a terrifying question: *what if the call actually succeeded and only the response got lost? Did I just do the thing twice?* flattr never has to answer that, and the reason is structural.

```
  Zoom out — where delivery semantics would live (and why they don't)

  ┌─ Coordination layer ─────────────────────────────────────────┐
  │  pump → fetchOverpass(bbox)   ─┐                              │
  │  pump → sample(points)        ─┤ ALL of these are pure READs  │ ← we are here
  │  UI   → geocode(query)        ─┘ keyed by geography           │
  │                                                               │
  │  ★ idempotency keys would live HERE — if any call WROTE ★     │
  │    none do → the slot is correctly empty                     │
  └────────────────────────┬──────────────────────────────────────┘
                           │ HTTP GET/POST, but semantically READ-ONLY
  ┌─ Provider layer ───────▼──────────────────────────────────────┐
  │  Overpass · Open-Meteo · Nominatim                           │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** Delivery semantics ask: when a message might be delivered zero, one, or many times, how many times does the *effect* happen? The three answers are at-most-once (might be lost), at-least-once (might duplicate), and exactly-once (the hard one). flattr gets exactly-once *effects* for free — not by building dedup, but because every call is a read with no effect to duplicate. Retrying a read twice and getting the same streets back isn't "doing it twice," it's just reading twice.

## Structure pass

**Layers.** Caller (pump/UI) → call (HTTP) → provider. Same three as always.

**The axis: `guarantees` — exactly-once *what*, and bought how?** This is the axis that exposes the whole concept. Trace it:

```
  The guarantees axis — "exactly-once" means different things

  what's guaranteed exactly-once?  │ how it's bought
  ─────────────────────────────────┼─────────────────────────────
  exactly-once DELIVERY            │ impossible (FLP / two generals)
  exactly-once PROCESSING          │ at-least-once delivery + dedup
  exactly-once EFFECT              │ idempotent operation (no dedup needed)
                                   │  ← flattr is HERE
```

**The seam.** The load-bearing boundary is *read vs write*. A read is naturally idempotent: GET the bbox `[-122.33, 47.61, ...]` once or five times, the answer and the world-state are identical. A write is not: "create one route record" run five times makes five records unless you stop it. flattr's boundary never flips from read to write — so the seam where idempotency keys become mandatory is never crossed. Naming that the boundary is read-only is the entire finding.

## How it works

### Move 1 — the mental model

You know this from HTTP itself: `GET` is safe and idempotent, `POST` usually isn't. Retrying a `GET /streets?bbox=...` is harmless; retrying a `POST /routes` might duplicate. flattr's calls are all in the first category — even the Overpass call, which is *technically* an HTTP POST, is *semantically* a GET (it sends a query in the body and reads back data; it changes nothing on the server).

```
  Idempotency = same key, same input → same effect, any # of times

  retry #1:  read(bbox=K) → streets(K)  ┐
  retry #2:  read(bbox=K) → streets(K)  ├─ effect happens 0 extra times
  retry #3:  read(bbox=K) → streets(K)  ┘   the KEY is the bbox itself

  contrast — a WRITE without an idempotency key:
  retry #1:  POST /route → record_A  ┐
  retry #2:  POST /route → record_B  ├─ effect happens 3 times = BUG
  retry #3:  POST /route → record_C  ┘   needs a client-supplied key to dedup
```

### Move 2 — the walkthrough

**Part 1 — the natural key is geography.** Look at what each call is keyed on. There's no `id` field generated, no nonce, no idempotency header — the key *is the input*:

```ts
// pipeline/overpass.ts:7-9 — the bbox IS the key
export function buildOverpassQuery(bbox: [number, number, number, number]): string {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const b = `${minLat},${minLng},${maxLat},${maxLng}`;   // deterministic from bbox
```

```ts
// pipeline/geocode.ts:14 — the query string IS the key
const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
```

Same query in → same result out. There's no server-side state that the second call could collide with, because flattr never writes server-side state. The retry loop in `overpass.ts:32` can fire three times against the same bbox and the worst case is three identical responses, of which it keeps one.

**Part 2 — the only dedup in the system is local and request-eliminating, not effect-deduping.** flattr *does* dedup — but it's a different kind. It dedups *which points it bothers to ask about*, not *how many times an effect fires*:

```ts
// mobile/src/useTileGraph.ts:42-51 — cache lookup splits hits from misses
points.forEach((pt, i) => {
  const hit = getElev(cellKey(pt.lat, pt.lng));   // already known?
  if (hit !== undefined) out[i] = hit;            // skip the network entirely
  else { missPts.push(pt); missIdx.push(i); }     // only misses get sampled
});
```

And in `elevation.ts:42-50`, the build-time dedup collapses many nodes in one ~90m DEM cell to a single sample. Both are *deduplication*, but of **requests**, not of **effects** — they exist to stay under the rate limit (a performance/backpressure concern, see `06`), not to make a non-idempotent operation safe. It's worth being precise about that distinction in an interview: flattr has request dedup, not delivery dedup, because it has no delivery effect to dedup.

**Part 3 — what flips this on.** The moment flattr writes anything across a boundary, the free ride ends:

```
  The trigger that introduces idempotency keys

  TODAY (read-only)              FUTURE (a write appears)
  ─────────────────             ────────────────────────────
  read(bbox) — safe to retry    POST /save-route — NOT safe to retry
                                 retry after a lost ACK → duplicate route
                                 FIX: client sends Idempotency-Key: <uuid>
                                      server dedups on that key (at-least-once
                                      delivery + dedup = exactly-once effect)

  concrete triggers in flattr's roadmap:
   • "save this route to my account"  (write to a backend)
   • "share route" / analytics events (write)
   • multi-device sync of saved routes (write + ordering)
```

### Move 2.5 — current vs future

```
  Phase A (now): read-only           Phase B: first write crosses the boundary
  ─────────────────────────          ───────────────────────────────────────
  retries safe by construction       retries can duplicate
  no idempotency key                 client-generated Idempotency-Key required
  no dedup table                     server dedup table keyed on that key
  exactly-once EFFECT (free)         exactly-once EFFECT (engineered)
```

The cost of Phase B isn't huge, but it's real: a key generated client-side *before* the first attempt (so all retries of one logical op share it), and a server-side store that remembers seen keys long enough to cover the retry window. flattr has none of that infrastructure, and correctly needs none — until a write appears.

### Move 3 — the principle

The strongest delivery-semantics design is the one that doesn't need a mechanism. "Exactly-once delivery" is provably impossible over an unreliable network (the two-generals problem); the industry workaround is always at-least-once delivery plus an idempotent operation or a dedup key. flattr lands on the easy side of that: by keeping the boundary read-only, every retry is automatically safe, and the hard problem never arises. Knowing *why* you don't need idempotency keys is a stronger signal than reflexively adding them.

## Primary diagram

```
  Delivery semantics in flattr — recap

  ┌─ Coordination layer ────────────────────────────────────────┐
  │  retry loop (from 02) fires call up to N times               │
  │     │                                                        │
  │     ▼   key = bbox / query / coord  (input == key)           │
  │  ┌──────────────────────────────────────────────┐           │
  │  │  request dedup (local):                       │           │
  │  │   • cache hit → no network (elevCache)        │  ← dedups │
  │  │   • DEM-cell collapse (elevation.ts)          │  REQUESTS │
  │  └──────────────────────────────────────────────┘           │
  └────────────────────────────┬─────────────────────────────────┘
            ════ HTTP boundary ╪═══════════════════
                              ▼
   ┌──────────────────────────────────────────────────┐
   │  Provider: pure READ, no server-side write         │
   │  → retry N times = identical effect = exactly-once │
   │  → NO idempotency key needed (slot correctly empty)│
   └──────────────────────────────────────────────────┘
```

## Elaborate

The canonical idempotency-key design is Stripe's: the client generates a key per logical operation, sends it on every retry, and the server stores `(key → result)` so a replayed request returns the original result instead of re-charging the card. The whole apparatus exists because payments are writes you absolutely cannot duplicate. flattr's reads are the opposite end of the spectrum. The interesting middle ground — at-least-once message processing with a dedup window — shows up the moment you add a queue (`06`) carrying *commands* rather than today's read requests. Sibling `study-database-systems` covers the storage side of a dedup table; `study-system-design` covers where the key gets generated in a request flow.

## Interview defense

**Q: "Your code retries network calls. How do you prevent duplicate side effects?"**
Verdict first: there are none to prevent.

```
  read-only boundary → retry is free

  call(K) ──retry──► call(K) ──retry──► call(K)
     same K, same result, ZERO side effects
  no Idempotency-Key because no write to dedup
```

"Every cross-boundary call is a pure read keyed by geography — a bbox, a query string, a coordinate. The input *is* the idempotency key. Retrying a read returns the same streets or the same elevation and changes nothing on the provider, so the effect is exactly-once for free. I deliberately didn't add idempotency keys or a dedup table because there's no write to make safe. The moment I add 'save route to account,' that changes — I'd generate a client-side key before the first attempt, share it across retries, and dedup on it server-side, turning at-least-once delivery into exactly-once effect."

**Anchor:** *The input is the key — reads are idempotent by construction, so the dedup slot is correctly empty.*

**Q: "But you do have deduplication in the code — isn't that the same thing?"**
"Different axis. The cache and the DEM-cell collapse dedup *requests* to stay under the rate limit — a performance concern. Delivery dedup would dedup *effects* to make a write safe — a correctness concern. I have the first, not the second, because I have no write effects."

**Anchor:** *Request dedup ≠ delivery dedup — one saves quota, the other saves correctness.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retries that make this question arise.
- `04-consistency-models-and-staleness.md` — the cache's *staleness* story (this file is its *safety* story).
- `06-queues-streams-ordering-and-backpressure.md` — where at-least-once delivery would appear (queues).
- `08-sagas-outbox-and-cross-boundary-workflows.md` — multi-step writes where idempotency compounds.
