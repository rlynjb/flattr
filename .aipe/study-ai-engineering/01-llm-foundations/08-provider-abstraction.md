# Provider Abstraction
*Provider abstraction / adapter pattern — Language-agnostic*

## Zoom out

The moment you call more than one model — or expect to swap one — you put an interface between your app and the provider SDK. A factory returns "a thing that takes a prompt and returns text," and OpenAI vs Anthropic vs on-device becomes a config detail. You built exactly this seam in AdvntrCue; flattr has none, but the spot it would live is obvious.

```
LAYERS — the interface hides the vendor
┌──────────────────────────────────────────────┐
│ app code ─► narrate(prompt): Promise<string>    │ ◄── one stable interface
│                  │                               │
│        ┌─────────┼──────────┐                    │
│        ▼         ▼          ▼                     │
│   OpenAI    Anthropic   on-device                │ ◄── swappable behind it
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** Define one narrow interface your app depends on (`complete(prompt) → string`, maybe with options). Each provider gets an adapter implementing it. A factory picks the adapter from config. Your feature code never imports a vendor SDK directly — it imports the interface. Swapping providers, A/B-ing models, or falling back when one is down becomes a one-line change, not a refactor.

```
PATTERN — adapter behind a factory
  makeNarrator(cfg) ─► returns Narrator
     cfg.provider="anthropic" ─► AnthropicAdapter ┐
     cfg.provider="openai"    ─► OpenAIAdapter     ├─ all : Narrator
     cfg.provider="local"     ─► LocalAdapter      ┘
  feature code only ever sees `Narrator`.
```

**Move 2 — the mechanism.** The interface is the contract; adapters translate it to each SDK's shape (auth, request body, response parsing, error mapping). Normalize the messy parts — error types, token-usage fields, stop reasons — so callers see one consistent surface. The factory is just a switch over config that returns the right adapter. This is the adapter pattern; nothing AI-specific about it except that the implementations are flaky network calls you'll want to wrap with timeouts and retries.

```
MECHANISM — translation layer
  narrate(prompt)
      │  AnthropicAdapter
      ▼
  POST /v1/messages {…}  ─► parse ─► normalized string
      (auth, retries, error-mapping all live in the adapter)
```

**Move 3 — principle.** Depend on an interface you own, not an SDK someone else versions; the provider should be a config value.

## In this codebase

**Not yet exercised in flattr.** No providers, no SDKs, no abstraction — there's nothing to abstract over. If narration were added, the right home is a new `features/routing/narrate.ts` exposing something like `narrate(summary: RouteSummary): Promise<string>`, consuming the struct from `features/routing/summary.ts:11` and hiding whichever provider behind that one function. You've already built this seam in AdvntrCue (pgvector + GPT-4), so the pattern transfers directly — flattr just hasn't needed a single model yet, let alone two.

## See also
- [01 — What an LLM is](01-what-an-llm-is.md)
- [07 — Heuristic before LLM](07-heuristic-before-llm.md)
