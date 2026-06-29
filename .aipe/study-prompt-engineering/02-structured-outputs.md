# 02 — Structured outputs via tool calling and schemas

*Industry name(s): "structured outputs," "tool calling," "function calling,"
"JSON mode," "constrained decoding." Type label: Industry standard.*

> **Seam, not present.** flattr never asks a model for JSON. But it already
> has the thing structured outputs produce: typed structs validated at a
> boundary. `RouteSummary` (`features/routing/summary.ts:5`) and the geocode
> result (`pipeline/geocode.ts:3`) are exactly the shapes a structured-output
> prompt would target. This file teaches the pattern against them.

## Zoom out — where the schema sits at both seams

Structured output is the discipline of making the model emit data your code
can parse, every time, instead of prose you regex. It sits at the boundary
between the model and your typed code. flattr has two such boundaries.

```
  Zoom out — the schema boundary at flattr's two seams

  ┌─ Engine (typed TS, exists) ─────────────────────────────────────┐
  │  type RouteSummary = {distanceM; climbM; steepCount}  (out)      │
  │  type GeocodeResult = {lat; lng; label}              (in target) │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ the schema IS this type
  ┌─ Model boundary (future) ─────▼──────────────────────────────────┐
  │   ┌──────────────────────────────────────────────────────────┐  │
  │   │ ★ STRUCTURED OUTPUT ★  declare schema → provider enforces  │  │
  │   │   → validate parse → retry on schema-fail                  │  │
  │   └──────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
```

The schema isn't a new thing to invent — flattr's TypeScript types already
*are* the schema. You'd express them as Zod or JSON Schema and hand them to
the provider.

## Zoom in

The pattern: **declare the output shape as a schema, let the provider enforce
it during decoding, validate the parse at your boundary anyway, and retry with
a stricter system prompt when validation fails.** All four steps. The blog-post
version is step one — "use JSON mode." The production version is all four,
plus logging the schema-fail rate to a dashboard.

## The structure pass

**Layers:** prompt asks → provider decodes → your code validates.
**Axis:** *guarantee* — how sure am I the output is the right shape?
**Seam:** the provider→your-code boundary, where best-effort meets must-be-true.

```
  axis = "is the output guaranteed to be the right shape?"

  ┌─ prompt text ────┐  guarantee = NONE ("please return JSON" ≠ promise)
  ├─ provider schema ┤  guarantee = STRONG (constrained decoding)
  │  ── seam ──        ◄── still validate! provider bugs + fences exist
  └─ your validator ──┘  guarantee = ABSOLUTE (you throw if wrong)
```

The lesson hides in that seam: even with provider-enforced schema mode, you
validate again on your side. I've been burned by courteous models wrapping
schema-valid JSON inside a markdown fence "to be helpful." The provider
thought it returned JSON; my parser saw ` ```json `.

## How it works

### Move 1 — the mental model

You know `JSON.parse(await res.json())` and you know the sinking feeling when
the server returns HTML instead and it throws. Structured output is moving
that contract *upstream*: instead of hoping the model returns parseable text
and catching the throw, you tell the provider the exact shape and it
constrains its own token sampling to produce only that shape. It's the
difference between `response.json()` praying, and a typed RPC where the wire
format can't be wrong.

```
  Pattern — structured output as a constrained funnel

   free-token space  ────────────►  all possible strings
        │
        │  schema constrains decoding
        ▼
   ┌──────────────────────┐
   │ only strings that     │  ◄── provider rejects tokens that
   │ match the schema      │      would break the shape
   └──────────┬───────────┘
              │ validate again on your side
              ▼
   typed value your code trusts (RouteSummary)
```

### Move 2 — the four steps against flattr's types

**Step 1 — declare the schema (your existing type, as Zod).** flattr's type
is already the contract:

```ts
// EXISTS — features/routing/summary.ts:5
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };

// FUTURE — the same shape, expressed for the provider
const RouteSummarySchema = z.object({
  distanceM:  z.number(),
  climbM:     z.number(),
  steepCount: z.number().int().nonnegative(),
});
```

The Zod object is mechanically the TS type with runtime teeth. That `int()`
and `nonnegative()` are guarantees the bare TS type can't enforce — and a
model *will* hand you `steepCount: 2.0000001` or `-1` if you let it.

**Step 2 — let the provider enforce.** You pass the schema to the call (as a
tool definition or `response_format`). The provider constrains decoding so the
returned tokens match. This is the part the blog posts stop at.

**Step 3 — validate at the boundary anyway.** Here's the production code that
the blog posts skip:

```
  // FUTURE — never trust the parse, even in schema mode
  raw = await callModel(prompt, RouteSummarySchema)
  stripped = stripMarkdownFences(raw)        // the courtesy-fence defense
  result = RouteSummarySchema.safeParse(stripped)
  if (!result.success) {
     metrics.increment("route_summary.schema_fail")   // ← log the rate
     return retryWithStricterPrompt(prompt)           // step 4
  }
  return result.data                          // now it's a real RouteSummary
```

**Step 4 — retry with a stricter system prompt on fail.** On a schema fail,
re-call with an appended line: "Return ONLY the JSON object. No prose, no code
fences." One retry catches the vast majority. Two retries then hard-fail and
alert.

```
  Layers-and-hops — the validate-and-retry loop at the model seam

  ┌─ your code ──┐ hop1: prompt+schema  ┌─ provider ──┐
  │ caller       │ ───────────────────► │ decode      │
  │              │ hop2: JSON (maybe     │ (enforced)  │
  │              │   fenced) ◄────────── └─────────────┘
  │ validate ────┤
  │   ok? ──────────► return RouteSummary
  │   fail? ─────hop3: retry w/ stricter system ──► (back to provider)
  └──────────────┘
```

### Move 2 variant — load-bearing skeleton

Kernel: **schema + boundary validation**. What breaks if you drop each:

- **Drop the schema** → you're back to "respond only in JSON" in prose, which
  is *not how this is done in 2026*; the model freelances and your parse
  throws intermittently. *Load-bearing.*
- **Drop boundary validation** → the fence bug ships to prod; works in the
  demo, breaks the day a model upgrade makes the model chattier. *Load-bearing
  — this is the one people skip.*
- **Drop the retry** → still correct, just less resilient; a transient
  schema-fail becomes a user-visible error. *Hardening.*
- **Drop the metric** → you lose your early-warning signal for model drift.
  *Hardening, but the cheapest insurance you'll ever buy.*

### When to NOT use structured output

For Seam 1's *prose* description ("A flat 3.2 km route…"), the output is
open-ended generation — you do NOT force a schema on it; that's concept 09's
"reasoning in a thinking field" trap inverted. Structured output is for the
*classifier-shaped* seams: parsing the NL destination at Seam 2 into
`{lat, lng}` args, or extracting a route's facts. Open-ended creative text:
no schema. Anything your code branches on: schema.

### Move 3 — the principle

A schema turns a best-effort text generator into a typed function at the call
boundary — but only if you validate on your side too. The provider's
guarantee is strong, not absolute, and the gap is where the fence bug lives.

## Primary diagram

```
  Structured output at flattr's Seam 2 (NL → geocode args)

  ┌─ UI ───────┐ "somewhere flat near the water"
  │ AddressBar │ ──────────────┐
  └────────────┘               ▼
  ┌─ model seam (future) ───────────────────────────────────────┐
  │ schema = z.object({lat, lng, queryHint})                     │
  │  declare → provider enforces → strip fences → safeParse      │
  │     fail ──► retry stricter ──► fail ──► hard error + alert   │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼ validated {lat,lng}
  ┌─ engine (exists) ──────────────────────────────────────────┐
  │ geocode.ts / nearest.ts consume typed coords                │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

Tool calling, JSON mode, and `response_format` are three provider takes on
the same idea; they differ in syntax and in how strictly they constrain
(constrained decoding vs. a post-hoc check). Anthropic, OpenAI, and Google all
support it with slightly different shapes — that vendor detail belongs here in
Elaborate, not in the concept, because the *pattern* (declare → enforce →
validate → retry) survives the swap, which is exactly how flattr's own
`CostFn`/`HeuristicFn` types (`features/routing/types.ts:40,43`) abstract over
strategy. Hamel Husain and the OpenAI cookbook both hammer the same point:
the parse-and-validate step is non-optional. Read `07-output-mode-mismatch.md`
next — the failure mode when one stage's schema doesn't match the next's
expectation.

## Interview defense

**Q: "You're using JSON mode and it still broke. Why?"** The model wrapped
schema-valid JSON in a markdown code fence as a courtesy, so `JSON.parse`
choked on the backticks. JSON mode guarantees the *content* is valid JSON, not
that there's nothing around it. Fix: strip fences, then `safeParse`, then
retry with a stricter system line. And log the fail rate so a model upgrade
that increases fencing shows up as a metric, not a 3am page.

```
  provider: ```json\n{...valid...}\n```   ◄── valid JSON, unparseable wrapper
  fix:  strip fence → parse → validate → retry
```

Anchor: *"flattr's `RouteSummary` is already the schema — three numbers,
`steepCount` non-negative int. The provider enforces it; I `safeParse` it
again because I've shipped the fence bug before."*

**Q: "When would you NOT force a schema?"** The prose route description at
Seam 1 — open-ended generation. Forcing a schema on creative text either
fights the model or makes the output worse.

## See also

- [01-anatomy.md](01-anatomy.md) — the output contract lives in section 1
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — schema mismatch
  across stages
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — schema-fail
  rate as an eval metric
- `.aipe/study-security/` — output validation as a trust boundary
</content>
