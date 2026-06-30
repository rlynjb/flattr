# 03 — Object Detection (On-Device CV)

A reusable interview template, reframed against flattr. This is the cleanest "no"
in the set: flattr has no camera, no video, no pixels. The useful move in an
interview is to say so immediately and pivot to the portfolio project that *does*
do on-device CV (contrl), rather than torturing flattr into a fit.

- **The prompt:** "Design a computer-vision system that detects objects in real-time video, running on-device."

- **Standard architecture:** On-device object detection is a per-frame inference loop — capture, preprocess to the model's input tensor, run a quantized detector, post-process boxes, and overlay, all without leaving the device. The diagram below shows the frame path with the model loaded once at startup.

```
              On-device object detection — per-frame inference loop
  ┌──────────┐ frame ┌──────────────┐ tensor ┌──────────────────┐ raw out ┌──────────────┐
  │  Camera  │──────►│ Preprocess   │───────►│ Detector model   │────────►│ Post-process │
  │ (stream) │       │ resize/norm  │        │ (quantized, GPU/ │         │ NMS + decode │
  └──────────┘       └──────────────┘        │  NPU delegate)   │         └──────┬───────┘
       ▲                                      └──────────────────┘                │ boxes
       │                                              ▲                           ▼
       │                                              │ weights            ┌──────────────┐
       │                                      ┌───────┴────────┐           │  Overlay UI  │
       └──────────────────────────────────────│ Model loaded   │           │ draw on frame│
                next frame (no round-trip)     │ once at start  │           └──────────────┘
                                               └────────────────┘
```

  The whole point of on-device is that no box in this diagram touches the network per frame. flattr has none of these boxes because it has no frames.

- **Data model:** Model weights bundled in the app, a label map (class id → name), and per-frame the input tensor plus output detections (boxes, class, score) — all transient, nothing persisted by default. flattr's persisted data model is entirely non-visual: `Node {lat, lng, elevationM}` and `Edge {gradePct, absGradePct, lengthM, riseM, kind?}` in `mobile/assets/graph.json`. There is no image, frame buffer, tensor, or label map anywhere in the codebase.

- **Key components:** Capture/preprocess — pulls frames and resizes/normalizes to the model's fixed input; the technical choice is doing the resize on GPU to avoid CPU-bound frame drops. Detector — a compact architecture (SSD-MobileNet / YOLO-nano class) behind a hardware delegate; the choice is a quantized model on the NPU/GPU delegate over a float CPU model because the per-frame latency budget (~33ms at 30fps) is unforgiving. Post-process — non-max suppression and box decode; the choice is to cap detections and tune the NMS IoU so overlay stays stable frame-to-frame.

- **Scale concerns (ordered by what hits first):** (1) Per-frame latency — the 30fps budget breaks first; a model that's 50ms/frame drops to ~20fps and feels broken. (2) Thermal/battery — sustained NPU use throttles within minutes on phones, degrading throughput; needs frame-skipping or a duty cycle. (3) Model size in the bundle — large weights bloat install size and cold-start load; quantization addresses both. (4) Device fragmentation — delegate availability varies across Android/iOS hardware, forcing a CPU fallback path.

- **Eval framing:** Offline — mAP at IoU thresholds on a held-out image set, plus on-device latency and the accuracy lost to quantization. Online — real-world detection precision/recall under the conditions that matter (lighting, motion blur), frame rate sustained on target devices, and battery drain per session. Offline mAP on clean images routinely overstates real performance.

- **Common failure modes:** Quantization accuracy cliff — int8 conversion tanks small-object recall; mitigate with quantization-aware training or per-channel quantization. Thermal throttling — fps collapses after minutes; mitigate with adaptive frame-skip. Domain shift — model trained on clean data fails on the user's actual camera; mitigate with in-domain fine-tuning. Jittery boxes — detections flicker frame-to-frame; mitigate with temporal smoothing/tracking.

- **Applies to this codebase: NO.** This template does not fit flattr at all, and it's worth stating plainly why rather than reaching. flattr has no camera input, no video stream, no images, and no CV model — its entire input is a precomputed street graph and a user-set max grade. There is nothing to detect because there are no pixels. The only on-device-*model* parallel anyone could draw is the learned edge cost in `features/routing/cost.ts` — `penalty()` (cost.ts:16) is a small parameterized function that runs locally inside A* — but that is a scalar cost over graph edges, not detection over a visual signal. It shares the word "on-device" with this template and nothing else: no perception, no frames, no inference loop. Forcing flattr into an object-detection answer would be dishonest. The right interview move is to name the mismatch and redirect.

  For genuine contrast, **contrl** is the portfolio project that actually does this: it runs MediaPipe on-device to detect pose landmarks from the camera and turns the landmark stream into a rep counter — a real end-to-end, on-device CV pipeline with exactly the capture → model → post-process → overlay loop in the diagram above. That is where the on-device-detection story lives. flattr is the wrong artifact for this prompt; contrl is the right one.

- **How to make it apply (honest: it doesn't, and shouldn't):** There is no honest refactor of flattr that produces object detection, because flattr has no visual input to detect over — adding a camera would be building a different app, not refactoring this one. The only on-device-model surface that exists is the learned cost in `cost.ts`, and that is optimization inside graph search, not detection; bolting a CV model onto a routing app would be invention, which this study set forbids. The correct answer to "make it apply" is to refuse the premise: in an interview, say "flattr has no camera, so this template doesn't apply — but I've shipped exactly this in contrl, where MediaPipe pose-landmark detection feeds a rep counter on-device," and walk the contrl pipeline instead. That keeps flattr honest and still answers the question with a real on-device CV system you've built.
