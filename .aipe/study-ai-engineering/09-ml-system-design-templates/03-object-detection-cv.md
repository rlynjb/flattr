# Object Detection / Computer Vision

*Image -> bounding boxes / landmarks, with an on-device inference runtime.*

The CV interview prompt. "Detect objects / faces / poses in an image or video
stream." Two halves to get right: the *model* (a detector that maps pixels to
boxes or keypoints) and the *runtime* (where it runs, and the latency/memory
budget — especially on-device, where you can't lean on a GPU cluster).

You have shipped exactly this shape. **contrl** is an on-device MediaPipe
pose-landmark pipeline that maps camera frames -> body keypoints -> a rep
counter. That's the reference to reason from here; it's the real on-device CV
system you can speak to.

## Standard architecture (anchored on contrl)

```text
              ON-DEVICE CV PIPELINE (contrl's shape, generic)
  ┌─────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
  │ camera  │──▶│ PREPROCESS   │──▶│ MODEL        │──▶│ POSTPROCESS    │
  │ frame   │   │ resize/norm  │   │ (MediaPipe   │   │ keypoints ->   │
  └─────────┘   │ on device    │   │  pose, TFLite│   │ rep count /    │
                └──────────────┘   │  on device)  │   │ boxes / logic  │
                                   └──────┬───────┘   └────────────────┘
                                          │
                              on-device BUDGET discipline:
                              frame rate, model size, thermal,
                              battery, dropped-frame backpressure
```

The hard part is rarely the model — it's the budget. On-device means a fixed
compute envelope, no network round-trip, and a thermal/battery ceiling. contrl's
real engineering is the postprocess + budget loop (keypoints -> reps without
jitter, at frame rate, on a phone), not training a detector.

## Data and features (generic)

- **Input** — pixels. Frames or stills. Labels are boxes/masks/keypoints.
- **Features** — the model learns them; your job is preprocessing (resize,
  normalize, color space) and postprocessing (NMS, smoothing, tracking).
- **Scale concerns** — on-device: model quantization (TFLite/INT8), frame
  decimation, warm-up cost, and dropping frames under load rather than queuing.

## Applies to this codebase

**None. Be blunt: flattr has no CV surface at all.** flattr processes a geometry
graph — nodes, edges, lat/lng, elevation, grade. There is no camera, no image,
no pixel, no frame anywhere in the repo. Searching `features/`, `pipeline/`, and
`mobile/` turns up map rendering and route geometry, never image input. Object
detection, landmarks, bounding boxes — zero applicability.

The single legitimate point of contact is *on-device inference shape*, and even
that is an analogy, not a match:

```text
  the ONLY on-device-inference shape flattr has
  ┌──────────────────────────────────────────────────────────┐
  │  features/routing/astar.ts   — A* over the street graph   │
  │  runs ON DEVICE, under a budget, no server round-trip      │
  │  ...but it's an ALGORITHM, not a model. No pixels, no       │
  │  weights, no inference. Determinism, not detection.         │
  └──────────────────────────────────────────────────────────┘
```

So the honest statement is: flattr does on-device *computation* (A* routing),
not on-device *inference*. The thing CV and flattr share is the *constraint* —
"it has to run on the phone, within a budget" — not the *technique*.

## How to make it apply

**Out of scope.** There is no path to bolt object detection onto a routing
engine without inventing a new product. Don't force it.

The transferable lesson is the part worth carrying into an interview: the
**on-device-budget discipline** you built for contrl is the same discipline
flattr would need *if* it ever moved elevation work onto the device. Today
elevation is a build-time network call (`pipeline/elevation.ts` —
`openMeteoProvider` / `googleProvider`, both `fetch`-based, run in the build, not
on the phone). If flattr ever did on-device elevation infill (e.g., refining
coarse 90m DEM grades locally), the engineering problem would rhyme exactly with
contrl: a fixed compute envelope on the phone, no round-trip, drop-work-under-
load. The `ElevationProvider` interface (`pipeline/elevation.ts:7`) is even the
seam where an on-device provider would plug in — same pattern as swapping a
`CostFn`. That's a runtime-budget story, not a vision story, and it's the only
honest bridge from contrl's CV work to flattr.

## See also

- `pipeline/elevation.ts:7` — `ElevationProvider` seam (where on-device infill
  would attach, hypothetically)
- `features/routing/astar.ts` — flattr's only on-device-compute (algorithm, not
  inference)
- `01-recommender-system.md` — the one reframe with a *real* model attach point
- contrl (reader's project) — the actual on-device CV pipeline this anchors to
