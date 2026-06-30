# On-device inference — the learned cost runs in A*'s hot loop, contrl-style

**Industry name(s):** on-device / edge inference / local-first ML.
**Type:** Industry standard (and flattr's strongest ML-adjacent fit).

## Zoom out — flattr is local-first, and A* calls the cost thousands of times per route

On-device inference means the model runs on the phone, not a server.
flattr is already local-first — the graph is a bundled
`mobile/assets/graph.json`, A* runs on-device, no network in the hot path.
A learned cost would *have* to run on-device too, and it lands in the
hottest loop in the codebase: A* calls `costFn` once per edge relaxation
(astar.ts:68), thousands of times per route. This is the same constraint
you already solved in contrl (MediaPipe pose on-device, real-time) — a
direct portfolio bridge.

```
  Zoom out — the learned cost runs INSIDE on-device A*

  phone
  ┌─ A* search (astar.ts) ────────────────────────┐
  │ while open: for each adjacent edge:             │
  │   tentative = g + costFn(edge, …)  ← astar.ts:68│
  │                      │                          │
  │                      ▼                          │
  │            ★ cost.ts penalty() (learned)        │
  │            called THOUSANDS of times / route    │
  └─────────────────────────────────────────────────┘
  no server round-trip — model MUST fit + be fast on-device
```

The cost isn't called once per request like a typical API model. It's
called per edge expansion, in a tight loop — latency per call is
multiplied by the whole search frontier.

## Structure pass

- **Layers:** model artifact (on-disk) → load into memory → per-edge
  inference inside A* → routing result.
- **Axis — server vs device.** Server inference can be big and slow per
  call but adds network latency; device inference must be small, fast, and
  offline. flattr is local-first, so device is the only option.
- **Seam:** `costFn(edge, fromNodeId, userMax)` (astar.ts:68, types.ts:40)
  — the per-edge call site. Every microsecond here multiplies by frontier
  size.

## How it works

### Move 1 — the mental model

You've shipped on-device ML: contrl runs MediaPipe pose estimation on the
phone, frame by frame, in real time. The constraints you met there —
model fits in memory, inference is fast enough for the frame rate, works
offline — are the same constraints a flattr learned cost faces, except the
"frame rate" is "edges expanded per second in A*." If the cost call is
slow, the whole route is slow.

```
  Pattern — on-device inference budget

  contrl:  pose model · per video frame · must hit ~30fps
  flattr:  cost model · per edge expansion · must keep route <Xms
  shared constraint: small artifact + low per-call latency + offline
```

### Move 2 — the walkthrough

**Sub-step A — the call frequency is the whole problem.**

```
  astar.ts:68 — the hot call site

  for (const edgeId of adjacency[current]) {
    const tentative = g.get(current)! + costFn(edge, current, userMax);
    //                                   └ ONE inference per edge
  }
  nodes expanded × avg degree = total cost calls per route
  a 2000-node search × degree 3 ≈ 6000 cost calls
```

Today `costFn` is a few arithmetic ops (cost.ts:33) — effectively free. A
learned model replaces that with an inference. If each inference costs
even 50µs, 6000 calls = 300ms added to every route. The per-call budget is
brutal precisely because the loop is hot.

**Sub-step B — what fits in this budget.**

```
  Models that fit A*'s hot loop (fast → slow)

  linear cost          a dot product → nanoseconds → trivially fits
  small monotone GBT   a few tree traversals → microseconds → fits
  neural net           matrix mults → often too slow per-call → risky
  → favors the SIMPLE models 04-model-selection already preferred
```

The latency constraint reinforces the model-selection answer: prefer the
linear cost or a small monotone GBT not just for simplicity, but because
they're the ones that survive being called thousands of times per route.

**Sub-step C — load once, infer many.**

```
  Amortize the load

  load model artifact ONCE per app session (or per search)
  then per-edge inference reads pre-loaded weights
  NEVER load weights inside the loop (astar.ts:64-75)
  cache invariant: model is immutable during a search
```

### Move 3 — the principle

On-device inference trades server scale for a hard local budget: small
artifact, low per-call latency, fully offline. flattr's twist is that the
call site is A*'s innermost loop, so per-call latency multiplies by the
search frontier — a constraint most "serve the model on-device" answers
miss. The mitigation is the same one model-selection already pointed at:
keep the model tiny (linear or small monotone GBT) so each of the
thousands of per-route calls stays nearly free. You've done the hard
version of this in contrl; flattr is the tabular, hot-loop variant.

## Primary diagram

```
  On-device learned cost in A*'s hot loop

  ┌─ app session (phone) ───────────────────────────┐
  │ load model ONCE → weights in memory              │
  └──────────────────────┬───────────────────────────┘
  ┌─ A* search (astar.ts) ─▼────────────────────────┐
  │ per edge: tentative = g + costFn(edge,…)         │
  │           └ inference × THOUSANDS / route         │
  │ budget: per-call latency × frontier < route SLA   │
  └──────────────────────┬───────────────────────────┘
  ┌─ fits: linear / small monotone GBT ─▼───────────┐
  │ risky: neural net (too slow per-call)            │
  │ never: load weights inside the loop              │
  └───────────────────────────────────────────────────┘
```

## Elaborate

There's a nice symmetry with the admissibility story: the same simplicity
that keeps the model A*-legal (monotone, easy to constrain) also keeps it
on-device-fast (cheap per call). The constraints don't fight — they both
push toward a tiny model. That's not a coincidence; routing inside an
optimization loop punishes complexity twice (correctness *and* latency),
so the design naturally lands on the smallest model that fits the curve.
flattr's local-first posture (bundled graph, on-device A*) means there's no
escape hatch to a beefy server model — the cost has to be small or the app
is slow, which is the same lesson contrl taught at frame rate.

## Project exercises

### DEV.1 — cost-call latency budget test

- **Exercise ID:** DEV.1
- **What to build:** a benchmark that counts `costFn` calls per route on
  the bundled graph and computes the per-call latency budget given a route
  SLA (e.g. route must finish in 100ms) — the budget any learned cost must
  fit under.
- **Why it earns its place:** it turns "fits on-device" into a concrete
  per-call microsecond budget tied to A*'s real call count.
- **Files to touch:** `bench/` (add a cost-call-count + budget bench),
  `features/routing/astar.ts` (optionally expose a cost-call counter).
- **Done when:** the bench reports cost calls per route on
  `mobile/assets/graph.json` and the derived per-call budget, so a learned
  model can be checked against it before shipping.
- **Estimated effort:** half a day.

## Interview defense

**Q: How does on-device constrain a learned routing cost?** Answer: hard,
because the cost runs in A*'s innermost loop — `costFn` is called per edge
relaxation (astar.ts:68), thousands of times per route, not once per
request. So the per-call latency multiplies by the search frontier; a
50µs inference becomes 300ms per route. flattr is local-first with a
bundled graph and on-device A*, so there's no server fallback. That forces
a tiny model — a linear cost or small monotone GBT — which is the same
model-selection answer, now for latency reasons too. I solved the harder
real-time version of this in contrl with on-device pose estimation.

```
  cost called per EDGE × frontier → per-call budget is brutal
  → tiny model (linear / small monotone GBT), load once, infer many
```

Anchor: *"`costFn` runs inside A*'s hot loop (astar.ts:68) thousands of
times per route — on-device latency multiplies, so the model must be
tiny."*

## See also

- [04-model-selection.md](04-model-selection.md) — simplicity for correctness AND latency.
- [13-quantization.md](13-quantization.md) — shrinking the on-device artifact further.
- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the deploy slot is on-device by design.
