# Queues, Streams, Ordering & Backpressure

**Mixed status.** Real distributed *queues/streams* (Kafka, SQS, Redis Streams) are **`not yet exercised`** — flattr has no message broker, no consumers, no partitions to order. But the *backpressure* half of this concept **is exercised**, as a client-side single-flight pump in `useTileGraph.ts`. This file teaches the pump as the real thing it is, then names the trigger for actual queues.

## Zoom out, then zoom in

```
  Zoom out — where the pump (backpressure) lives

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  MapScreen: pan/route events fire FASTER than builds finish  │
  └────────────────────────┬─────────────────────────────────────┘
                           │ events
  ┌─ Coordination layer ───▼─────────────────────────────────────┐
  │  pump() — ★ single-flight backpressure HERE ★                 │ ← we are here
  │   busyRef (1 in-flight) + debounce + corridor-priority        │
  │   (broker / stream slot: EMPTY — no Kafka/SQS)                │
  └────────────────────────┬─────────────────────────────────────┘
                           │ ONE build at a time → throttled provider calls
  ┌─ Provider layer ───────▼─────────────────────────────────────┐
  │  Overpass · Open-Meteo (free tier — rate-limited)            │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** Backpressure is what a system does when work arrives faster than it can process it: shed it, buffer it, or slow the producer. A queue is the buffer-it answer at scale, with ordering and consumer semantics. flattr's producer is the user (panning generates region-change events constantly); its consumer is the graph builder (each build is a slow chain of Overpass + elevation calls). The pump is the throttle that keeps the fast producer from overwhelming the slow, rate-limited consumer.

## Structure pass

**Layers.** Event producer (UI pans/routes) → pump (the throttle) → provider (the rate-limited sink).

**The axis: `control` — who decides when the next unit of work runs?**

```
  The control axis — who gates the next build?

  ┌─ UI (producer) ─────────────┐  fires events freely (every pan frame)
  │  onRegionDidChange          │  → CONTROL: producer, unbounded
  └──────────────┬───────────────┘
  ┌─ pump (the gate) ▼──────────┐  decides: run now? queue? drop?
  │  busyRef + debounce +        │  → CONTROL: the gate (concurrency = 1)
  │  priority + coverage check   │
  └──────────────┬───────────────┘
  ┌─ provider (sink) ▼──────────┐  processes one build's calls at a time
  │  Overpass / Open-Meteo       │  → CONTROL: sink sets the real ceiling
  └──────────────────────────────┘  (rate limit)
```

**The seam.** It's `busyRef` (`useTileGraph.ts:113`). Above it, control belongs to the producer (events fire whenever). Below it, control belongs to the gate (only one build proceeds; the rest wait or get coalesced). That boolean *is* the backpressure mechanism — a concurrency limiter of size 1.

## How it works

### Move 1 — the mental model

You know this from debouncing a search box: keystrokes fire faster than you want to hit the API, so you wait for a pause and fire once. The pump is debounce *plus* a concurrency limit of 1 *plus* a priority rule. It's a degenerate queue — a queue that holds at most one pending item per kind.

```
  The backpressure kernel — single-flight with priority

  ┌──────────────────────────────────────────────────────────┐
  │  if busy: return                  ← concurrency limit = 1  │
  │  pick next: corridor BEFORE view  ← priority (route wins)  │
  │  busy = true                                               │
  │  run build (slow)                                          │
  │  on finish: busy = false; pump()  ← drain the next         │
  └──────────────────────────────────────────────────────────┘
  pending slots hold only the LATEST request per kind (coalescing)
```

Name each part by what breaks: drop the busy check and N concurrent builds hammer the rate-limited API → throttle storm. Drop the priority and a route waits behind viewport pans → user's route stalls. Drop the drain (`pump()` in finally) and pending work never runs → the system stalls after one build.

### Move 2 — the walkthrough

**Part 1 — the concurrency-1 gate.** The whole pump opens with the gate:

```ts
// mobile/src/useTileGraph.ts:166-180
const pump = useCallback(() => {
  if (busyRef.current) return;            // GATE: one build in flight, full stop
  let kind: "corridor" | "view";
  let req: { bbox: Bbox; silent: boolean };
  if (pendingCorridorRef.current) {       // PRIORITY: corridor (a route) first
    kind = "corridor"; req = pendingCorridorRef.current;
    pendingCorridorRef.current = null;
  } else if (pendingViewRef.current) {    // then viewport
    kind = "view"; req = pendingViewRef.current;
    pendingViewRef.current = null;
  } else { return; }                      // nothing pending → idle
```

The comment at `:164-165` states the intent: *"One graph build at a time. The route corridor takes priority over the viewport so a pending route isn't starved by panning."* This is starvation-avoidance — a classic queue-scheduling concern, here done with two priority slots instead of a priority queue (which, per `me.md`, Rein has hand-built in `PriorityQueue.ts` — same idea, two-element version).

**Part 2 — coalescing: the pending slot holds only the latest.** Each pending ref is a *single* slot, not a list:

```ts
// mobile/src/useTileGraph.ts:116-117
const pendingViewRef = useRef<{ bbox: Bbox; silent: boolean } | null>(null);
const pendingCorridorRef = useRef<{ bbox: Bbox; silent: boolean } | null>(null);
```

When you pan three times while a build runs, the second and third overwrite the first pending viewport — only the newest survives. That's deliberate load-shedding: there's no point building the viewport you panned *through*; you only want where you landed. A real queue would buffer all three; the pump drops the stale ones. **Coalescing is backpressure by discarding obsolete work** — the right move when only the latest state matters.

```
  Coalescing — three pans, one build

  pan A ─► pending = A
  pan B ─► pending = B   (A dropped — never built)
  pan C ─► pending = C   (B dropped)
  build finishes ─► pump() ─► builds C only
```

**Part 3 — the debounce in front.** Region-change events fire every frame during a pan; the debounce waits for the pan to stop:

```ts
// mobile/src/useTileGraph.ts:254-255
if (timerRef.current) clearTimeout(timerRef.current);
timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS);  // 600ms
```

So there are *two* throttles stacked: debounce (don't even queue until the pan settles) then single-flight (don't run two builds at once). Belt and suspenders, both aimed at the same enemy — the free-tier rate limit.

**Part 4 — the drain.** The `finally` block re-pumps so pending work isn't stranded:

```ts
// mobile/src/useTileGraph.ts:221-225
} finally {
  busyRef.current = false;       // release the gate
  if (!silent) setLoadingStep(null);
  pump();                        // drain: if something's pending, run it now (corridor first)
}
```

This is the part people forget — the consumer must pull the next item when it finishes, or the queue stalls with work sitting in it. The recursive `pump()` in `finally` is the "dequeue next on completion" of a normal consumer loop, collapsed to a single in-flight slot.

### Move 2.5 — current vs future (where real queues appear)

```
  Phase A (now): client-side single-flight     Phase B: real broker
  ─────────────────────────────────────        ────────────────────
  pending = 1 latest per kind (coalesced)       durable queue (SQS/Kafka)
  ordering: corridor > view (2 priorities)      partition-ordered streams
  failure: try/catch keeps last region          poison-message / DLQ handling
  no durability (lost on app kill)              at-least-once + dedup (→ 03)
  producer = user; consumer = same process      decoupled producers/consumers

  TRIGGER for a real queue: build-graph moves SERVER-SIDE as a job
   (precompute many cities' graphs, or process user-submitted regions)
   → now you need durability, multiple workers, ordering, poison handling
```

The honest note: ordering and poison-message handling — core to real streams — are `not yet exercised`. The pump has a trivial 2-level ordering and no concept of a poison message (a failed build just keeps the last region and a pan retries). Those become real only when builds are durable jobs processed by multiple workers off a broker.

### Move 3 — the principle

Backpressure is non-negotiable whenever a producer can outrun a consumer; the only question is *how* — shed, buffer, or slow the producer. flattr sheds (coalesce to latest) and slows (debounce) and limits (single-flight), all without a broker, because the work is "rebuild the current view" where only the latest request matters and durability doesn't. A real queue is the same idea with durability, multiple consumers, and ordering bolted on — reach for it when work must survive a crash or scale across workers, not before.

## Primary diagram

```
  Backpressure pump — full recap

  ┌─ UI (producer, unbounded) ──────────────────────────────────┐
  │  pan/route events ──► debounce (600ms) ──► queueViewport /    │
  │                                            ensureBbox         │
  └────────────────────────┬─────────────────────────────────────┘
                           │ writes ONE pending slot per kind (coalesce)
  ┌─ pump (gate, concurrency = 1) ▼──────────────────────────────┐
  │  busyRef? ─yes─► return (shed)                                │
  │           ─no──► pick corridor>view ─► build ─► on finish:    │
  │                                          release + pump()      │
  │                                          (drain next)          │
  └────────────────────────┬─────────────────────────────────────┘
                           │ at most ONE concurrent build's calls
  ┌─ Provider (sink, rate-limited) ▼─────────────────────────────┐
  │  Overpass + Open-Meteo (free tier)                           │
  └───────────────────────────────────────────────────────────────┘
   not yet exercised: durable broker · partition ordering · poison/DLQ
```

## Elaborate

The single-flight pattern (collapse concurrent identical work to one in-flight operation) is named in Go's `singleflight` package and is everywhere in well-built clients. Coalescing-to-latest is the same idea SwiftUI/React rendering use — only the latest state matters, intermediate states are dropped. Real distributed queues add the parts flattr skips: durability (survive a crash), partitioning for ordered parallelism (Kafka), and poison-message handling / dead-letter queues (a message that always fails must not block the rest). Those come from the producer-consumer-at-scale world that, per `me.md`, is Rein's named gap — worth building once as a worker reading off a broker. Sibling `study-performance-engineering` owns backpressure as a throughput concern; `study-runtime-systems` owns the event-loop/concurrency mechanics underneath.

## Interview defense

**Q: "How do you keep panning from overwhelming the rate-limited APIs?"**
Verdict: three stacked throttles, no broker needed.

```
  debounce ──► single-flight gate ──► coalesce-to-latest

  pan storm ─600ms─► 1 pending ─busy?─► 1 build ─drain─► next
```

"Three layers. A 600ms debounce so I don't even queue until the pan settles. A single-flight gate — `busyRef` — so only one graph build runs at a time, since each build is a chain of rate-limited Overpass and Open-Meteo calls. And coalescing: the pending slot holds only the *latest* request per kind, so panning through ten regions builds only where you landed. Plus a priority rule: a route corridor preempts viewport loads so a route never starves behind panning. It's a degenerate priority queue — concurrency one, two priority levels."

**Anchor:** *Debounce + single-flight + coalesce-to-latest — backpressure without a broker, because only the latest view matters.*

**Q: "When would you reach for a real queue?"**
"When the work has to survive a crash or scale across workers — e.g. moving graph builds server-side to precompute many cities. Then I'd need durability, multiple consumers, partition ordering, and poison-message handling, none of which the in-process pump has. Today the work is 'rebuild the current view,' which is ephemeral and single-consumer, so a broker would be overhead."

**Anchor:** *A queue earns its place when work must outlive a crash or fan out to workers — not before.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — the timeout gap that would wedge this single-flight gate.
- `03-idempotency-deduplication-and-delivery-semantics.md` — at-least-once delivery appears with a real queue.
- `04-consistency-models-and-staleness.md` — the self-heal retry rides this same pump.
- sibling `study-performance-engineering` — backpressure as throughput.
- sibling `study-runtime-systems` — the concurrency primitives beneath the gate.
