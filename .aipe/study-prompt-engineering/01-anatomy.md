# 01 · Anatomy of a production prompt

> Industry name: prompt structure / message-role composition · Type label: Industry standard

> **Status: seam, not feature.** flattr sends no prompts. This file maps the four sections onto the prompt flattr *would* assemble at Seam 1 (`features/routing/summary.ts`), anchored to real types.

## Zoom out — where this concept lives

A prompt isn't one string. It's four sections with different lifetimes, and the whole discipline starts with not mixing them up. Here's where the prompt would sit in flattr if Seam 1 existed:

```
  Zoom out — the "describe my route" prompt, in context

  ┌─ Runtime (routing) ──────────────────────────────────────────┐
  │  astar.ts  →  routeSummary(graph, path, userMax)             │
  │                         │  RouteSummary {distanceM,climbM,    │
  │                         │    steepCount} + Path.steepEdges    │
  └─────────────────────────┼────────────────────────────────────┘
                            │  structured object
  ┌─ Prompt assembly (SEAM 1) ▼──────────────────────────────────┐
  │  ┌──────────────┐  ★ THIS FILE: the four sections ★          │ ← we are here
  │  │ system       │  who the model is, output contract         │
  │  │ context      │  ← the RouteSummary goes HERE              │
  │  │ few-shot     │  2-3 example route descriptions           │
  │  │ user message │  "describe this route"                    │
  │  └──────────────┘                                            │
  └─────────────────────────┬────────────────────────────────────┘
                            │  HTTP
  ┌─ Provider ──────────────▼────────────────────────────────────┐
  │  LLM → "Mostly flat, 2.1km, one short climb near the bridge" │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **a prompt is a struct with four named fields, and each field has a different rate of change.** Get the fields confused and your prompt drifts — which is the single most common way prompt-dependent features rot. Let me build the struct.

## Structure pass

**Layers.** Three nested levels in the assembled prompt: the *envelope* (which message role each chunk goes in — system vs user), the *sections* (the four logical blocks), and the *tokens* (the actual text). Confusion happens when people edit at the token level without respecting the section they're editing.

**Axis — lifecycle (rate of change).** Hold one question across the sections: *how often does this text change?*

```
  One axis — "how often does this section change?" — across the four sections

  ┌─ system prompt ──────────────┐   → changes per DEPLOY    (constant)
  └──────────────────────────────┘
      ┌─ few-shot examples ──────┐   → changes per DEPLOY    (constant)
      └──────────────────────────┘
          ┌─ context injection ──┐   → changes per CALL      (the RouteSummary)
          └──────────────────────┘
              ┌─ user message ───┐   → changes per CALL      (the request)
              └──────────────────┘

  the answer flips between example #2 and #3 — that's the seam
```

**Seam.** The load-bearing boundary is *between constant and per-call*. System prompt + few-shot examples are baked at deploy time; context + user message are filled at request time. This boundary is exactly the one prefix caching exploits (see `04-token-budgeting.md`) and exactly the one that injection attacks try to blur (see `12-prompt-injection-defense.md`). Everything constant goes first; everything per-call goes last.

## How it works

### Move 1 — the mental model

You already know this shape. A React component has props that are constant for the component's definition and props that change per render. A prompt is the same: the system prompt and examples are the *definition*, the context and user message are the *per-render props*. Same split, different surface.

```
  The four-section prompt — the kernel shape

  ┌─────────────────────────────────────────────────┐
  │ 1. SYSTEM    role + output contract              │ constant
  │    "You describe walking routes for a            │ (deploy-time)
  │     grade-aware router. Be concrete. ≤2 sentences"│
  ├─────────────────────────────────────────────────┤
  │ 2. FEW-SHOT  2-3 example (input,output) pairs    │ constant
  │    {distanceM:1200,climbM:8,...} → "Flat, 1.2km" │ (deploy-time)
  ├─────────────────────────────────────────────────┤
  │ 3. CONTEXT   the data for THIS call              │ per-call
  │    <route>{distanceM:2100,climbM:14,steepCount:1}│ (request-time)
  │            steepEdges:["e44"]</route>            │
  ├─────────────────────────────────────────────────┤
  │ 4. USER      the instruction for THIS call       │ per-call
  │    "Describe this route in one sentence."        │ (request-time)
  └─────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**System prompt — who the model is and what it must emit.** This is the constant frame. In a React component, this is the part of the JSX that never depends on props. For flattr's Seam 1, the system prompt names the role ("you describe walking routes for a grade-aware router") and the output contract ("one sentence, no markdown, mention the climb only if `climbM > 10`"). It changes when you *deploy a new version of the feature*, never per request.

```
  Hop: structured object → system-prompt frame

  ┌─ Runtime ────────┐  RouteSummary    ┌─ Prompt assembly ──────┐
  │ routeSummary()   │ ───────────────► │ system: role + contract│
  │ returns struct   │   (per call)     │ (constant — not the    │
  └──────────────────┘                  │  struct, the FRAME)    │
                                        └────────────────────────┘
```

The thing to anchor: the system prompt does NOT contain the route. It contains the *rules for describing any route*. The route arrives in section 3.

**Context injection — the per-call data.** This is where flattr's real structured output goes. Here's the actual type that would be templated in:

```ts
// features/routing/summary.ts:5
export type RouteSummary = {
  distanceM: number;      // → "2.1km"
  climbM: number;         // → "one climb" (only if > threshold)
  steepCount: number;     // → "one short steep stretch you flagged"
};
// plus, from features/routing/types.ts:36
// Path.steepEdges: string[]   ← the edge IDs that exceeded userMax
```

`distanceM`, `climbM`, and `steepCount` are three numbers and one array. You template them into the context section wrapped in a delimiter (`<route>...</route>`) — the delimiter matters for injection defense, covered in `12`. The key discipline: **the context section is data, not instructions.** The system prompt says "describe the route below"; the context section *is* the route. Mixing a stray instruction into the context section ("...and make it sound exciting") is exactly how prompts drift.

**Few-shot examples — constant, between system and context.** Two or three `(RouteSummary → sentence)` pairs that pin the output format. flattr already has the perfect source for these: the golden graphs in `features/routing/fixtures.ts:46` (`diamondGraph`, `gradeGraph`, `directionalGraph`) produce known routes, so you can compute real `RouteSummary` objects and hand-write the ideal sentence for each. Full treatment in `08-few-shot.md`. They live *with* the system prompt (constant) — not with the context (per-call). Putting an example in the per-call slot means it gets re-sent and re-billed every request and breaks prefix caching.

**User message — the per-call instruction.** "Describe this route." Short. The user message is *not* where the data goes (that's context) and *not* where the rules go (that's system). In a single-purpose chain like this, the user message is almost boilerplate — the work is in the system prompt and the context.

### Move 3 — the principle

A prompt is a struct with four fields and two lifetimes. The discipline is: **one job per section, named explicitly, constant-before-per-call.** When a prompt fails 5% of the time and you can't figure out why, nine times out of ten someone put a per-call instruction in the system prompt or a constant rule in the user message, and the two lifetimes started fighting. Keep the sections clean and the failures become legible.

## Primary diagram

The full Seam 1 prompt, assembled, with every section's lifetime and source labeled.

```
  "Describe my route" — the assembled prompt, sources and lifetimes

  ┌─ Runtime (routing) ──────────────────────────────────────────┐
  │ routeSummary(graph, path, userMax)  →  RouteSummary           │
  │   {distanceM, climbM, steepCount}  +  Path.steepEdges         │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ per-call
  ┌─ Prompt assembly (Seam 1) ────▼──────────────────────────────┐
  │ ┌────────────────────────────────────────────────┐ constant  │
  │ │ SYSTEM   role + output contract (≤1 sentence)   │ (deploy)  │
  │ ├────────────────────────────────────────────────┤ constant  │
  │ │ FEW-SHOT 2-3 pairs from fixtures.ts golden set  │ (deploy)  │
  │ ├═══════════════════ caching seam ════════════════┤           │
  │ │ CONTEXT  <route>{the RouteSummary struct}</route>│ per-call  │
  │ ├────────────────────────────────────────────────┤ per-call  │
  │ │ USER     "Describe this route in one sentence." │ per-call  │
  │ └────────────────────────────────────────────────┘           │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ HTTP
  ┌─ Provider ────────────────────▼──────────────────────────────┐
  │ LLM → "Mostly flat, 2.1km — one short climb you flagged."     │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The four-section model is the lowest common denominator across providers. Anthropic and OpenAI both expose `system` and `user`/`assistant` roles; few-shot examples are conventionally encoded as prior `user`/`assistant` turns rather than a literal "examples" field. Anthropic's prompt guide leans on XML-style delimiters (`<route>`) for the context section, which is why I used them above — they make the data/instruction boundary explicit to the model and they're the cheapest injection defense you get for free. The deeper reason to keep sections clean is everything downstream: prefix caching (`04`) needs the constant prefix stable, evals (`05`) need to diff one section at a time, and injection defense (`12`) needs the data section to be unambiguously data.

## Project exercises

### EX-ANATOMY-1 — Build the Seam 1 prompt assembler

- **Exercise ID:** EX-ANATOMY-1
- **What to build:** A pure function `buildRouteDescriptionPrompt(summary: RouteSummary, steepEdges: string[]): Messages` that assembles the four sections, with system + few-shot constant and context + user per-call.
- **Why it earns its place:** Forces you to physically separate the two lifetimes in code, which is where the discipline becomes real instead of theoretical.
- **Files to touch:** new `features/routing/describe-prompt.ts`; import `RouteSummary` from `summary.ts`, `Path` from `types.ts`.
- **Done when:** the constant sections are module-level constants and the per-call sections are function arguments — verifiable by reading the file.
- **Estimated effort:** 1-2 hours.

## Interview defense

**Q: What are the four sections of a production prompt and why does the order matter?**

System, few-shot examples, context injection, user message. Order matters because the first two are constant (deploy-time) and the last two are per-call (request-time), and providers cache the constant prefix — so constant-before-per-call is what makes caching work.

```
  ┌ system ┐┌ few-shot ┐│┌ context ┐┌ user ┐
  └────────┘└──────────┘│└─────────┘└──────┘
   constant prefix      │  per-call suffix
   (cacheable)      cache seam
```

Anchor: in flattr's Seam 1, the `RouteSummary` from `summary.ts:5` is the *context* section — per-call — never the system prompt.

**Q: What's the most common way this anatomy gets violated?**

A per-call instruction sneaking into the system prompt, or vice versa. The two lifetimes start fighting and the prompt fails intermittently. The fix is the decomposition rule: one job per section, named explicitly.

## See also

- `02-structured-outputs.md` — the `RouteSummary` as a typed contract
- `04-token-budgeting.md` — why constant-before-per-call enables prefix caching
- `08-few-shot.md` — filling the few-shot section from `fixtures.ts`
- `12-prompt-injection-defense.md` — why the context section must be unambiguously data
