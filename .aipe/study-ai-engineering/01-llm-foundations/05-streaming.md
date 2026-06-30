# Streaming

**Industry name(s):** token streaming / server-sent events / incremental
decoding (vs. await-the-whole-response). **Type:** Industry standard
delivery mode.

## Zoom out — where this would sit in flattr

A model can return its tokens two ways: stream them one-by-one as they're
decoded (good for long, human-read prose — first token shows fast), or you
`await` the whole completion (required when you need the *full structured
object* before acting). flattr makes **no model call**, so it streams
nothing. But it has two would-be calls with *opposite* answers:
route-describe is short prose (streaming optional, barely worth it) and an
NL-parse that produces a structured filter (must **not** stream — you need
the complete object to validate before touching the router).

```
  Zoom out — two would-be calls, opposite streaming answers

  ┌─ INPUT seam: NL parse (NOT BUILT) ──────────────────────┐
  │ "avoid steep hills" ─► [LLM] ─► {maxGrade: 6, avoid:…}   │
  │   AWAIT the whole object — never stream a half-parsed    │
  │   filter into directedAstar                              │ geocode.ts:9 region
  └──────────────────────────────────────────────────────────┘
  ┌─ OUTPUT seam: route-describe (NOT BUILT) ───────────────┐
  │ RouteSummary {3 numbers} ─► [LLM] ─► short blurb         │
  │   stream optional — it's one sentence, await is fine     │ summary.ts:5
  └──────────────────────────────────────────────────────────┘
```

flattr has **no streaming code**. The lesson: streaming is a per-call
decision driven by whether downstream needs the *whole* result.

## Structure pass

- **Layers:** input parse (structured) → router (exact) → summary →
  describe (prose) → UI.
- **Axis — completeness-before-use:** some consumers can use partial
  output (render prose as it arrives); some need it *whole* before doing
  anything (a filter object you parse and validate). The axis is "can the
  next stage start on a fragment?"
- **Seam:** it flips per call. At the describe seam (`summary.ts:5`) the
  UI *could* paint partial text. At the parse seam (near `geocode.ts:9` /
  `MapScreen.tsx:182`) the router needs a *complete, valid* filter — a
  fragment is useless or dangerous.

## How it works

### Move 1 — the mental model

You know `fetch` with `await res.json()` (whole body) vs a `ReadableStream`
you read chunk-by-chunk. Streaming an LLM is the chunk version: tokens
arrive incrementally, so a chat UI can show text typing out. Await is the
whole-body version: you get one final string/object. Use streaming for
*perceived latency on long human-read text*; use await when downstream
*parses* the result.

```
  Pattern — stream (incremental) vs await (whole)

  STREAM:  [LLM] ─► t ─► to ─► tok ─► toke ─► token ...   UI paints live
                                                          (good for prose)
  AWAIT :  [LLM] ───────────────────────────► full object
                                              then parse/validate/act
                                              (required for structured)
```

### Move 2 — the walkthrough

**Describe-route: short, streaming optional.** `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

The describe output is one sentence from three numbers. Streaming saves
maybe a few hundred ms of perceived latency — nice but not load-bearing.
`await` is perfectly fine; the blurb pops in when `MapScreen.tsx:368`
renders the card. Don't over-engineer streaming for a sentence.

```
  Layers-and-hops — describe seam: await is fine

  ┌─ engine ──┐ {3 numbers}  ┌─ describeRoute ─┐ blurb  ┌─ UI ──────┐
  │routeSummary│ ──────────► │ await (short)   │ ─────► │SummaryCard│
  └───────────┘              └─────────────────┘        └───────────┘
```

**NL-parse: must NOT stream.** A would-be "type what you want" box near
the geocode input (`MapScreen.tsx:82`/`:182`) would send free text to a
model that returns a *structured filter* — e.g. `{maxGrade, avoid}`. You
cannot feed a half-built object into `directedAstar`. You await the whole
thing, validate it against a schema, *then* update state and route.
Streaming a partial filter is at best wasted, at worst routes on garbage.

```
  Layers-and-hops — parse seam: await, validate, THEN act

  "avoid hills" ─► [LLM await] ─► {maxGrade:6, avoid:[…]} ─► validate
                                                              │ ok
                                                              ▼
                                                     directedAstar(…)
        (a streamed half-object here = invalid filter into the router)
```

**The rule.** Stream when a human reads the tokens live and partials are
harmless. Await when a machine parses the result and partials are invalid.
flattr's two would-be calls land on opposite sides of that rule.

### Move 3 — the principle

Streaming is a UX optimization for long human-read text; it is *wrong* for
structured output a machine must parse whole. Decide per call by asking
"can the next stage act on a fragment?" — for flattr, no for the parse,
optional for the describe.

## Primary diagram

```
  Streaming — flattr's two would-be calls, decided

  ┌─ INPUT (NOT BUILT): NL parse ───────────────────────────┐
  │ text ─► [LLM AWAIT] ─► whole filter ─► validate ─► route │
  │ MUST await — router needs the complete object           │
  └──────────────────────────────────────────────────────────┘
  ┌─ OUTPUT (NOT BUILT): route-describe ────────────────────┐
  │ {3 numbers} ─► [LLM] ─► one sentence ─► card             │
  │ stream OPTIONAL — too short to matter; await is fine     │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Streaming costs real complexity: partial-parse handling, cancellation when
the user changes input, and you can't validate a schema until the stream
closes. That's why structured/tool-calling responses are typically
awaited even when the API supports streaming them. Where streaming shines
— a long chat answer the user reads as it types — flattr simply doesn't
have. Both would-be calls are short or structured, so streaming is at most
a minor describe-side nicety.

## Project exercises

### B-ST.1 — await contract for the parse stub

- **Exercise ID:** B-ST.1
- **What to build:** a stub `parseRouteIntent(text): Promise<{maxGrade?:
  number}>` that resolves a *whole* object (no streaming) and is validated
  before any state update, encoding the await-then-validate rule.
- **Why it earns its place:** it fixes the non-negotiable side (structured
  parse = await) at the real input seam.
- **Files to touch:** new `features/routing/intent.ts`;
  `mobile/src/MapScreen.tsx:182` (resolve site near geocode).
- **Done when:** the function returns a validated whole object; a test
  rejects partials.
- **Estimated effort:** 1–2 hrs.

### B-ST.2 — measure if describe even needs streaming

- **Exercise ID:** B-ST.2
- **What to build:** time the `describeRoute` stub end-to-end and document
  that a one-sentence output doesn't justify streaming complexity.
- **Why it earns its place:** it turns "streaming optional" into a
  measured decision at the describe seam.
- **Files to touch:** `features/routing/describe.ts`;
  `mobile/src/MapScreen.tsx:368` (render site).
- **Done when:** a note records the latency and the await decision.
- **Estimated effort:** 45 min.

## Interview defense

**Q: Would you stream the route description?** Answer: Optional — it's one
sentence, so await is fine; streaming saves maybe a few hundred ms of
perceived latency, not worth the complexity. The call I'd *never* stream is
a future NL-parse that returns a structured filter — the router needs the
complete validated object, so I await, validate against a schema, then
route. Streaming a half-parsed filter into `directedAstar` is wrong.

```
  parse: text → [LLM await] → whole filter → validate → route
  describe: {3 numbers} → [LLM] → sentence (await fine)
```

Anchor: *"stream when a human reads partials; await when a machine parses
the whole — flattr's parse seam needs await, the describe seam doesn't
care."*

## See also

- [04-structured-outputs.md](04-structured-outputs.md) — why structured output is awaited.
- [03-sampling-parameters.md](03-sampling-parameters.md) — temp 0 on both calls.
- [09-user-override-locks.md](09-user-override-locks.md) — the parse must not clobber userMax.
