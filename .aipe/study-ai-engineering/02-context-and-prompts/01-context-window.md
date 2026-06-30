# Context window — and why flattr's "context" is a struct, not a window

**Industry name(s):** context window / prompt token budget.
**Type:** Industry standard.

## Zoom out — flattr has no window to manage, because it has no prompt

flattr runs no LLM, so there is no token container to fill. But the
concept is worth holding next to flattr's one real LLM seam — the
route-describe handoff at `MapScreen.tsx:368`. The point lands by
contrast: when AI engineers fight the context window, they're fighting
*how much unstructured text fits*. flattr's "context" is three typed
numbers (`RouteSummary`), so there's nothing to fit and nothing to
budget. The window problem is a corpus problem; flattr has no corpus.

```
  Zoom out — where a context window WOULD sit (it doesn't)

  ┌─ engine (features/routing/) ────────────────────────────┐
  │  routeSummary() → { distanceM, climbM, steepCount }      │ summary.ts:5
  └────────────────────────────┬─────────────────────────────┘
                  produced at MapScreen.tsx:159
  ┌─ (NOT BUILT) LLM layer ────▼─────────────────────────────┐
  │  describeRoute(summary) → prompt → window                │
  │  ★ the window would hold ~30 tokens — no management problem│
  └────────────────────────────┬─────────────────────────────┘
                  consumed at MapScreen.tsx:368
  ┌─ UI (mobile/) ─────────────▼─────────────────────────────┐
  │  RouteSummaryCard renders the text                       │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** engine struct → (would-be) prompt → model → UI.
- **Axis — what competes for token space?** In a typical RAG app:
  system prompt, history, retrieved docs, and response space all fight
  over a fixed budget. In flattr's would-be describe call: nothing
  competes — the input is `{distanceM, climbM, steepCount}`, a
  fixed-size struct that templates to a couple dozen tokens.
- **Seam:** `MapScreen.tsx:368`. If an LLM ever sits here, the "window"
  is the templated struct plus a one-line instruction. The axis (space
  pressure) never flips into "a problem" because the input can't grow.

## How it works

### Move 1 — the mental model

You know how a fixed-size buffer works — allocate N bytes, and
everything you want to keep has to fit or get evicted? A context window
is that buffer for tokens. Everything the model sees on a call —
instructions, history, retrieved text, and the room left for its reply —
shares one fixed length. When the inputs grow past it, something gets
dropped or truncated, and that's where the management problem lives.

```
  Pattern — the context window as a fixed buffer

  ┌──────────────── window (fixed token length) ─────────────┐
  │ system │ history │ retrieved docs │ ░░░ response space ░░░│
  └──────────────────────────────────────────────────────────┘
   everything competes for the same fixed length

  flattr's case:
  ┌──────────────── window (fixed token length) ─────────────┐
  │ "Distance 1200m, climb 8m, 0 steep blocks. Describe..."   │
  │ ░░░░░░░░░░░░░░░░░░░░░ tons of room left ░░░░░░░░░░░░░░░░░░░│
  └──────────────────────────────────────────────────────────┘
   the input is a struct; it can't grow to fill the buffer
```

### Move 2 — the walkthrough

**What would fill flattr's window.** The entire prompt input is the
struct from `summary.ts:5`:

```ts
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };
```

Three numbers. Template them into one instruction line and you have a
prompt that's tens of tokens, not thousands. There is no history (each
route is stateless), no retrieved corpus (the facts are computed), and no
document stuffing. The thing AI engineers spend weeks managing — *what to
keep, what to drop* — has no analog here, because nothing variable-length
ever enters.

**Why the struct beats a window.** This is the load-bearing contrast.
A context window is the failure mode of *unstructured* context: you have
more text than fits, so you retrieve, rank, truncate, summarize. flattr
sidesteps all of it by computing the exact facts the model needs and
handing them over typed. The route facts are produced once at
`MapScreen.tsx:159` and consumed at `:368` — a fixed handoff, not a
growing buffer.

```
  Layers-and-hops — the struct handoff (no window pressure)

  ┌─ engine ──┐ hop1: RouteSummary (3 fields)  ┌─ (NOT BUILT) prompt ─┐
  │summary.ts │ ─────────────────────────────► │ template → ~30 tokens│
  └───────────┘                                 └──────────┬───────────┘
                              hop2: tiny prompt             │
  ┌─ UI ──────┐ ◄──────────────────────────────────────────┘
  │SummaryCard│  renders the model's one sentence
  └───────────┘
```

**The boundary condition.** The only way flattr ever grows a window
problem is if it stops handing the model a struct and starts handing it
raw text — for instance, feeding the geocoded `display_name`
(`geocode.ts:27`) or a long list of every edge in the path into the
prompt. Don't. The discipline is: keep the model's input a small typed
struct, and the window never becomes a problem to manage.

### Move 3 — the principle

The context window is a constraint you feel only when context is
unstructured and unbounded. The fix most teams reach for — retrieval,
truncation, summarization — is really *imposing structure on text after
the fact*. flattr starts structured: the route facts are a typed struct,
so the window is always near-empty. The principle: structure the
model's input upstream and the token-budget problem disappears.

## Primary diagram

```
  flattr's "context" is a struct, never a window

  ┌─ Core engine ───────────────────────────────────────────┐
  │ routeSummary() → RouteSummary {distanceM,climbM,steep}    │ summary.ts:5
  └────────────────────────────┬─────────────────────────────┘
              produced: MapScreen.tsx:159
  ┌─ (NOT BUILT) prompt ───────▼─────────────────────────────┐
  │ template(struct) → ~30 tokens — fits in any window        │
  │ no history · no retrieved docs · no truncation needed     │
  └────────────────────────────┬─────────────────────────────┘
              consumed: MapScreen.tsx:368
  ┌─ UI ───────────────────────▼─────────────────────────────┐
  │ RouteSummaryCard renders the sentence                    │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The context window is the hard ceiling of every LLM call, and most
production prompt work is window management — picking what survives the
cut. You've fought this for real in **AdvntrCue** (RAG over a corpus that
won't fit a window, so retrieval picks the few chunks that do). flattr is
the inverse: the relevant facts are computed and typed, so the window is
trivially satisfied. Naming *why* one app needs window management and
another doesn't — corpus vs struct — is the transferable insight.

## Project exercises

### B-CTX.1 — keep the describe prompt struct-bounded

- **Exercise ID:** B-CTX.1
- **What to build:** the route-describe prompt template that takes only
  `RouteSummary` (never raw labels or the full edge list), plus a test
  asserting the rendered prompt stays under a small fixed token budget.
- **Why it earns its place:** it makes the "structure upstream, no window
  problem" discipline a checked invariant instead of a hope.
- **Files to touch:** new `features/routing/describe.ts`;
  `features/routing/summary.ts:5` (the struct it reads);
  `mobile/src/MapScreen.tsx:159` (where the struct is produced).
- **Done when:** a unit test fails if the prompt grows past the budget,
  proving the input stays bounded.
- **Estimated effort:** an hour.

## Interview defense

**Q: How would you manage the context window for flattr's route
description?** Answer: there's nothing to manage. The prompt input is
`RouteSummary` (`summary.ts:5`) — three computed numbers — so the
template is tens of tokens with no history and no corpus. The window is
only a problem when context is unstructured; flattr's is a typed struct.
Load-bearing point: I'd *keep* it that way — never feed raw labels or the
full edge list into the prompt, or I'd invent a window problem that
doesn't need to exist.

```
  RouteSummary (3 fields) → tiny prompt → huge headroom in any window
```

Anchor: *"flattr's context is a struct, not a window — structure it
upstream and there's nothing to budget."*

## See also

- [03-prompt-chaining.md](03-prompt-chaining.md) — the input (geocode) seam.
- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — the same "surface few, not many" discipline.
- [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) — the output (describe) seam this prompt would fill.
