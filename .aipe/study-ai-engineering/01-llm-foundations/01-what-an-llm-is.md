# What an LLM Is
*Large Language Model — Industry standard*

## Zoom out

Strip away the mystique and an LLM is a function: text in, text out. Everything else — chat UIs, agents, RAG — is plumbing wrapped around that one call. You've shipped this surface three times (AdvntrCue's GPT-4, dryrun's Gemini Nano, contrl's MediaPipe); flattr is the first repo where you'll see where it *would* bolt on but doesn't yet.

```
LAYERS — where the LLM sits
┌─────────────────────────────────────────────┐
│ your app code (templating, validation)       │
│   ┌───────────────────────────────────────┐  │
│   │ LLM = f(prompt: string) → string      │  │ ◄── the whole "model"
│   │   weights frozen, stateless per call  │  │     is just this fn
│   └───────────────────────────────────────┘  │
│ provider transport (HTTP / on-device runtime) │
└─────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** An LLM is a pure-ish function over strings. It holds no memory between calls; "conversation" is you re-sending the whole history each time. The weights are frozen at training; the only thing that varies per call is the text you hand it (and sampling, see file 03).

```
PATTERN — text-in / text-out
  "Summarize: 2.1km, 80m climb, 3 steep" ─► [ LLM ] ─► "A short ride with
                                                         one solid hill."
        structured facts                              one English sentence
```

**Move 2 — the mechanism, step by step.** The string isn't consumed as characters. It's split into tokens (file 02), each token mapped to a vector, run through the transformer stack, and the model emits a probability distribution over the *next* token. You sample one, append it, and feed the whole thing back in — autoregression. Repeat until a stop token or length cap.

```
MECHANISM — autoregressive loop
  prompt ─► tokenize ─► [transformer] ─► P(next token)
                            ▲                  │
                            │   append sampled │
                            └──────◄───────────┘
                         (loop until stop)
```

The consequence that matters for engineering: output is generated left-to-right and costs scale with how many tokens come out (file 06). The model never "thinks ahead" — it commits one token at a time.

**Move 3 — principle.** An LLM is a stateless string→string function; design your seam as if you're calling a flaky network function, because you are.

## In this codebase

**Not yet exercised in flattr.** There is no LLM, no inference runtime, no provider SDK — dependencies are tsx/typescript/vitest only. The cleanest place an LLM *would* attach is the output→prompt seam at `features/routing/summary.ts:11`: `routeSummary(graph, path, userMax)` already returns a tidy `{distanceM, climbM, steepCount}`. That struct is exactly the kind of small, trusted payload you'd template into a prompt to get a one-sentence "describe my route" narration. It flows to `mobile/src/MapScreen.tsx:159` and renders at `mobile/src/RouteSummaryCard.tsx` — today as raw numbers, where the narrated sentence would slot in.

## See also
- [02 — Tokenization](02-tokenization.md)
- [04 — Structured outputs](04-structured-outputs.md)
