# 01 — Anatomy of a production prompt

*Industry name(s): "prompt structure," "the four-part prompt." Type label:
Industry standard.*

> **Seam, not present.** flattr sends nothing to a model. This file teaches
> the four sections of a prompt by building the *one prompt flattr would
> have first*: the "describe my route" prompt at Seam 1, fed by the real
> `RouteSummary` struct from `features/routing/summary.ts:11`.

## Zoom out — where a prompt's anatomy sits

A prompt is not one blob of text. It's four sections with four different
lifetimes, and the whole skill is keeping them from bleeding into each other.
Here's where they'd live relative to flattr's existing code.

```
  Zoom out — the four sections, mapped to flattr's Seam 1

  ┌─ Engine layer (exists: features/routing/) ──────────────────────┐
  │  routeSummary() ──► RouteSummary{distanceM, climbM, steepCount}  │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ this struct feeds section 2
  ┌─ Prompt assembly (future) ────▼──────────────────────────────────┐
  │  ┌──────────────┐ constant  ← shipped with the build             │
  │  │ 1 SYSTEM     │           "You describe walking routes..."     │
  │  ├──────────────┤ per-call  ← ★ RouteSummary goes HERE ★         │
  │  │ 2 CONTEXT    │           "distance=3200m climb=45m steep=0"   │
  │  ├──────────────┤ constant  ← 2-3 frozen examples                │
  │  │ 3 FEW-SHOT   │           input→ideal output pairs             │
  │  ├──────────────┤ per-call  ← the actual ask                     │
  │  │ 4 USER MSG   │           "Describe this route."               │
  │  └──────────────┘                                                │
  └──────────────────────────────────────────────────────────────────┘
```

The box we care about is section 2 — it's the only one wired to flattr's
real data. The other three are constant text you'd write once.

## Zoom in

The pattern: **a prompt is four sections, each doing exactly one job, split
by what changes per call.** System and few-shot are constant (they ship with
the build). Context and user-message are per-call (they change every request).
Mix those lifetimes — drop a per-call detail into the system prompt — and you
get drift, the slow rot where a prompt that worked in March behaves
differently in June and nobody can point at the line that did it.

## The structure pass

**Layers:** four sections, top (most constant) to bottom (most variable).
**Axis:** *lifetime* — when is this text decided?
**Seam:** the line between constant and per-call. That's where drift leaks.

```
  axis = "when is this text decided?"  — traced down the sections

  ┌─ system ───────┐   decided: BUILD TIME (frozen, version-controlled)
  ├─ few-shot ─────┤   decided: BUILD TIME (frozen examples)
  │   ─── seam: constant | per-call ───  ◄── lifetime FLIPS here
  ├─ context ──────┤   decided: REQUEST TIME (this route's numbers)
  └─ user message ─┘   decided: REQUEST TIME (this user's ask)
```

If you can't say whether a sentence is build-time or request-time, it's in the
wrong section. That single question prevents most prompt rot.

## How it works

### Move 1 — the mental model

You already know this shape from React, you just call the parts something
else. A component has **props that never change for a given mount** (config
passed once) and **props that change every render** (state-derived values).
A prompt is the same split: system + few-shot are the config you pass once;
context + user message are the per-render values. Mixing them is like
hardcoding today's date into a component's default props — it works until the
day it doesn't, and the bug is invisible because the code "looks fine."

```
  Pattern — the four-part prompt as one assembled string

         ┌─────────────── ASSEMBLED PROMPT ───────────────┐
  build  │ [SYSTEM]   role + rules + output contract       │
  time   │ [FEW-SHOT] example_in → example_out  (×2–3)     │
         ├────────────────────────────────────────────────┤
  req    │ [CONTEXT]  ◄── RouteSummary serialized here     │
  time   │ [USER]     "Describe this route in one line."   │
         └────────────────────────────────────────────────┘
                              │
                              ▼  one call
                         LLM → prose
```

### Move 2 — walk each section against flattr's real struct

**Section 1 — the system prompt (constant; sets role + the output contract).**
This is where you state the job once and freeze it. For Seam 1 it would say:
"You describe self-powered travel routes. One sentence. Mention flatness
honestly — if there are steep blocks, say so." The thing juniors get wrong:
they put the route's numbers here. They don't go here. Numbers are per-call.

**Section 2 — context injection (per-call; this is the ONLY section wired to
flattr).** Here's the real struct that feeds it, today, in the repo:

```ts
// features/routing/summary.ts:5,11-20  — EXISTS today
export type RouteSummary = { distanceM: number; climbM: number; steepCount: number };

export function routeSummary(graph: Graph, path: Path, _userMax: number): RouteSummary {
  let climbM = 0;
  for (let i = 0; i < path.edges.length; i++) {
    const edge = edgeById(graph, path.edges[i]);
    const fromNode = path.nodes[i];
    const directedRise = fromNode === edge.fromNode ? edge.riseM : -edge.riseM;
    if (directedRise > 0) climbM += directedRise;     // uphill-only sum
  }
  return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
}
```

Line-by-line for the prompt's sake: `distanceM` is total length, `climbM` is
*directed* uphill rise only (downhill doesn't subtract — that's a product
decision flattr already made), `steepCount` is how many blocks exceed the
user's max grade. Those three numbers are the entire context payload. The
serialization step — the future code — would be one line:

```
  // FUTURE — the context section, built from the real struct
  context = `distance_m=${s.distanceM} climb_m=${s.climbM} steep_count=${s.steepCount} user_max_pct=${userMax}`
```

That's it. Three numbers and the knob. Notice what's *not* here: no graph, no
node list, no geometry. flattr's context payload is tiny by construction,
which is a gift — see `04-token-budgeting.md`.

```
  Layers-and-hops — RouteSummary crossing into the context section

  ┌─ engine ─────┐ hop 1: routeSummary()   ┌─ assembler ──┐
  │ summary.ts   │ ──────────────────────► │ serialize    │
  └──────────────┘   RouteSummary{3 nums}  └──────┬───────┘
                                          hop 2:  │ inject as
                                          context │ section 2
                                                  ▼
                                          ┌─ prompt string ─┐
                                          │ [SYSTEM]...      │
                                          │ [CONTEXT]◄here   │
                                          └──────────────────┘
```

**Section 3 — few-shot examples (constant; 2–3 frozen pairs).** Two example
routes with their ideal one-line descriptions. These constrain tone harder
than any instruction in the system prompt — covered in full in
`08-few-shot.md`. They're constant: they ship with the build.

**Section 4 — the user message (per-call; the actual ask).** Often trivial
here: "Describe this route." It's per-call because in a real app it might
carry the user's phrasing preference, locale, etc.

### Move 2 variant — the load-bearing skeleton

The irreducible kernel is **system + one per-call section**. Strip it down:

- **Drop the system prompt** → the model has no role and no output contract;
  it returns a paragraph when you wanted one line, and your parser (concept
  07) breaks. *This is load-bearing.*
- **Drop the context section** → the model has nothing to describe; it
  hallucinates a route. *Load-bearing.*
- **Drop few-shot** → still works, output is just less consistent. *Hardening,
  not skeleton.*
- **Drop the user message** → some APIs require it; mostly *hardening* for
  this use case.

So the skeleton is **system (role + contract) + context (the data)**. Few-shot
and a rich user message are hardening you add when consistency matters.

### Move 3 — the principle

A prompt is a function with a constant config closure and per-call arguments.
The bugs that take two weeks to find are always a per-call value that
someone froze into the constant part, or vice versa. Name each section by its
lifetime before you write a word of it.

## Primary diagram

The full Seam 1 prompt, every section labeled by lifetime, with the one real
flattr wire marked.

```
  Seam 1 "describe my route" — full anatomy (FUTURE)

  ┌──────────────────────────── PROMPT ─────────────────────────────┐
  │ ┌─ 1 SYSTEM (constant, build-time) ────────────────────────────┐ │
  │ │ "Describe self-powered routes. One sentence. Steep = honest." │ │
  │ └───────────────────────────────────────────────────────────────┘ │
  │ ┌─ 3 FEW-SHOT (constant, build-time) ──────────────────────────┐ │
  │ │ in: d=2100 climb=10 steep=0 → "Flat 2.1 km, no climbs."       │ │
  │ │ in: d=3400 climb=80 steep=2 → "3.4 km, mostly flat, 2 steep." │ │
  │ └───────────────────────────────────────────────────────────────┘ │
  │ ┌─ 2 CONTEXT (per-call) ◄══ from summary.ts RouteSummary ══════┐ │
  │ │ "distance_m=3200 climb_m=45 steep_count=0 user_max_pct=8"     │ │
  │ └───────────────────────────────────────────────────────────────┘ │
  │ ┌─ 4 USER (per-call) ──────────────────────────────────────────┐ │
  │ │ "Describe this route in one line."                            │ │
  │ └───────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────┬───────────────────────────────────┘
                                 ▼  LLM → "A flat 3.2 km route, no steep blocks."
```

## Elaborate

The four-section model is the spine of both the Anthropic prompt-engineering
guide and the OpenAI cookbook, though they name the sections differently
(Anthropic leans on XML-tag delimiters for the context section — relevant
later for `12-prompt-injection-defense.md`). The lifetime split (constant vs
per-call) is the same idea as prefix caching at the provider level: providers
cache the constant prefix across calls, so keeping system + few-shot stable
and at the front is both a cleanliness win and a cost win (see
`04-token-budgeting.md`). Read `02-structured-outputs.md` next — it shows why,
for flattr's classifier-shaped seams, the output contract in section 1 should
be a schema, not a sentence.

## Interview defense

**Q: "What's the difference between the system prompt and the user message?"**
Lifetime. System is constant — role and output contract, decided at build
time, version-controlled, cached as a prefix. User message is per-call. The
tell that someone's never shipped: they put per-call data in the system
prompt, and then can't explain why the prompt "drifts."

```
  ┌─ system ─┐ build-time, frozen, cached
  │  ─seam─   │ ◄── lifetime flips
  └─ user ───┘ request-time, varies
```

Anchor: *"In flattr's Seam 1, the role and 'be honest about steep blocks'
rule are system; the three `RouteSummary` numbers are context. Swap them and
you get drift."*

**Q: "Where would flattr's first prompt get its data?"** `RouteSummary` from
`features/routing/summary.ts:11` — three numbers, serialized into the context
section. Nothing else crosses the seam.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — make section 1's
  contract a schema
- [08-few-shot.md](08-few-shot.md) — section 3 in depth
- [04-token-budgeting.md](04-token-budgeting.md) — why the constant sections
  go at the front
- [00-overview.md](00-overview.md) — the three-seam map
</content>
