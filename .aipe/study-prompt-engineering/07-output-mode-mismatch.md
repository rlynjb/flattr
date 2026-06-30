# 07 · Output mode mismatch

> Industry name: output-contract mismatch / format mismatch at chain boundaries · Type label: Industry standard

> **Status: seam, not feature.** flattr never crosses an LLM output boundary, so it can't have this bug yet. But its types make the bug *visible in advance*: Seam 2's parse must emit a struct, Seam 1's describe must emit prose, and wiring one chain's output into a consumer that expects the other mode is the failure this file teaches.

## Zoom out — where this concept lives

This is the specific bug that happens *at* a single-purpose-chain boundary (`06`). Each chain declares one output mode; the bug is when the next stage expects a different one:

```
  Zoom out — output mode at the two seam boundaries

  ┌─ Seam 2 boundary ────────────────────────────────────────────┐
  │ parse → GeocodeQuery (JSON struct)  → geocode() expects struct│
  │   modes agree ✓                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Seam 1 boundary ────────────────────────────────────────────┐
  │ describe → prose sentence  → UI expects prose                │
  │   ★ THIS FILE: the bug when a consumer expects the OTHER mode★│ ← we are here
  │   e.g. UI parses describe-output as JSON → crash             │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is: **every chain declares exactly one output mode in its schema — structured (JSON) or freeform (prose) — and a mismatch at the boundary, where the producer emits one mode and the consumer parses the other, breaks the parser.** This is a code-review-catchable bug, and flattr's types are exactly what makes it catchable. Let me build it.

## Structure pass

**Layers.** Two: the *producer chain* (declares its output mode) and the *consumer* (the next stage, which assumes a mode). The mismatch lives between them. flattr's `Path` and `GeocodeResult` types are the consumer-side contracts that would make a mismatch a type error.

**Axis — guarantees (what shape does the consumer assume?).**

```
  One axis — "what shape does the next stage assume?" — across the boundary

  producer: describe → emits PROSE
  consumer: JSON.parse(output)  → assumes STRUCT

  ┌─ producer ─┐   boundary   ┌─ consumer ──┐
  │ mode: prose│ ═══════════► │ mode: JSON  │  ← they DISAGREE
  └────────────┘ (mismatch!)  └─────────────┘
       ▲                            ▲
       └── the contract is implicit and violated ──┘
```

**Seam.** The boundary between producer and consumer *is* the seam, and it's load-bearing precisely because the output-mode contract there is usually implicit — nobody wrote it down, so nobody noticed the producer and consumer disagree until the parser threw.

## How it works

### Move 1 — the mental model

You've hit this in plain frontend: a `fetch()` returns `text/html` but your code calls `res.json()`, and it throws `Unexpected token <`. The producer (server) emitted one mode; the consumer (your code) assumed another. Output-mode mismatch is that exact bug at an LLM chain boundary — and it's sneakier because the LLM *can* emit either mode, so the same chain can be right on Monday and wrong on Tuesday if a prompt edit flips its mode.

```
  The output-mode-mismatch kernel — the bug shape

  ┌─ chain ─────┐                    ┌─ consumer ──┐
  │ output mode │  ───── output ───► │ assumed mode│
  │ = ???       │                    │ = JSON.parse│
  └─────────────┘                    └─────────────┘
        │                                  │
   if these two disagree → parser throws or silently mis-reads
   the fix: declare the mode IN the schema, check it at review
```

### Move 2 — the step-by-step walkthrough

**Every chain declares one output mode — in its schema, not its prose.** Seam 2's parse is *structured*: its contract is `GeocodeQuery` (a Zod schema, `02`). Seam 1's describe is *freeform*: its contract is "a string of prose." The mode is part of the chain's signature. The discipline is to make it explicit — a chain's return type says JSON or prose, and the consumer's input type must match. flattr's existing types are the model:

```ts
// features/routing/types.ts — flattr's explicit consumer contracts
export type Path = { nodes: string[]; edges: string[]; ... };  // struct
// pipeline/geocode.ts:3
export type GeocodeResult = { lat; lng; label };               // struct
```

If `parseDestination` returns `GeocodeQuery` and `geocode` consumes a `string`/struct, TypeScript catches a mismatch *at compile time*. The mode contract is in the types.

**The bug — chain A returns JSON, chain B expects markdown.** Concretely at flattr's seams: imagine Seam 1's `describe` chain is edited to "return a JSON object with a `summary` field" (someone thought structured was tidier), but the UI's `RouteSummaryCard.tsx` still does `setText(output)` expecting a prose string. Now the card renders `{"summary":"Mostly flat..."}` as literal text — or, if it tried `JSON.parse` somewhere, it broke. The producer's mode flipped; the consumer didn't know.

```
  Hop — the mismatch at the Seam 1 → UI boundary

  ┌─ Chain: describe ─┐  output   ┌─ UI: RouteSummaryCard ─┐
  │ emits: {"summary":│ ────────► │ assumes: prose string  │
  │  "Mostly flat"}   │           │ renders raw → user sees│
  │ (mode CHANGED)    │           │ {"summary":"..."}      │
  └───────────────────┘           └────────────────────────┘
   ← nobody updated the consumer when the producer's mode flipped
```

**The other direction — prose where a struct was expected.** Seam 2: if `parseDestination` is edited to "explain your reasoning, then give the answer," it now emits prose-with-embedded-JSON instead of a clean struct, and `GeocodeQuery.safeParse` fails on the whole blob. The reasoning leaked into the output mode. (This is exactly why CoT reasoning goes in a *thinking field* of the struct, not as free prose around it — see `09-chain-of-thought.md`.)

**How to spot mismatches in code review.** Three checks at every chain boundary: (1) what mode does the producer declare? (2) what mode does the consumer assume? (3) do they match? In flattr's typed world, (3) is often the compiler's job — but only if the chain's output mode is encoded in its return type. The dangerous chains are the ones typed `=> Promise<string>` where the string is *sometimes* JSON and *sometimes* prose depending on the prompt. That's an untyped mode, and it's where the bug hides. The fix is to type the mode: `=> Promise<GeocodeQuery>` (struct, validated) or `=> Promise<{ kind: "prose"; text: string }>` (explicitly prose).

```
  Code-review checklist at a chain boundary

  ┌─────────────────────────────────────────────┐
  │ 1. producer declares mode?  → JSON | prose   │
  │ 2. consumer assumes mode?   → JSON | prose   │
  │ 3. (1) == (2)?              → yes | NO=BUG   │
  │ 4. is the mode in the TYPE? → if not, fix it │
  └─────────────────────────────────────────────┘
```

### Move 3 — the principle

One chain, one declared output mode, encoded in the type so the compiler guards the boundary. The mismatch bug is the LLM version of `res.json()` on an HTML response — and the same fix applies: make the contract explicit and let the type system enforce it. The chains most prone to the bug are the ones typed `=> string`, because a string can secretly be either mode and a prompt edit can flip it without changing the signature. flattr's habit of typing everything (`Path`, `GeocodeResult`, `RouteSummary`) is exactly the habit that prevents this — extend it across the LLM boundary and the bug becomes a compile error.

## Primary diagram

The full output-mode contract at both seams, with the mismatch failure and the type-level fix marked.

```
  Output mode at both seams — declared, matched, or it breaks

  ┌─ Seam 2 (structured) ────────────────────────────────────────┐
  │ parseDestination => GeocodeQuery   geocode(struct)           │
  │   producer mode: JSON ───match───► consumer mode: JSON  ✓     │
  │   BUG if parse emits prose → safeParse fails on whole blob   │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Seam 1 (freeform) ──────────────────────────────────────────┐
  │ describe => { kind:"prose"; text }   RouteSummaryCard(prose) │
  │   producer mode: prose ──match───► consumer mode: prose  ✓    │
  │   BUG if describe emits JSON → card renders raw {"summary"}   │
  └──────────────────────────────────────────────────────────────┘

  the fix in both: encode the mode in the TYPE → compiler guards it
  the danger: any chain typed `=> Promise<string>` (mode is hidden)
```

## Elaborate

Output-mode mismatch is loopd's lived bug (from `me.md`): five chains, and the boundaries between them are exactly where a format mismatch breaks the parser. It's the operational consequence of single-purpose chains (`06`) — once you have chains composed into a flow, the boundaries between them carry implicit contracts, and output mode is the one most likely to be left implicit. The defense is structured outputs (`02`) for the structured stages and an explicit `{ kind: "prose" }` wrapper for the freeform ones, so even prose carries a typed mode tag. The deeper point flattr makes visible: the repo already types every internal boundary; the LLM boundary is the one place teams forget to, and that's exactly where the format bug lives.

## Project exercises

### EX-MODE-1 — Type the output mode at both seams

- **Exercise ID:** EX-MODE-1
- **What to build:** Return types that encode mode — `parseDestination(): Promise<GeocodeQuery>` (struct) and `describeRoute(): Promise<{ kind: "prose"; text: string }>` — plus a consumer for each that the compiler verifies matches.
- **Why it earns its place:** Turns the mode contract into a compile-time check, demonstrating that the bug is preventable by typing, not vigilance.
- **Files to touch:** new `features/llm/modes.ts`; the describe consumer mirrors `mobile/src/RouteSummaryCard.tsx`.
- **Done when:** swapping a producer to the wrong mode produces a type error, not a runtime crash.
- **Estimated effort:** 1-2 hours.

## Interview defense

**Q: A chain worked yesterday and broke today with no consumer change. What's your first guess?**

A prompt edit flipped the producer's output mode — prose to JSON or vice versa — while the consumer still assumes the old mode. It's the `res.json()`-on-HTML bug at the LLM boundary. Encode the mode in the return type so the compiler catches the flip.

```
  describe edited to emit JSON → UI still parses prose → break
  fix: => Promise<{kind:"prose";text}> so the mode can't flip silently
```

Anchor: flattr types `Path`, `GeocodeResult`, `RouteSummary` — extend that habit across the LLM boundary and the mismatch is a compile error.

**Q: How do you catch this in code review?**

Three checks at every chain boundary: producer's declared mode, consumer's assumed mode, do they match. The dangerous chains are typed `=> Promise<string>`, because the mode is hidden — a string can secretly be either format.

## See also

- `02-structured-outputs.md` — typing the structured side of the boundary
- `06-single-purpose-chains.md` — the boundaries where this bug lives
- `09-chain-of-thought.md` — why reasoning goes in a thinking field, not loose prose
- `04-token-budgeting.md` — geometry as the wrong content in either mode
