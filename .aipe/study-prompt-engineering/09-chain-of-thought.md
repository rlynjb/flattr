# 09 — Chain-of-thought (CoT)

*Industry name(s): "chain-of-thought," "CoT," "step-by-step reasoning,"
"reasoning traces." Type label: Industry standard.*

> **Seam, not present.** flattr does no reasoning prompts. But it has a
> genuinely multi-step decision — the signed directed-grade cost in
> `features/routing/cost.ts:16` (`penalty()`: flat→0, moderate→linear,
> steep→quadratic, over-max→BLOCKED) — which is exactly the kind of judgment
> where CoT helps a weak model and is wasted on a strong one. This file
> teaches CoT against that.

## Zoom out — where CoT would and wouldn't sit

Chain-of-thought is asking the model to reason step-by-step before answering.
It helps multi-step problems and *hurts* simple ones by burning tokens. flattr
has both kinds, so it's a clean place to draw the line.

```
  Zoom out — CoT helps at one seam, wastes tokens at another

  ┌─ Seam 2: parse "flat near water" → {lat,lng} ───────────────────┐
  │  multi-step judgment → CoT HELPS (esp. cheap models)            │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ Seam 1: RouteSummary → one-line description ───────────────────┐
  │  near-lookup, structured → CoT WASTES tokens                   │
  └──────────────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: **prompt the model to show its reasoning before the answer; the
intermediate steps improve accuracy on multi-step problems.** When it helps:
genuine multi-step reasoning. When it hurts: simple lookups and structured
classifiers, where the reasoning is pure token waste. The modern caveat:
frontier models do CoT internally now, so asking explicitly matters less than
it did — but it still helps cheaper models, and flattr would route a cheap
model to the classifier step (concept 06).

## The structure pass

**Layers:** the question → the reasoning → the answer.
**Axis:** *step count* — how many inferential hops to the answer?
**Seam:** the lookup/reasoning boundary — below it CoT wastes tokens, above it
CoT earns them.

```
  axis = "how many reasoning steps to the answer?"

  ┌─ 1 step (lookup) ──┐ CoT value: NEGATIVE — wastes tokens
  │  ── seam ──            ◄── value flips at multi-step
  └─ N steps (reason) ─┘ CoT value: POSITIVE — improves accuracy
```

## How it works

### Move 1 — the mental model

You know the difference between a value you can read off a map (`graph.nodes[id]`
— one lookup) and a value you have to *compute* through stages
(`penalty()` — branch on the band, then apply the right formula). CoT is asking
the model to do the staged version out loud. For a lookup it's overhead; for a
staged decision it's the difference between right and wrong on a weak model.

```
  Pattern — CoT inserts reasoning before the answer

  WITHOUT: question ─────────────────────► answer  (weak model may skip steps)
  WITH:    question ─► step1 ─► step2 ─► step3 ─► answer  (steps force the work)
```

### Move 2 — where CoT helps and where it doesn't, in flattr

**Step 1 — the multi-step decision CoT would help (cost logic at Seam 2).**
flattr's real penalty function is genuinely staged:

```ts
// features/routing/cost.ts:16-22 — EXISTS
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;                       // step 1: flat/downhill → free
  if (g > max) return BLOCKED;                // step 2: over max → blocked
  const half = 0.5 * max;
  if (g <= half) return k1 * g;               // step 3: moderate → linear
  return k2 * (g - half) ** 2 + k1 * half;    // step 4: steep → quadratic
}
```

If an LLM at Seam 2 had to *explain a route's difficulty* ("why is this route
rated hard?"), it'd reason through these same bands. A weak model asked for the
answer directly might skip the over-max check; asked to reason step-by-step, it
walks the bands and gets it right. That's CoT earning its tokens.

**Step 2 — the lookup where CoT wastes tokens (Seam 1 description).** "Turn
{d=3200, climb=45, steep=0} into a sentence" is near-lookup — there's no
multi-step reasoning, just formatting. Adding "think step by step" here makes
the model emit a paragraph of reasoning you throw away, doubling token cost
(concept 04) for zero accuracy gain. flattr's tiny structured payload is
exactly the case where CoT is pure waste.

**Step 3 — the structured-output interaction (the trap).** If you want *both*
reasoning AND a structured answer, the reasoning does NOT go in free-form prose
before the JSON — that breaks the parser (concept 07). It goes in a `thinking`
field *inside* the schema:

```
  // FUTURE — reasoning inside the schema, not before it
  schema = z.object({
    thinking: z.string(),        // ← reasoning lives HERE
    difficulty: z.enum(["flat","moderate","hard"]),
  })
```

```
  Layers-and-hops — CoT routed correctly across flattr's two seams

  ┌─ Seam 2 (reason) ─┐ "think then answer"  ┌─ small model ─┐ +accuracy
  │ explain difficulty│ ───────────────────► │ walks bands   │
  └───────────────────┘                      └───────────────┘

  ┌─ Seam 1 (lookup) ─┐ NO "think step by step"  ┌─ model ──┐ saves tokens
  │ format summary    │ ───────────────────────► │ one line │
  └───────────────────┘                          └──────────┘
```

### Move 2 variant — load-bearing skeleton

Kernel: **route CoT by step count**. What breaks:

- **CoT on a lookup** → doubled token cost, zero gain. *Anti-pattern.*
- **No CoT on a weak model's multi-step task** → it skips a step (the over-max
  check) and answers wrong. *Load-bearing for weak models.*
- **Reasoning in free prose before structured output** → parser breaks
  (concept 07). *The trap — reasoning goes in a `thinking` field.*

### Move 3 — the principle

CoT trades tokens for reasoning depth. Spend it only where the answer takes
multiple inferential steps and the model is weak enough to skip one. On
frontier models and on lookups, it's overhead. And if you need reasoning
alongside structured output, the reasoning lives inside the schema.

## Primary diagram

```
  Chain-of-thought routing in flattr (FUTURE)

  step count ───────────────────────────────────────────────────────►
  │ 1 (lookup)                    │ N (multi-step)                   │
  │ Seam 1: summary → sentence    │ Seam 2: explain route difficulty │
  │ CoT = wasted tokens ✗         │ CoT = +accuracy on weak model ✓  │
  │                               │ reasoning → thinking field, then  │
  │                               │ {difficulty} (concept 02/07)     │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

CoT comes from Wei et al. ("Chain-of-Thought Prompting Elicits Reasoning") and
self-consistency (concept 10) built on it. The 2026 reality: reasoning models
(Anthropic extended thinking, OpenAI o-series) do CoT internally, so explicit
"think step by step" is largely redundant on frontier tiers — but flattr's
chain would route a *cheap* model to classifier steps (concept 06), and cheap
models still benefit. The `thinking`-field pattern is how Anthropic's own
guidance reconciles reasoning with structured output. Read `10-self-critique.md`
next — it's CoT pointed at the model's own output.

## Interview defense

**Q: "When does chain-of-thought hurt?"** On lookups and structured
classifiers — it burns tokens for reasoning you throw away. flattr's Seam 1
(format three numbers into a sentence) is a lookup; "think step by step" there
doubles cost for zero gain. CoT earns its tokens only when the answer takes
multiple inferential steps and the model is weak enough to skip one.

```
  lookup   → CoT = wasted tokens
  multi-step on weak model → CoT = caught the skipped over-max check
```

**Q: "You want reasoning AND structured JSON. How?"** Reasoning in a
`thinking` field inside the schema — never free prose before the JSON, which
breaks the parser (concept 07).

Anchor: *"flattr's `penalty()` in `cost.ts:16` is a genuine four-band staged
decision — that's where CoT helps a weak model. The Seam 1 description is a
lookup — CoT there is pure waste."*

## See also

- [10-self-critique.md](10-self-critique.md) — CoT aimed at self-evaluation
- [02-structured-outputs.md](02-structured-outputs.md) — the `thinking`-field
  pattern
- [04-token-budgeting.md](04-token-budgeting.md) — CoT's token cost
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — cheap models per
  step still want CoT
</content>
