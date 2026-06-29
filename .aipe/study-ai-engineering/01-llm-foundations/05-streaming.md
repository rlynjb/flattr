# Streaming
*Token streaming — Industry standard*

## Zoom out

Because generation is autoregressive (file 01), tokens are produced one at a time — so you can either wait for the whole string or stream each token as it lands. Streaming buys *perceived* latency for long outputs; it buys nothing for short ones and actively complicates structured outputs. flattr's only candidate output is short, so this is a "know it, won't need it" concept.

```
LAYERS — streaming is a transport choice, not a model feature
┌──────────────────────────────────────────────┐
│ [LLM autoregressive loop] emits token, token… │
│        │                                        │
│   await  ─► whole string at once (simple)       │ ◄── pick one
│   stream ─► token-by-token via SSE (responsive) │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** The model generates incrementally regardless; streaming just exposes that. For a chat answer that's 3 paragraphs, streaming makes the UI feel alive at ~first token instead of after the last. For a one-sentence narration or a JSON object, the total time is so short that streaming adds UI complexity for no felt gain.

```
PATTERN — when streaming pays
  long output:  ▮ wait 4s ▮▮▮▮ ........  vs  ▮stream▮▮▮▮ (reads as you go) ✓
  short output: ▮ wait 0.3s ▮  vs  ▮stream▮  ── no perceptible win ✗
```

**Move 2 — the mechanism.** Streaming providers push tokens over Server-Sent Events (or a websocket): each chunk is a partial delta you concatenate. The catch: a partial stream is *invalid* until complete — half a JSON object won't parse, half a classification label is meaningless. So structured outputs and classifiers are consumed with `await` (you need the whole thing before you can validate or act). Streaming is for human-read prose where partial is still useful.

```
MECHANISM — stream vs await
  prose:   "A "→"short "→"ride…"   render each delta ► (partial = useful)
  JSON:    '{"dist'→'anceM":2…'    DON'T parse mid-stream ► await full
```

**Move 3 — principle.** Stream prose a human reads as it arrives; `await` anything a machine must parse or validate.

## In this codebase

**Not yet exercised in flattr.** No model calls, nothing streamed. The would-be narration at `features/routing/summary.ts:11` is a single short sentence templated from three numbers — `await` it and render. If the input-side wrapper at `pipeline/geocode.ts:9` extracted a structured destination (file 04), that's a JSON object you must validate whole, so it would never stream. Either way, streaming earns its complexity only with long human-read output, which flattr has no use case for.

## See also
- [01 — What an LLM is](01-what-an-llm-is.md)
- [04 — Structured outputs](04-structured-outputs.md)
