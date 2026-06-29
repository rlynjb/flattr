# 04 — Token budgeting and context window management

*Industry name(s): "token budgeting," "context window management,"
"lost-in-the-middle," "prefix caching." Type label: Industry standard.*

> **Seam, not present.** flattr counts no tokens because it makes no LLM
> calls. But its payloads are unusually instructive: the Seam 1 context is
> *three numbers* (`RouteSummary`), and the lurking danger is `Edge.geometry`
> (`features/routing/types.ts:14`) — a polyline that, if naively stuffed into
> a prompt, blows the budget. This file teaches budgeting against both.

## Zoom out — where the token budget gets spent

Every prompt fits inside a context window, and every section of it costs
tokens. Budgeting is allocating that fixed window across the four sections
before you hit the wall. Here's flattr's payload, sized.

```
  Zoom out — token cost by section at Seam 1

  ┌─ CONTEXT WINDOW (e.g. 200k tokens) ─────────────────────────────┐
  │ ┌─ system (constant) ──┐  ~150 tok   cached prefix              │
  │ ┌─ few-shot (constant) ┐  ~120 tok   cached prefix              │
  │ ┌─ context (per-call) ─┐  ★ TINY: 3 numbers ≈ 20 tok ★          │
  │ ┌─ DANGER ─────────────┐  Edge.geometry polyline = HUNDREDS     │
  │ │ if you stuff geometry │  of [lat,lng] pairs if added naively  │
  │ └───────────────────────┘                                       │
  │ ┌─ response budget ────┐  reserve ~100 tok for the one sentence │
  │ └───────────────────────────────────────────────────────────────┘
  └──────────────────────────────────────────────────────────────────┘
```

flattr's honest situation: the *intended* payload is microscopic, but the
graph data sitting one field away is enormous. Budgeting is knowing which is
which.

## Zoom in

The pattern: **count tokens for every section, allocate the window
deliberately (system + retrieved + history + response), keep the stable parts
at the front for prefix caching, and never cross 80% utilization.** The 80%
rule is the load-bearing one: above it, you're one model change or one verbose
input away from truncation.

## The structure pass

**Layers:** stable prefix → per-call payload → reserved response.
**Axis:** *cost* — tokens (= latency = dollars) per unit of work.
**Seam:** the stable/variable boundary, which is *also* the prefix-cache
boundary. Put it in the wrong place and you pay full price every call.

```
  axis = "what does this section cost, and is it cached?"

  ┌─ system + few-shot ┐ cost: paid ONCE if at front (cached)
  │  ── seam ──          ◄── cache boundary == stable/variable line
  ├─ context (per-call)┤ cost: paid every call (small for flattr)
  └─ response ─────────┘ cost: paid every call, you reserve for it
```

## How it works

### Move 1 — the mental model

You already budget bytes. You know not to ship a 3MB hero image, you know a
`SELECT *` that drags 200 columns over the wire is a mistake, you size your
API responses. Tokens are the same resource discipline, just on the prompt.
The context window is the payload size limit; token budgeting is `Content-
Length` planning for a prompt. flattr's `RouteSummary` is the lean
`SELECT distanceM, climbM, steepCount`; dumping `Edge.geometry` is the
`SELECT *`.

```
  Pattern — the budget as a fixed jar you fill in priority order

  WINDOW = [████████████████████████████████████████] 200k
            │system│few-shot│ context │   (free)    │response│
            └ cached prefix ┘└ per-call┘             └reserved┘
                                  ▲
                        flattr's context = 3 numbers ≈ 20 tok
                        DON'T let Edge.geometry leak in here
```

### Move 2 — budgeting the two seams

**Step 1 — count the tokens you actually send.** Seam 1's context is
literally:

```ts
// the real fields — features/routing/summary.ts:5
{ distanceM: 3200, climbM: 45, steepCount: 0 }
```

Serialized as `distance_m=3200 climb_m=45 steep_count=0`, that's ~15–20
tokens. You can hold the entire per-call payload in your head. This is the
*best* place to learn budgeting precisely because it's so small that any bloat
is obvious.

**Step 2 — find the thing that would blow the budget.** It's one field away:

```ts
// features/routing/types.ts:14 — the danger field
geometry: [number, number][]; // [lat, lng] polyline
```

A route crosses dozens of edges; each `geometry` is a list of coordinate
pairs. Serialize the full path geometry into a prompt "so the model has
context" and you've turned a 20-token payload into thousands. The route that
works on a 3-block walk truncates or times out on a cross-town route — the
classic "worked on small inputs, broke at scale because nobody counted." The
fix: send the *summary*, not the geometry. Retrieval-as-compression — you
already derived the three numbers; send those.

**Step 3 — keep the stable parts at the front (prefix caching).** System +
few-shot are constant (concept 01). Put them first and providers cache that
prefix across calls — you pay to process it once, not every request. The
ordering from concept 01 (constant sections first) is *also* the
cost-optimal ordering. Two reasons, one layout.

```
  Layers-and-hops — prefix caching across two calls

  call 1: [system+fewshot CACHED][ctx A] ──► provider processes all
  call 2: [system+fewshot HIT  ][ctx B] ──► provider skips prefix
          └── same bytes, processed once ──┘  cheaper + faster
```

**Step 4 — respect lost-in-the-middle.** Even when everything fits, content
in the *middle* of a long prompt is attended worst. flattr's payload is too
small for this to bite today — but the moment Seam 2 grows retrieval ("here
are 8 candidate destinations"), the relevant one must not be buried in the
middle. Put the most important context at the start or end.

**Step 5 — the 80% rule.** If a prompt uses >80% of the window, it's fragile:
a model swap with a different tokenizer, or one verbose user input, tips it
over. flattr at 20 tokens is at ~0.01% — nowhere near. But the *discipline* is
to compute the ratio and refuse to design at 95%.

### Move 2 variant — load-bearing skeleton

Kernel: **count + reserve response budget**. What breaks:

- **Don't count** → you discover the limit by truncation in production.
  *Load-bearing.*
- **Don't reserve response budget** → the prompt fills the whole window and
  the model has no room to answer; output gets cut mid-sentence. *Load-
  bearing — people forget the response needs room too.*
- **Ignore prefix caching** → still correct, just costs more. *Hardening.*
- **Ignore lost-in-the-middle** → fine until you add retrieval. *Hardening
  for flattr today.*

### Move 3 — the principle

Token counting is hygiene, not optimization. The professional computes the
budget before designing the prompt; the amateur learns it from a truncation
incident. flattr's tiny payload makes it easy — which is exactly why it's the
right place to build the habit.

## Primary diagram

```
  flattr's token budget — the lean payload and the trap (FUTURE)

  ┌─ WINDOW ────────────────────────────────────────────────────────┐
  │ [system ~150][few-shot ~120]  ← cached prefix, front, stable     │
  │ [context: distance/climb/steep ≈ 20 tok]  ← per-call, TINY       │
  │ [reserve ~100 for the one-sentence answer]                       │
  │                                                                   │
  │ ✗ NEVER: [Edge.geometry polyline ×N edges = thousands of tok]    │
  │   → send the RouteSummary, not the path coordinates              │
  └──────────────────────────────────────────────────────────────────┘
   utilization ≈ 0.2%  → miles below the 80% line. Stay there.
```

## Elaborate

Lost-in-the-middle comes from the Liu et al. "Lost in the Middle" paper and is
replicated across providers; prefix caching is an Anthropic/OpenAI feature
with the same shape (cache the stable front). The deeper move — retrieval as
context compression — is the same instinct as flattr's pipeline already
precomputing `RouteSummary` instead of recomputing over the graph at request
time: derive the small thing once, pass the small thing. The reader has
shipped this exact compression in AdvntrCue's RAG (retrieve relevant chunks,
don't stuff the corpus). Read `05-eval-driven-iteration.md` next — token cost
per call is a metric the eval set should track alongside quality.

## Interview defense

**Q: "Your chain worked in dev and timed out in prod. First thing you check?"**
Token count. Something in the per-call payload scales with input size and
nobody counted it. In a flattr-shaped system it'd be `Edge.geometry` — a
polyline that's tiny for a 3-block route and thousands of tokens for a
cross-town one. Fix: send the derived `RouteSummary` (3 numbers), never the
raw geometry.

```
  3-block route:  geometry ≈ 40 pairs   → fits
  cross-town:     geometry ≈ 900 pairs  → truncates ✗
  fix: send RouteSummary{3 nums} either way ✓
```

**Q: "What's the 80% rule?"** Above 80% window utilization you're one model
change or one verbose input from breaking. Design with headroom; compute the
ratio before you ship.

Anchor: *"flattr's intended payload is 20 tokens — but the danger field is one
hop away in `types.ts:14`. Budgeting is knowing the difference."*

## See also

- [01-anatomy.md](01-anatomy.md) — section order is also cache order
- [02-structured-outputs.md](02-structured-outputs.md) — schemas keep output
  bounded
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — track cost
  per call
- `.aipe/study-performance-engineering/` — tokens as latency + dollar budget
</content>
