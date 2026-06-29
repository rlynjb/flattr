# The Context Window
*Industry name: context window · Type: hard model constraint*

## Zoom out

```
THE CONTEXT WINDOW = one finite token budget, shared by EVERYTHING
┌──────────────────────────────────────────────────────────┐
│  system prompt │ tools │ history │ retrieved docs │ USER   │  ← all
│  ───────────── │ ───── │ ─────── │ ────────────── │ ─────  │    compete
└──────────────────────────────────────────────────────────┘
        every token you spend here is a token NOT available there
                                                    ▼
                                              model output
```

A context window is the model's whole working memory for a single call: there is
no "long-term" anything, just this one box. Everything you want the model to
consider — instructions, tool schemas, prior turns, retrieved chunks, the user's
actual question — gets packed into the same budget and counted in tokens. When
the box is full, something has to give: you truncate, summarize, or drop.

You've felt this in AdvntrRAG — pgvector hands you N chunks and you decide how
many actually fit alongside the GPT-4 system prompt and the session memory from
MemoRAG. That triage *is* context-window management.

## How it works

**Move 1 — Treat it as a budget, not a bucket.**

```
BUDGETING (numbers illustrative)
total = 128k tokens
├─ system + tools ........  2k   (fixed overhead)
├─ conversation history .. 10k   (grows every turn → cap it)
├─ retrieved context ..... 40k   (the dial you actually turn)
└─ headroom for output ... leave room or the model gets cut off
```

Mental model: you are not "filling" the window, you are *allocating* it. Output
needs room too — if you cram input to the brim, the completion truncates
mid-sentence. The retrieved-context line is the one knob worth tuning; the rest
is mostly fixed cost.

**Move 2 — When it won't fit, reduce before you send.**

```
OVERFLOW HANDLING
raw material (300k) ──► [ rank / filter ] ──► top-k (35k) ──► send
                  │
                  └─► [ summarize older turns ] ──► compact history
```

Step by step: (1) count tokens, don't guess; (2) rank candidate context by
relevance and keep only top-k; (3) compress conversation history into a running
summary once it crosses a threshold; (4) verify the final assembled prompt still
leaves headroom for the answer.

**Move 3 — Principle:** *the window is finite and shared; curate what enters it.*

## In this codebase

**Not yet exercised in flattr.** flattr has no LLM call, so there is no context
window to budget — nothing assembles a prompt today.

The seam where one *would* open is `features/routing/summary.ts:11`. A future
"Describe my route" feature would template the `RouteSummary` return value
(`{distanceM, climbM, steepCount}`) into a prompt. That payload is three numbers.
Even with a system prompt and a tone instruction wrapped around it, the assembled
context would be a few hundred tokens against a window of 100k+ — the box would be
nearly empty. So for flattr specifically, window *pressure* is a non-issue: the
constraint exists, but this workload never approaches it. The interesting
constraints here are latency and prompt-injection (see seam at
`pipeline/geocode.ts`), not token budget.

## See also
- `02-lost-in-the-middle.md` — position effects *inside* a full window
- `03-prompt-chaining.md` — splitting work so no single window has to hold it all
- `features/routing/summary.ts:11` — the only realistic prompt input in flattr
