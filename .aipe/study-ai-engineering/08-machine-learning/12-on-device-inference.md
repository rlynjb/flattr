# On-Device Inference

*Industry name: on-device / edge inference — running models locally, no network in the hot path.*

## Zoom out

```
SERVER INFERENCE                 ON-DEVICE INFERENCE
phone → network → GPU → back     phone runs it locally
 ┌──────────────────────┐        ┌──────────────────┐
 │ latency, offline=dead │        │ instant, offline │
 │ privacy leaves device │        │ private, no $/req│
 └──────────────────────┘        └──────────────────┘
```

On-device inference means the model (or algorithm) runs on the phone itself — no round trip
in the request path. You get low latency, offline operation, and privacy, at the cost of a
tight compute/memory/battery budget. **This is your home turf** — contrl is exactly this:
on-device MediaPipe pose-landmarks → rep-counter, in a frame-rate budget. flattr shares the
*architecture shape* (compute on the phone) while using an *algorithm*, not a model.

## How it works

### Move 1 — the mental model: bring the compute to the data

```
HOT PATH MUST NOT TOUCH THE NETWORK
user requests route
   │
   ▼ (on phone, no fetch)
A* over graph.json ──► path in ~ms
   ▲ everything needed is already local
```

The defining rule: the *latency-critical* path runs entirely on the device. Anything slow
or networked (downloading the model, downloading the graph) happens *outside* the hot path,
ahead of time.

### Move 2 — contrl (real model) vs flattr (real algorithm), same shape

```
contrl  (your shipped ML)            flattr  (today)
┌──────────────────────────┐         ┌──────────────────────────┐
│ frame → MediaPipe (on     │         │ query → A* over graph.json│
│  device) → landmarks →    │         │  (on device) → route      │
│  rep count, frame budget  │         │  no network in route path │
└──────────────────────────┘         └──────────────────────────┘
   on-device MODEL                       on-device ALGORITHM
```

flattr already nails the hard part of on-device serving: `data/graph.json` ships with the
app, and `features/routing/astar.ts` runs the search **on the phone**. No server, no
network in the route hot path — the same discipline contrl uses for pose frames, applied to
graph search.

**The contrl-shaped attach point (the place a real on-device MODEL would slot in):**
`pipeline/elevation.ts`. Today elevation is **networked and brittle** — the Open-Meteo
provider retries `429`s with exponential backoff (see the code: `if (res.status === 429
&& attempt < retries)`), because the free tier rate-limits hard. That network dependency is
the contrl-shaped opening:

```
TODAY (networked, fragile)        ON-DEVICE INFILL (contrl-shaped)
node lat/lng → Open-Meteo 90m     node lat/lng + local features
  → 429 backoff → elevation         → small on-device model → grade
  (build-time only, but flaky)      (no network, runs like contrl)
```

A small model that infills elevation/grade from local features (`pipeline/grade.ts`
consumes the result) would remove the Open-Meteo 429 dependency — the same on-device
inference pattern you already shipped in contrl, now on terrain instead of pose.

### Move 3 — the principle

**Decide what must run in the hot path, then make sure it never reaches for the network.**
flattr already enforces this for routing; the unshipped frontier is doing the same for
elevation so the *build* (and one day, live infill) doesn't depend on a flaky free API.

## In this codebase

**Routing is genuinely on-device today (algorithm, not model).** `astar.ts` over
`graph.json` runs locally with no network in the route hot path — architecturally identical
to contrl's serving, minus a learned model.

**NOT YET EXERCISED: an on-device *model*.** The real opening is `pipeline/elevation.ts`
(on-device grade infill, killing the Open-Meteo 429 dependency) — the most contrl-like move
flattr could make. The other learnable seam, `features/routing/cost.ts`, would *also* serve
on-device (it runs inside the on-phone A*), and would still owe the ≥0/monotone invariant
(file 04). `features/grade/classify.ts` runs on-device but is a threshold table, not a model.

## See also

- `13-quantization.md` — shrinking that infill model to fit the phone (contrl constraints)
- `07-transfer-learning.md` — contrl's pretrained MediaPipe, the model you served on-device
- `16-retraining-pipelines.md` — the offline build that prepares on-device artifacts
</content>
