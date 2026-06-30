# 06 — Queues, Streams, Ordering, and Backpressure

**Industry names:** message queues / streams / consumer groups / ordering
guarantees / poison messages / backpressure. **Type:** Industry standard.

## Zoom out, then zoom in

You know how `Promise.all([...])` fires every request at once and a server with a
rate limit hates you for it? Backpressure is the discipline of *not doing that* —
of letting the slow side push back on the fast side so work flows at the rate the
slow side can handle. flattr has no queue infrastructure (no Kafka, no SQS, no
Redis Streams — `not yet exercised`), but it has the *single most important
backpressure primitive*, hand-rolled, in the tile loader.

```
  Zoom out — flattr's one backpressure mechanism

  ┌─ Client (you own) ────────────────────────────────────────────┐
  │  user pans / routes  →  queue requests  →  ★ single-flight ★   │ ← we are here
  │                          (refs, not a                pump      │
  │                           real queue)                          │
  └───────────────────────┬───────────────────────────────────────┘
                          │  ONE build at a time → 1 burst of HTTP
                          ▼
  ┌─ Third-party fleet (rate-limited) ────────────────────────────┐
  │  Overpass / Open-Meteo — would 429 under parallel fan-out     │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **backpressure via single-flight + a priority slot**. The
`pump()` in `useTileGraph.ts` runs exactly one graph build at a time, with the
route corridor jumping ahead of viewport pans. That one rule is what keeps flattr
under the free-tier rate limits — it's backpressure without a message broker.

## The structure pass

**Layers.** Two: the *producers* (user actions — panning fires `queueViewport`,
routing fires `ensureBbox`) and the *consumer* (the single `pump` that drains one
request at a time). Between them sit two "queue slots" that are really just refs:
`pendingViewRef` and `pendingCorridorRef`.

**Axis — trace `what limits the rate of outbound HTTP?` across the layers.**

```
  One axis — "what caps how fast we hit the API?" — across the layers

  ┌─ producers (pan / route) ───────────┐
  │ rate = as fast as the user moves     │  → unbounded, bursty
  └──────────────────┬───────────────────┘
                     │  the answer flips here ↓ (the backpressure seam)
  ┌─ debounce + single-flight pump ─────┐
  │ rate = 1 build at a time, debounced  │  → bounded to what the API tolerates
  │ 600ms; corridor preempts view        │
  └──────────────────┬───────────────────┘
                     │  stays bounded ↓
  ┌─ outbound HTTP ──▼───────────────────┐
  │ rate = 1 burst per build, paced       │  → under the free-tier limit
  │ (elevation: 300-400ms between batches)│
  └───────────────────────────────────────┘
```

The flip at the pump is the backpressure: a fast, bursty producer meets a single
consumer slot, and the slot forces the producer's rate down to what the API can
take. That's the entire mechanism — and it's the same shape as a bounded queue
with one worker.

**Seam.** The load-bearing seam is `busyRef` (`useTileGraph.ts:113`): the boolean
that says "a build is in flight, don't start another." It's a one-slot semaphore.
Backpressure lives in that single boolean.

## How it works

### Move 1 — the mental model: a bounded queue with one worker

Backpressure's kernel is a **bounded buffer** between a fast producer and a slow
consumer: when the buffer is full, the producer is forced to wait (or its older
items are dropped) instead of overwhelming the consumer. flattr's version shrinks
the buffer to **one slot per kind** and the worker pool to **one** — the simplest
backpressure that still works.

```
  The pattern — single-flight pump (one worker, two one-slot lanes)

  producers                  slots (refs)            one worker
  ┌──────────┐  pan         ┌──────────────┐
  │ queueView│ ───────────► │ pendingView  │──┐
  └──────────┘              └──────────────┘  │   ┌────────────┐
  ┌──────────┐  route       ┌──────────────┐  ├──►│   pump()   │──► HTTP burst
  │ ensureBbox│ ──────────► │ pendingCorrid│──┘   │ busyRef=1  │
  └──────────┘              └──────────────┘      └─────┬──────┘
                            corridor drained FIRST       │ on finish:
                            (priority)                    └─ pump() again
                                                             (drain next)
  busyRef gates the worker: if busy, a new request just
  overwrites the pending slot — newest-wins, no unbounded backlog.
```

The kernel parts, named by what breaks without each:

- **the busy flag (`busyRef`)** — drop it and every pan fires a concurrent build →
  parallel HTTP fan-out → instant 429s. This is the load-bearing part.
- **the one-slot-per-kind buffer (the pending refs)** — drop the overwrite
  semantics and you'd queue *every* pan, building stale viewports the user already
  scrolled past. Overwrite = newest-wins = implicit drop of stale work.
- **the priority (corridor before view)** — drop it and a user waiting on a route
  gets starved behind viewport pans.
- **the self-pump on finish** — drop the `pump()` in `finally` and the queue
  stalls: a request sits in its slot forever because nothing drains it.

### Move 2 — walk the pump

**The busy gate — one build at a time.** `pump` returns immediately if a build is
already running (`useTileGraph.ts:167`):

```
  useTileGraph.ts:166-182 — the gate + priority drain, annotated

  const pump = useCallback(() => {
    if (busyRef.current) return          // ← THE backpressure gate: already building? stop.
    let kind; let req;
    if (pendingCorridorRef.current) {     // corridor (a pending ROUTE) drains FIRST…
      kind = "corridor"; req = pendingCorridorRef.current
      pendingCorridorRef.current = null
    } else if (pendingViewRef.current) {  // …then viewport pans
      kind = "view"; req = pendingViewRef.current
      pendingViewRef.current = null
    } else return                         // nothing queued → idle
    busyRef.current = true                // claim the single slot
    …
```

Read line 167: that one guard is why flattr never fires two graph builds in
parallel, which is why it never fans out parallel Overpass + Open-Meteo bursts,
which is why it stays under the rate limit. The comment at `:164-165` says it
outright: "One graph build at a time. The route corridor takes priority over the
viewport so a pending route isn't starved by panning."

**The self-pump — drain the next on finish.** The `finally` block re-invokes pump
(`useTileGraph.ts:221-225`):

```
  useTileGraph.ts:221-226 — the drain, annotated

  } finally {
    busyRef.current = false   // release the slot
    if (!silent) setLoadingStep(null)
    pump()                    // ← drain the NEXT pending request (corridor first)
  }
```

This is the queue's heartbeat: each finished build pulls the next from a pending
slot. Without it the system processes one request and freezes. Note the failure
interaction with `02`'s missing-timeout gap: because there's exactly one worker, a
*single* hung Overpass call (no timeout) holds `busyRef` true forever and freezes
*all* tile loading. The single-flight design that gives you backpressure also
concentrates the blast radius of a hung call — which is exactly why the timeout
fix in `02`/`09` is high-value here.

**Debounce — pace the producer, too.** Upstream of the pump, viewport changes are
debounced 600ms (`useTileGraph.ts:64,254-255`) so a continuous pan doesn't fire a
request per frame. Debounce throttles the producer; single-flight throttles the
consumer. Two backpressure tools at two altitudes.

**Ordering — newest-wins, not FIFO, and that's deliberate.** A real queue
preserves order; flattr's pending slot *overwrites* (`:213-215`, `:239`, `:275`).
For viewport tiles that's correct: if you panned three times while a build ran,
you only want the *latest* viewport, not all three. Overwrite-newest is an
ordering choice — drop intermediate work — that fits the domain. Where ordering
*would* matter (a stream of events that must be processed in sequence) flattr has
no such stream, so it doesn't pay for FIFO.

### Move 2.5 — current vs future: real queues

```
  Phase A (now)                vs   Phase B (the trigger)
  ─────────────────                ──────────────────────
  single-flight pump, in-memory     a backend processes async work for many users
  refs, newest-wins                 ↓
  no durability (refs die with app) durable queue (SQS/Kafka): work survives a
  no consumer group (1 worker)      crash → at-least-once delivery (→ 03 idempotency)
  no poison-message handling        consumer group: N workers drain in parallel
  no ordering guarantee             poison message: a request that always fails
                                    needs a dead-letter queue or it blocks the lane
                                    forever (today: a failed build just keeps last
                                    data, :219 — no DLQ because no durable queue)

  the pump IS a queue-with-one-worker; the missing parts are
  durability, parallelism, and poison-message handling.
```

The trigger from `00`: background route jobs or a push pipeline — any async work
handed to a backend. The day work must survive a crash or fan out across workers,
the in-memory pump becomes a real durable queue, and you inherit poison messages
(a request that fails forever and blocks its lane — needs a dead-letter queue) and
ordering guarantees you currently get to ignore.

### Move 3 — the principle

Backpressure is the slow side's right to say "not so fast" — and you don't need a
message broker to have it. A single busy flag + a one-slot buffer + drain-on-finish
is a complete bounded queue with one worker, and that's exactly what flattr uses to
stay under a free-tier rate limit. **The instant a fast producer can outrun a slow
consumer, you owe the consumer backpressure; the only question is whether the buffer
lives in a ref (flattr) or in Kafka (a backend) — the shape is identical.**

## Primary diagram

The full picture: two producers, two one-slot lanes, one worker, the busy gate,
the drain.

```
  flattr — single-flight pump as a bounded queue with one worker

  ┌─ producers (UI) ────────────────────────────────────────────┐
  │  pan ─debounce 600ms─► queueViewport     route ─► ensureBbox │
  └───────────┬───────────────────────────────────┬─────────────┘
              │ overwrite (newest-wins)            │ overwrite
              ▼                                     ▼
       ┌─ pendingViewRef ─┐              ┌─ pendingCorridorRef ─┐
       └────────┬─────────┘              └──────────┬───────────┘
                │   corridor drains FIRST (priority) │
                └──────────────┬─────────────────────┘
                               ▼
                    ┌─ pump() — ONE worker ─┐
                    │ busyRef gate (:167)   │  ← backpressure lives here
                    │ build → HTTP burst    │  ← ⚠ a hung call (no timeout, 02)
                    │ finally: pump() again │     freezes this one worker = all loading
                    └───────────────────────┘
```

## Elaborate

Backpressure is the load-bearing idea behind every streaming system — TCP flow
control, RxJS, Reactive Streams, Kafka consumer lag — all answer "how does a slow
consumer stop a fast producer from drowning it?" flattr's single-flight pump is the
minimal in-process version; the same shape scales up to a Kafka consumer group
where the broker holds the buffer and lag is the backpressure signal. The concepts
flattr *doesn't* exercise — durable delivery, poison messages / dead-letter queues,
ordering guarantees, consumer groups — all arrive together the moment the queue
moves out of process memory and into infrastructure, because durability is what
makes at-least-once delivery (and therefore the idempotency machinery of `03`)
necessary. Learn the backpressure atom here; the broker is the same atom with
durability and parallelism bolted on.

## Interview defense

**Q: "How does this app avoid hammering the rate-limited APIs?"**
Verdict first: "A hand-rolled single-flight pump — exactly one graph build runs at
a time, gated by a `busyRef` boolean, with the route corridor preempting viewport
pans. Producers are debounced 600ms on top. So a fast, bursty user meets a
one-slot consumer that paces outbound HTTP to what the free tier tolerates — it's
backpressure without a message broker." Then the sharp edge: "The same single
worker means one hung call with no timeout freezes all loading — which is why the
client-side timeout is the highest-value fix." Connecting backpressure to the
blast-radius cost is the senior signal.

```
  the sketch you draw

  fast producer ──► [ busyRef: 1 slot ] ──► one worker ──► paced HTTP
                         │                                  (under rate limit)
                    backpressure
```

**Q: "What's the one part of this pump people forget?"**
"The `pump()` in the `finally` block — the self-drain. Without it the queue
processes one request and freezes, because nothing pulls the next from the pending
slot. It's the queue's heartbeat." Naming the drain (the part that's easy to leave
out) proves you've built one.

**Anchor:** *A busy flag plus a one-slot buffer plus drain-on-finish is a complete
bounded queue with one worker — backpressure without a broker — and the single
worker is also why a hung call freezes everything.*

## See also

- `02` — the missing timeout that makes a hung call freeze this single worker.
- `03` — durability (Phase B) is what forces at-least-once + idempotency.
- `04` — the self-heal retries are paced through this same pump so convergence
  doesn't storm the API.
- `09` — the single-worker blast radius ranked.
- sibling **performance-engineering** — debounce/batch/dedup as throughput;
  sibling **runtime-systems** — the pump as bounded async work.
