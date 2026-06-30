# 04 · Token budgeting and context window management

> Industry name: token budgeting / context window management / prefix caching · Type label: Industry standard

> **Status: seam, not feature.** flattr counts no tokens because it sends no prompts. But it has a textbook token-budget trap sitting in plain sight: `Edge.geometry` is a polyline of `[lat, lng]` pairs, and a route's path can carry hundreds of them. This file maps token discipline onto Seam 1, where that geometry would tempt you into the prompt.

## Zoom out — where this concept lives

Token budgeting is the most operational concept in this folder — it's hygiene, not a trick. Here's where it bites flattr's Seam 1:

```
  Zoom out — the token budget at Seam 1 (describe my route)

  ┌─ Runtime (routing) ──────────────────────────────────────────┐
  │  Path { nodes[], edges[], cost, lengthM, steepEdges[] }      │
  │  each Edge has geometry: [lat,lng][]  ← THE TRAP             │
  └─────────────────────────┬────────────────────────────────────┘
                            │  what do you put in the prompt?
  ┌─ Prompt assembly (SEAM 1) ▼──────────────────────────────────┐
  │  ★ THIS FILE: budget the context section ★                  │ ← we are here
  │  RIGHT: {distanceM, climbM, steepCount}  ≈ 30 tokens         │
  │  WRONG: full Edge[].geometry polylines    ≈ thousands        │
  └─────────────────────────┬────────────────────────────────────┘
                            │  HTTP
  ┌─ Provider ──────────────▼────────────────────────────────────┐
  │  context window: fixed budget — system+context+history+reply │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **the context window is a fixed budget you allocate across system prompt, retrieved context, history, and the response — and you count tokens, because the thing that fits a 10-node test route blows the window on a 400-node real one.** Let me build the budget.

## Structure pass

**Layers.** Three: the *window* (the fixed total), the *allocation* (how you split it across sections), and the *position* (where in the window content sits — because attention isn't uniform). flattr's analog is its own fixed budget — the A\* search has a node-expansion cost, and `bench/` measures it. Same instinct: a fixed resource you must measure and allocate.

**Axis — cost (per unit of work).**

```
  One axis — "what does this cost per call?" — down the layers

  ┌─ window (total) ─────────────┐  → FIXED ceiling (e.g. 200k tok)
  └──────────────────────────────┘
      ┌─ allocation ─────────────┐  → YOUR CHOICE (sum must fit)
      └──────────────────────────┘
          ┌─ position ───────────┐  → ATTENTION COST (middle is cheap-attention)
          └──────────────────────┘

  the seam: scaling input flips "fits" to "truncates" — silently
```

**Seam.** The load-bearing boundary is *between the test input and the production input*. A chain that fits comfortably on `gradeGraph` (4 nodes, `fixtures.ts:70`) can truncate or time out on a real city route with hundreds of edges — *if nobody counted tokens*. The flip is silent: no error, just a truncated prompt and a worse answer.

## How it works

### Move 1 — the mental model

You know how a `fetch()` response can be 200 bytes or 2MB depending on the query, and a UI that renders fine on the small one janks on the large one? Token budgeting is that, for prompts. The same prompt template costs 30 tokens on a 4-node route and thousands on a 400-node route — and the window is a hard wall, not a slow degradation.

```
  The token-budget kernel — allocate the fixed window

  ┌─────────── context window (fixed total) ───────────┐
  │ system │ few-shot │ retrieved context │  response   │
  │  ~5%   │   ~10%   │      ~60%         │   ~25%      │
  └────────┴──────────┴───────────────────┴─────────────┘
            ▲ constant (front)            ▲ per-call (back)
            └── cacheable prefix ─────────┘
   rule: if context > 80% of window, you're one model-change
         away from breaking. Compress before you hit it.
```

### Move 2 — the step-by-step walkthrough

**Count tokens — know your tokenizer.** A token is roughly 4 characters of English; code and coordinates tokenize *worse* (more tokens per character). flattr's `Edge.geometry` is the worst case — strings of `[47.6062, -122.3321]` are dense in digits and punctuation, each of which costs tokens. You count *before* you build the prompt, not after it fails. This is basic hygiene, the line between amateur and professional prompt work: the amateur ships and discovers the limit in production; the professional counted first.

**Allocate the budget — sections get shares.** For Seam 1: system prompt (small, constant), few-shot examples (small, constant), the route context (this is the variable), response (reserve room — the model can't write a description if you left it 5 tokens). The sum must fit with margin.

**The trap — `Edge.geometry` should never enter the prompt.** Look at the actual type:

```ts
// features/routing/types.ts:10 — the Edge
export type Edge = {
  id: string;
  geometry: [number, number][];  // ← polyline: can be MANY [lat,lng] pairs
  lengthM: number;
  riseM: number;
  gradePct: number;
  absGradePct: number;
};
```

A `Path` (`types.ts:31`) carries an array of edge IDs; resolve each to its `Edge` and you've got every polyline point of the whole route. Templating *that* into "describe my route" is the rookie move — it's thousands of tokens of coordinates the model doesn't need to say "mostly flat, 2.1km." The compression is already computed for you: `routeSummary()` (`summary.ts:11`) reduces the entire path to three numbers.

```ts
// features/routing/summary.ts:5 — the compression, already done
export type RouteSummary = {
  distanceM: number;   // the whole path → 1 number
  climbM: number;      // every rise → 1 number
  steepCount: number;  // every steep edge → 1 number
};
// thousands of geometry tokens  →  ~30 tokens. This IS context compression.
```

`routeSummary` is, in token terms, a *compressor*: it takes the unbounded geometry and returns a bounded summary. That's the entire lesson of "retrieve what's relevant, don't stuff everything" — except flattr already wrote the retriever.

**Lost-in-the-middle — position matters even when it fits.** Suppose the route summary *does* fit but you also stuffed in 50 nearby POIs. Content in the *middle* of a long prompt is attended worse than content at the start or end. So the `RouteSummary` — the thing the model must actually use — goes at the *end* of the context (near the user instruction), not buried in the middle of a POI dump. Even within budget, position is a lever.

```
  Position within the window — attention is U-shaped

  ┌── start ──┬──────── middle ────────┬── end ──┐
  │ attended  │  poorly attended       │ attended│
  │ well      │  (lost in the middle)  │ well    │
  └───────────┴────────────────────────┴─────────┘
       ▲                                    ▲
   system/rules                      the RouteSummary
   (constant)                        (the thing to USE → put it here)
```

**Prefix caching — keep the stable stuff at the front.** Providers cache the static *prefix* of a prompt across calls — the longest run of identical leading tokens. So the system prompt + few-shot examples (constant, from `01-anatomy.md`) go first and get cached; the per-call `RouteSummary` goes last and breaks the cache only from that point on. This is the operational reason the anatomy's constant-before-per-call ordering isn't aesthetic — it's billing. Put one per-call token in front of the constants and you've invalidated the entire cached prefix every call.

```
  Hop — prefix caching across two calls

  call 1: [system|few-shot|]  [route A]   → cache the prefix ──┐
  call 2: [system|few-shot|]  [route B]   → prefix HIT ────────┘
          └─ identical prefix ─┘└ varies ┘
   if any per-call token sneaks before the │, both calls miss
```

**The specific failure.** A chain that worked fine on small inputs starts truncating or timing out at scale because nobody counted tokens. The classic shape: works on the demo (4-node fixture), breaks in production (real city route). The fix is upstream — count, then compress with `routeSummary` *before* assembly, never stuff raw geometry.

### Move 3 — the principle

The context window is a fixed budget; the input size is variable; therefore you count tokens and compress before you assemble. flattr hands you the compressor for free — `routeSummary` turns an unbounded path into three numbers. The discipline is to *use the summary, not the geometry*, keep constants at the front for caching, and put the must-use content at the end to dodge lost-in-the-middle. The amateur ships and finds the wall; the professional measured the budget first.

## Primary diagram

The full token budget at Seam 1 — the trap, the compressor, the positions, the cache seam.

```
  Token budget at Seam 1 — compress, allocate, position

  ┌─ Runtime ────────────────────────────────────────────────────┐
  │ Path → edges[] → Edge.geometry [lat,lng][]  ✗ DON'T send this │
  │ routeSummary(path) → {distanceM,climbM,steepCount} ✓ send this│
  └─────────────────────────┬────────────────────────────────────┘
                            │ ~30 tokens, not thousands
  ┌─ Prompt (Seam 1) ───────▼────────────────────────────────────┐
  │ ┌──────── context window (fixed) ────────────────────┐       │
  │ │ system │ few-shot ║ <route>{summary}</route> │ reply│       │
  │ │  front (cached prefix)  ║  per-call (cache seam) │    │      │
  │ │                         ║  ↑ summary at END       │    │      │
  │ │                         ║    (dodge lost-in-middle)│   │      │
  │ └─────────────────────────╨──────────────────────────┘       │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Lost-in-the-middle is a real, measured effect (the "Lost in the Middle" paper, Liu et al.) — relevant content placed mid-prompt is recalled worse than the same content at the head or tail. Prefix caching is provider-specific in pricing but universal in shape: Anthropic's prompt caching and OpenAI's automatic prefix caching both reward a stable leading prefix. The deeper connection is to RAG (from `me.md`, you shipped AdvntrCue): retrieval *is* context compression — you fetch the relevant chunks instead of stuffing the whole corpus, the same way `routeSummary` fetches the three relevant numbers instead of stuffing the whole polyline. flattr's `Edge.geometry` is the cleanest token trap I've seen in a non-LLM repo precisely because the compressor already exists next to it.

## Project exercises

### EX-TOKEN-1 — Token-count the route description prompt

- **Exercise ID:** EX-TOKEN-1
- **What to build:** A `budgetRouteDescription(path)` that counts tokens for two variants — full `Edge.geometry` vs `routeSummary` — and asserts the summary stays under a fixed budget while geometry blows it on a large grid graph.
- **Why it earns its place:** Makes the trap visceral — you watch the geometry variant cross the window on `makeGridGraph(40)` while the summary stays flat.
- **Files to touch:** new `features/routing/token-budget.ts`; uses `makeGridGraph` from `fixtures.ts:108`, `routeSummary` from `summary.ts`.
- **Done when:** the test shows geometry tokens scale with route length and summary tokens stay constant.
- **Estimated effort:** 2-3 hours.

## Interview defense

**Q: A chain works in the demo and times out in production. Token-budget diagnosis?**

The demo input was small; production input is large; nobody counted tokens, so the variable section (here, route geometry) blew the window silently. Fix is upstream: count tokens, then compress — send the summary, not the raw data.

```
  4-node fixture:  fits   ✓
  400-node route:  truncates  ✗  ← same template, scaled input
  fix: routeSummary compresses path → 3 numbers before assembly
```

Anchor: flattr's `routeSummary` (`summary.ts:11`) already compresses an unbounded `Path` to three numbers — use it, never the `Edge.geometry` polylines.

**Q: What's the 80% rule?**

If a prompt uses more than 80% of the context window in steady state, you're one model change or one larger-than-expected input away from breaking. Leave headroom; compress before you hit the ceiling.

## See also

- `01-anatomy.md` — constant-before-per-call ordering that caching depends on
- `02-structured-outputs.md` — `routeSummary` as the structured, compact context
- `07-output-mode-mismatch.md` — geometry as the wrong thing to put in either direction
- `08-few-shot.md` — examples cost tokens too; 3 good beats 20 mediocre
