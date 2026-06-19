# Queues, streams, ordering, and backpressure
### the single-flight pump as an in-process queue with priority and overload control
**Industry name:** single-flight, admission control, priority queue, backpressure · **Type:** Industry standard

## Zoom out, then zoom in

There's no Kafka here, no SQS, no broker you operate — so message queues as infrastructure are `not yet exercised`. But the *concepts* queues exist to provide — serialize concurrent work, prioritize it, shed overload, apply backpressure — are all present in one tight piece of code: the `pump()` gate in `useTileGraph`. It's an in-process, 2-slot priority queue that admits one network build at a time. That's the file's real subject, and it's genuinely load-bearing: rip it out and the phone hammers the free APIs concurrently and gets 429'd into uselessness.

```
  Zoom out — where the in-process queue lives

  ┌─ UI layer (the phone) ──────────────────────────────────────┐
  │  onRegionDidChange (pan)  ·  ensureBbox (route)              │
  │     enqueue ▼                  enqueue ▼                     │
  ┌─ Coordination layer ──────────────────────────────────────┐ │
  │  ★ pump() — busyRef gate + corridor>view priority slots ★  │ │ ← we are here
  │     dequeue one ▼ (single-flight)                          │ │
  └────────────────────────────────────────────────────────────┘ │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK ═══ (rate-limited)
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  Overpass + Open-Meteo — free tier; concurrent calls ⇒ 429   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the question a queue answers is *"more work is arriving than I can do at once — how do I order it, and how do I not drown?"* On the phone, pans and route requests both want graph builds, each build is an expensive multi-API round-trip, and doing several at once trips the rate limit. `pump()` is the answer: one in flight, route beats pan, newer-supersedes-older per slot. That's admission control + priority + backpressure in ~40 lines.

## Structure pass

**Layers.** Producers (pan handler, route handler) → the queue (`pump` + two pending refs + `busyRef`) → the worker (the async build IIFE) → network.

**The axis: control — "who decides what runs next, and when?"** Trace it:

```
  One question — "who decides what runs next?" — traced down

  ┌──────────────────────────────────────┐
  │ producers (pan / route)               │  → request, but DON'T run. they
  └──────────────────────────────────────┘    drop a bbox in a slot + call pump
      ▼
  ┌──────────────────────────────────────┐
  │ pump() + busyRef                      │  → DECIDES: if busy, do nothing;
  └──────────────────────────────────────┘    else pick corridor-then-view
      ▼
  ┌──────────────────────────────────────┐
  │ worker IIFE                           │  → runs ONE build; on finish,
  └──────────────────────────────────────┘    calls pump() to drain the next
```

**The seam.** `busyRef` is the seam where concurrency control flips. Above it, any number of producers fire freely (every pan event, every route). Below it, exactly one build runs. That boolean is the admission gate — the contract is "I accept unlimited requests but admit one at a time." The second seam is the priority split between the two pending refs: corridor always wins.

## How it works

#### Move 1 — the mental model

You know single-flight from de-bounced search-as-you-type: many keystrokes, one in-flight request, the rest collapse. `pump()` is that, plus a priority rule and a self-draining loop.

```
  The single-flight-with-priority kernel

   producers ──► [ pendingCorridor ]  (slot: route, HIGH priority)
            └──► [ pendingView     ]  (slot: pan,  LOW priority)
                        │
                  pump() ── busy? ──yes──► return (do nothing)
                        │ no
                        ▼
              pick corridor ELSE view  ──► run ONE build
                        │
                  on finish ──► pump()   (drain next, corridor first)
```

The whole pattern: **at most one running, a fixed priority on what runs next, and each finish kicks the next.** That self-call at the end is the load-bearing line — it's what turns a gate into a queue.

#### Move 2 — the load-bearing skeleton

Isolate the kernel and name each part by what breaks without it.

**Part 1 — the busy flag (admission gate / single-flight).** Bridge from a `loading` boolean that disables a submit button. `busyRef` is `true` while a build runs; `pump` returns immediately if it's set. *What breaks if removed:* every pan and route launches a concurrent Overpass+Open-Meteo build. Three quick pans = three concurrent free-tier calls = 429 for all of them. The flag is the backpressure — it bounds in-flight work to one, which is the *entire* reason flattr stays under the rate limit. This is the part people forget when they "just add a fetch on pan."

```
  busyRef — bound in-flight work to exactly one

  pan, pan, pan (3 events)        with busyRef:        without:
        │                          ┌─ build 1 (rest    ┌─ build 1
        ▼                          │   collapse into    ├─ build 2  } 3 concurrent
   pump×3                          │   the slot)        └─ build 3  } ⇒ 429×3
                                   └─ one at a time ✓                 ⇒ all fail ✗
```

**Part 2 — the two priority slots (ordering).** Bridge from a 2-element priority queue. `pendingCorridorRef` (routes) and `pendingViewRef` (pans); `pump` always checks corridor first. *What breaks if removed (one shared slot):* a user requesting a route while panning could have the route build starved by a stream of pan builds — the thing they actually asked for (a path) loses to incidental map movement. Priority guarantees the *intentional* action wins over the *incidental* one.

```
  Priority dequeue — corridor (intent) beats view (incidental)

  pump picks:   if pendingCorridor ──► run corridor, clear slot
                else if pendingView ──► run view, clear slot
                else ──► idle
   a pending route is NEVER starved by panning. tested by construction.
```

**Part 3 — last-write-wins per slot (coalescing).** Bridge from `setState` overwriting a previous pending value. Each slot holds *one* bbox; a newer pan overwrites the older pending pan. *What breaks if removed (a growing list):* you'd build every intermediate viewport the user panned through — stale work for regions they've already scrolled past. Coalescing to the latest means you only build what's relevant *now*. Combined with the `DEBOUNCE_MS` timer on pan (`:139-148`), the system does the minimum builds for where the user actually ended up.

**Part 4 — the drain (the self-call).** Bridge from a recursive `processNext()` in a job runner. The worker's `finally` calls `pump()` again. *What breaks if removed:* a request that arrived *while* a build was running sits in its slot forever — the queue stalls because nothing kicks it after the gate clears. The drain is what makes it a queue and not a one-shot lock.

```
  The drain — finish kicks the next, or the queue stalls

  build running ──► (pan arrives, lands in slot) ──► build finishes
                                                          │ finally
                                                    busyRef=false
                                                    pump() ──► drains the pan ✓
   without the finally-pump: the pan waits until the NEXT pan calls pump. stall.
```

**Optional hardening — what's NOT here.** No cancellation of an in-flight stale build (an `AbortController` would cancel a pan-build superseded by a route — `study-runtime-systems` covers this gap); no bounded retry/dead-letter for a build that keeps failing (a failed build is simply dropped, `:121-122`, and retried on the next pan); no fairness beyond the fixed 2-level priority. Those are real queue hardening; the kernel is correct without them at one-user scale.

#### Move 2.5 — in-process queue vs. a real broker

```
  Phase A (now) vs Phase B (§11 E2 server-side build farm)

  NOW — in-process pump()           SERVER-SIDE BUILD FARM
  ─────────────────────             ──────────────────────
  queue = 2 refs in RAM             queue = SQS / Redis Streams
  worker = one async IIFE           workers = N consumers, parallel
  priority = if/else                priority = separate queues / msg attr
  overload = busyRef (1 in flight)  overload = consumer concurrency + backpressure
  poison msg = dropped, retried      poison msg = DLQ after N attempts
  ordering = LWW per slot            ordering = partition key / FIFO queue
  loss on crash = fine (re-pan)     loss on crash = needs durable queue + ack
```

The trigger is §11 E2 (build all cities / a tile-build farm). The concepts are *identical* — single-flight becomes consumer concurrency, the if/else priority becomes two queues, drop-and-retry becomes a DLQ. What changes is durability: an in-RAM ref vanishes on crash, which is fine when "retry" means "the user pans again"; a build farm needs the queue to survive a worker crash, so it goes durable.

#### Move 3 — the principle

A queue is just *bounded admission + an ordering rule + a drain*. flattr proves you don't need a broker to get the value of one — `busyRef` + two refs + a self-call deliver single-flight, priority, coalescing, and backpressure in-process. The general lesson: **reach for a message broker when you need durability or cross-process fan-out, not when you just need to serialize and prioritize work** — that you can do with a flag and a couple of slots.

## Primary diagram

The full pump mechanism in one frame.

```
  pump() — in-process priority queue with backpressure — recap

  PRODUCERS                         QUEUE STATE
  ─────────                         ───────────
  onRegionDidChange ─debounce─► pendingViewRef   ─┐
  ensureBbox ─────────────────► pendingCorridorRef ─┤
                                                    ▼
                              ┌─ pump() ────────────────────────┐
                              │ if busyRef: return  (backpressure)│
                              │ pick: corridor ELSE view  (prio)  │
                              │ busyRef = true                    │
                              └───────────┬───────────────────────┘
                                          ▼ WORKER (one at a time)
                              ┌──────────────────────────────────┐
                              │ fetchOverpass ─► bestEffortElev    │
                              │ ─► buildGraph ─► setView/setCorridor│
                              │ finally: busyRef=false; pump() ◄───┐│  drain
                              └────────────────────────────────────┘│
                                          │ ═══ NETWORK ═══         │
                                          ▼                         │
                                Overpass + Open-Meteo (rate-limited)┘
```

## Implementation in codebase

**Use cases.** `pump()` runs on every pan (after a 600ms debounce) and every route request. Producers never block the UI — they drop a bbox and return; the worker drains asynchronously. Concretely: pan the map and `onRegionDidChange` debounces then enqueues a view build; tap to route and `ensureBbox` enqueues a corridor build that *preempts* any pending pan.

The gate + priority dequeue:

```
  mobile/src/useTileGraph.ts  (lines 67, 89–104)

  const busyRef = useRef(false);                  ← the admission gate (Part 1)
  const pump = useCallback(() => {
    if (busyRef.current) return;                  ← single-flight: one at a time
    let kind, bbox;
    if (pendingCorridorRef.current) {             ← PRIORITY: corridor checked first
      kind = "corridor"; bbox = pendingCorridorRef.current;
      pendingCorridorRef.current = null;          ← consume the slot
    } else if (pendingViewRef.current) {          ← view only if no corridor pending
      kind = "view"; bbox = pendingViewRef.current;
      pendingViewRef.current = null;
    } else { return; }                            ← nothing queued → idle
    busyRef.current = true;                        ← claim the gate
    ...
```

The worker + the load-bearing drain:

```
  mobile/src/useTileGraph.ts  (lines 106–128)

  (async () => {
    try {
      const osm = await fetchOverpass(bbox);                  ← network (rate-limited)
      const elev = bestEffortElevation(openMeteoProvider(...));
      const g = await buildGraph(kind, bbox, osm, elev, ...);
      ... setCorridor / setView ...
    } catch {
      // Overpass failed — keep last region; a later pan retries.  ← poison msg = drop+retry
    } finally {
      busyRef.current = false;                                 ← release the gate
      setLoadingStep(null);
      pump();                                                  ← DRAIN next (Part 4)
    }
  })();
       │
       └─ the finally-pump is load-bearing: without it a request that arrived
          during this build waits until the next pan calls pump. with it, the
          queue self-drains, corridor-first. remove it and the queue stalls.
```

The coalescing producer (last-write-wins + debounce):

```
  mobile/src/useTileGraph.ts  (lines 138–148, inside onRegionDidChange)

  if (timerRef.current) clearTimeout(timerRef.current);  ← debounce: cancel prior timer
  timerRef.current = setTimeout(() => {
    if (covers(viewRef.current, bounds)) return;          ← skip if already covered (dedup)
    ...
    pendingViewRef.current = [w-px, s-py, e+px, n+py];     ← LWW: overwrite the pending bbox
    pump();
  }, DEBOUNCE_MS);
```

## Elaborate

Single-flight is the lightest member of the queue family and the one most under-used — engineers reach for a broker when a boolean would do. The pattern shows up everywhere once you see it: SWR/React-Query de-dup concurrent requests for the same key; a database connection pool admits N queries and queues the rest; a load balancer's max-in-flight is the same idea at the fleet level. `pump()` is the in-process instance, with the extra wrinkle of a priority rule.

The priority choice (corridor > view) is the interesting product call: it encodes "what the user *asked* for beats what they incidentally triggered." That's a scheduling decision, and it's the kind of thing that's invisible until it's wrong — without it, a route request submitted mid-pan would feel laggy because pan builds keep cutting the line.

Where this grows up: §11 E2's build farm turns every concept here durable and multi-consumer (see Move 2.5). The migration is conceptually clean precisely because the in-process version already names all the parts — you're swapping the *substrate* (RAM refs → durable broker), not redesigning the *logic*. For the execution-model view of the same gate (event loop, async, the missing cancellation), see `.aipe/study-runtime-systems/`.

## Interview defense

**Q: "How do you stop concurrent tile fetches from blowing the rate limit?"**
A single-flight gate. `busyRef` is a boolean that admits exactly one graph build at a time; producers (pans, routes) just drop a bbox in a slot and call `pump()`, which no-ops if a build is running. So unlimited UI events collapse into one in-flight network build — that's the backpressure that keeps me under the free Overpass/Open-Meteo limits. Two priority slots make a pending *route* preempt a pending *pan*, and the worker's `finally` calls `pump()` again to drain the next — that self-call is what makes it a queue and not just a lock.

```
   many pans/routes ──► [corridor slot][view slot] ──► pump (busy? no-op)
                                                          │ one at a time
                                                    build ─► finally: pump() drain
   bound in-flight = 1  ·  corridor > view  ·  self-draining
```
*Anchor: bounded admission + priority + a drain — the finally-pump is the load-bearing line.*

**Q: "Why not just use a real queue?"**
Because I need to serialize and prioritize work, not survive a crash or fan out across processes. A broker buys durability and multi-consumer fan-out; I have one device, one user, and "retry" means "the user pans again" — so an in-RAM gate is correct and a broker would be unused complexity. I'd reach for SQS/Redis Streams only at the §11 E2 build-farm stage, where workers run in parallel and a dropped job actually costs something. *Anchor: brokers buy durability/fan-out; for serialize+prioritize, a flag and two slots suffice.*

## Validate

1. **Reconstruct:** write the `pump()` kernel from memory — gate, two priority slots, the drain. Which single line makes it a queue instead of a lock?
2. **Explain:** in `useTileGraph.ts:93-100`, why is `pendingCorridorRef` checked before `pendingViewRef`? What user-visible bug does that prevent?
3. **Apply:** a user pans three times in 400ms then taps route. With `DEBOUNCE_MS=600` and the LWW slots, how many network builds run, and in what order? Trace through `onRegionDidChange` and `ensureBbox`.
4. **Defend:** a reviewer wants you to "fan tile fetches out in parallel for speed." Argue why `busyRef` serialization is correct against the free-tier limit, and what infrastructure change (§11 E2) would make parallelism safe.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retries inside each serialized build.
- `03-idempotency-deduplication-and-delivery-semantics.md` — `covers()` as request-level dedup feeding this queue.
- `08-sagas-outbox-and-cross-boundary-workflows.md` — what a multi-step *durable* workflow on top of this would need.
- `.aipe/study-runtime-systems/` — the same gate as event-loop/async/cancellation mechanics.
- `.aipe/study-performance-engineering/` — backpressure and debounce as latency/throughput tuning.
