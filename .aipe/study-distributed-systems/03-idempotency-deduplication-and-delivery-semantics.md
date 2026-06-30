# 03 — Idempotency, Deduplication, and Delivery Semantics

**Industry names:** idempotency keys / at-least-once vs at-most-once vs
exactly-once / deduplication / safe retries. **Type:** Industry standard.

## Zoom out, then zoom in

`02` told you flattr retries failed calls. That should make you nervous: if you
retry a call that already half-succeeded, do you do the work *twice*? Charge the
card twice, send the email twice, insert the row twice? Delivery semantics is the
field that answers "how many times did this actually happen?" — and the punchline
for flattr is that the question dissolves, because of one structural fact.

```
  Zoom out — why the "how many times?" question doesn't bite flattr

  ┌─ Client / Build (you own) ────────────────────────────────────┐
  │  fetchOverpass(bbox)     openMeteoProvider.sample(points)      │
  │  geocode(query)          reverseGeocode(lat,lng)               │
  │       every one is a PURE READ keyed by geography  ★           │ ← we are here
  └───────────────────────────┬───────────────────────────────────┘
                              │  HTTP — retried freely (02)
                              ▼
  ┌─ Third-party fleet ───────────────────────────────────────────┐
  │  GET streets-in-bbox · GET heights-at-points · GET geocode     │
  │  no state changes on their side — same input, same output      │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **idempotency** — an operation you can apply twice and
the second application changes nothing. flattr doesn't *achieve* idempotency with
machinery (no idempotency keys, no dedup tables); it gets it **for free by
construction**, because every remote call is a read keyed by a bbox or
coordinate. Run it once, run it five times — same streets, same elevations, same
geocode. Retry safety is a property of the *shape* of the calls, not a feature
anyone wrote.

## The structure pass

**Layers.** Two: the *remote* operations (the HTTP reads to third parties) and
the *local* writes (the elevation cache write in `elevCache.ts`, the React state
sets in `useTileGraph.ts`). Delivery semantics asks a different question of each.

**Axis — trace `what does a duplicate cost?` across the two layers.**

```
  One axis — "if this runs twice, what breaks?" — across the layers

  ┌─ remote reads (Overpass/Open-Meteo/Nominatim) ─┐
  │ run twice → identical response, zero side       │  → duplicate is FREE
  │ effect on the server                            │     (pure GET, no write)
  └───────────────────────┬─────────────────────────┘
                          │  the answer changes ↓
  ┌─ local writes (elevCache.putElev, setState) ───┐
  │ run twice → must not corrupt the cache or       │  → duplicate is GUARDED
  │ double-paint; guarded by has()-check + only-    │     (idempotent by check,
  │ real-values-cached                              │      not by luck)
  └─────────────────────────────────────────────────┘
```

The answer flips: remote duplicates are free because there's no remote write to
duplicate; local duplicates *could* corrupt state, so they're explicitly guarded.
That flip is the whole content of this file — flattr's idempotency is "free on the
read side, deliberately guarded on the write side."

**Seam.** The load-bearing seam is the cache write in `cachedElevation`
(`useTileGraph.ts:52-58`): it's where a retried remote read turns into a *local*
write, and where "only cache successfully-fetched values" prevents a degraded
(flat 0 m) build from poisoning the cache with fake elevations. That one rule —
cache only real values — is flattr's entire dedup correctness story.

## How it works

### Move 1 — the mental model: the three delivery semantics

Every message-delivery system lands in one of three buckets, defined by what
happens under failure-and-retry:

```
  The pattern — three delivery semantics, by what a retry does

  at-most-once   send, never retry         → may LOSE the message
                 │                            (0 or 1 deliveries)
  at-least-once  send, retry until ack      → may DUPLICATE the message
                 │                            (1 or many deliveries)
  exactly-once   at-least-once + dedup      → 1 delivery, effectively
                 (retry) + idempotency        (the expensive one)
                 (collapse the dupes)
```

The trick the industry actually uses: **true exactly-once delivery is impossible**
across an unreliable network (you can't tell "my request was lost" apart from "the
ack was lost"). So you build **at-least-once delivery + idempotent processing =
effectively-once** *effect*. You accept duplicate *delivery* and make duplicate
*processing* a no-op. Idempotency is the half that makes at-least-once safe.

flattr's retries (`02`) are at-least-once by nature — they re-send until success.
What makes that safe is that the "processing" on the remote side is a pure read:
applying it twice is already a no-op. flattr is in the happy corner where you get
effectively-once *for free* because the operations were idempotent to begin with.

### Move 2 — walk why flattr needs zero idempotency machinery

**Part 1 — every remote call is a read keyed by its inputs.** Look at the four
remote operations and notice none of them mutates anything on the far side:

```
  the four remote ops — all pure reads, keyed by geography

  fetchOverpass(bbox)            → ways in that bbox        (overpass.ts:21)
  openMeteoProvider.sample(pts)  → heights at those points  (elevation.ts:100)
  geocode(query)                 → coord for that string    (geocode.ts:9)
  reverseGeocode(lat,lng)        → label for that coord      (geocode.ts:58)

  key = the geographic input. same key → same answer, forever.
  retrying = asking the same question again = no side effect.
```

This is why you'll find **no idempotency key, no request ID, no dedup table**
anywhere in flattr — grep for them and they don't exist, *and that's correct*. An
idempotency key exists to let a server recognize "I've seen this exact write
before, don't apply it again." flattr issues no writes to those servers, so
there's nothing for a key to protect. Adding one would be cargo-culting.

**Part 2 — the bbox/coord IS the natural idempotency key.** The thing that makes
a retry recognizable as "the same operation" is that flattr keys every call by
geography, and geography is stable. `fetchOverpass([w,s,e,n])` with the same bbox
builds the identical Overpass QL (`overpass.ts:7-15`) → identical query →
identical result. You didn't *invent* an idempotency key; the bbox already is one.

**Part 3 — the local write IS guarded, because duplicates there aren't free.**
The one place a duplicate could do damage is the elevation cache write. Read the
guard:

```
  elevCache.ts:35-40 — putElev is idempotent by an explicit has()-check

  export function putElev(key: string, value: number): void {
    if (mem.has(key)) return        // ← already cached → no-op (idempotent write)
    mem.set(key, value)
    dirty = true
    if (!persistTimer) persistTimer = setTimeout(persistNow, …)
  }
```

Writing the same cell twice is a no-op (`:36`) — so a retried build that
re-samples the same DEM cell can't corrupt the cache or thrash the persist timer.
And the comment at `elevCache.ts:4` pins the deeper reason this cache can be
this simple: *"DEM samples never change, so cached values are valid forever."*
The elevation of a point on Earth is immutable — there's no invalidation problem,
no staleness, no version. (Contrast the *graph* itself, which is mutable upstream
in OSM — that's `04`'s problem, not this one.)

**Part 4 — the dedup that prevents poisoning: only cache REAL values.** Here's
the subtle correctness rule. When elevation fails, `bestEffortElevation` returns
flat `0`s (`useTileGraph.ts:24-30`) — but those fake zeros must *never* enter the
cache, or every future read of that cell returns a lie forever.

```
  useTileGraph.ts:52-58 — caching writes ONLY successful fetches

  if (missPts.length) {
    const got = await p.sample(missPts)   // ← if this THROWS (throttled), we never
    got.forEach((e, j) => {               //   reach the cache writes below…
      out[missIdx[j]] = e
      putElev(cellKey(...), e)            //   …so only real fetched values are cached
    })
  }
  // the throw propagates UP to bestEffortElevation, which returns flat 0s
  // WITHOUT having cached them. (comment: "Only real … values are cached", :35)
```

The ordering is load-bearing: the flat-0 fallback wraps the cache
(`bestEffortElevation(cachedElevation(...))`, `:190-195`), so the fallback only
fires *after* the cache layer has already thrown — meaning the zeros are produced
*outside* the cache and never written. Invert that wrapping and you'd poison the
cache with permanent zeros. This is dedup correctness: dedup is only safe if every
deduplicated value is one you'd be happy to serve forever.

### Move 2.5 — current vs future: when idempotency keys become real

flattr is in Phase A; here's what flips it to Phase B.

```
  Phase A (now)              vs   Phase B (the day flattr grows a write)
  ─────────────────              ──────────────────────────────────────
  all remote ops are READs        a user POSTs "save this route" / "rate it"
  retry = re-ask, no effect       retry = risk a DOUBLE save / double charge
  no idempotency key needed       MUST send a client-generated idempotency
  bbox/coord = natural key        key; server dedups on it
  cache guard = has()-check       server stores (key → result) to make the
                                  retried write a no-op

  what does NOT change: the read paths stay key-free and safe.
  Only the new WRITE path needs the machinery. That's the migration cost.
```

The trigger from `00`: a multi-user service where users *write* (save routes,
ratings, reports). The instant a retryable call has a side effect, "free
idempotency" ends and you build the real thing — an idempotency key the client
generates and the server dedups on.

### Move 3 — the principle

Idempotency isn't a feature you bolt on; it's a property of an operation's shape.
If you can arrange your operations to be reads, or to be writes that carry a
stable key, retries become safe and the impossible "exactly-once delivery"
problem collapses into the tractable "at-least-once delivery + idempotent
processing." **flattr's whole retry strategy (`02`) is only correct because the
operations were idempotent first — the safest distributed system is the one whose
operations don't care how many times you run them.**

## Primary diagram

The full picture: free idempotency on the read side, guarded idempotency on the
write side, and the poisoning the ordering prevents.

```
  flattr — idempotency, free on reads, guarded on the one local write

  ┌─ remote (you don't own) — IDEMPOTENT FOR FREE ────────────────┐
  │  fetchOverpass(bbox) · sample(pts) · geocode(q)               │
  │  pure reads, keyed by geography → retry = no-op (02 safe)     │
  └───────────────────────┬───────────────────────────────────────┘
                          │  successful value
                          ▼
  ┌─ local cache write — IDEMPOTENT BY GUARD ─────────────────────┐
  │  putElev: if has(key) return   (elevCache.ts:36)              │
  │  only REAL fetched values reach here (useTileGraph.ts:52-58)  │
  │  ╳ flat-0 fallback is produced OUTSIDE → never cached         │
  └────────────────────────────────────────────────────────────────┘
       no idempotency keys anywhere — and that's correct,
       because there is no remote WRITE for a key to protect.
```

## Elaborate

"Exactly-once is impossible; effectively-once is the goal" is one of the most
load-bearing facts in distributed systems — it's why Kafka, SQS, and every
payment processor talk about at-least-once delivery plus consumer-side dedup
rather than promising true exactly-once. The standard machinery is the
**idempotency key**: Stripe's API is the canonical example — you send
`Idempotency-Key: <uuid>`, and a retry with the same key returns the *first*
result instead of charging again. flattr needs none of it today because geography
is its natural key and reads have no side effect. The day it grows a write path,
the move is exactly Stripe's: client-generated key, server-side
`(key → result)` store, retry returns the stored result.

## Interview defense

**Q: "You retry these API calls. Aren't you worried about duplicate effects?"**
Verdict first: "No, because every call is a pure read keyed by geography — same
bbox in, same streets out, no server-side state changes — so a retry is just
asking the same question again. There's nothing to duplicate." Then show you know
where it ends: "The moment we add a write — save a route — that changes; we'd send
a client-generated idempotency key and have the server dedup on it, because then a
retry could double-apply." Naming both the free case *and* its boundary is the
signal.

```
  the sketch you draw

  READ  (now):   retry ─► same question ─► same answer   ✓ free
  WRITE (later): retry ─► same effect TWICE  ✗ ─► needs idempotency key
                          └─ key lets server collapse the dupe
```

**Q: "Is exactly-once delivery achievable here?"**
"Exactly-once *delivery* is impossible over an unreliable network — you can't
distinguish a lost request from a lost ack. What you build is at-least-once
delivery plus idempotent processing, which gives effectively-once *effect*.
flattr already has the idempotent-processing half for free (reads), so its
at-least-once retries are safe." That reframe — delivery vs effect — is the thing
interviewers are listening for.

**Anchor:** *Every remote call is a pure read keyed by a bbox or coordinate, so
retries are no-ops by construction — idempotency by shape, not by machinery.*

## See also

- `02` — the retries this file makes safe.
- `04` — the immutability of DEM heights (why the cache never invalidates) vs the
  mutability of the graph (why it goes stale).
- `08` — sagas/outbox: the write-path coordination flattr will need the day Phase
  B lands.
- sibling **database-systems** — the storage-engine view of the cache write.
