# 07 — Output mode mismatch

*Industry name(s): "output mode mismatch," "format contract drift,"
"schema mismatch between stages." Type label: Industry standard.*

> **Seam, not present.** flattr passes no LLM output between stages. But it
> has the *typed-contract-between-stages* discipline that prevents this bug:
> `Path` (`features/routing/types.ts:31`) is the contract `astar.ts` produces
> and `summary.ts` consumes. This file teaches the mismatch bug against that
> real contract and the future chain at Seam 2.

## Zoom out — where a mode mismatch would bite

Every step in a chain declares an output mode (JSON / prose / a specific
schema). The mismatch bug is when step A emits one mode and step B was written
expecting another. It lives at the step boundary — exactly the seams concept
06 created.

```
  Zoom out — the mode contract at a chain boundary

  ┌─ step A ──────┐  declares mode: JSON {lat,lng}   ┌─ step B ──────┐
  │ parse-intent  │ ───────────────────────────────► │ geocode/route │
  │ (LLM)         │   ✗ but emits prose? B breaks     │ (code)        │
  └───────────────┘                                   └───────────────┘
                          ▲
              ★ THE MISMATCH lives in this hop ★
```

flattr's deterministic equivalent never mismatches because TypeScript checks
the `Path` contract at compile time. The danger appears the moment one side of
the boundary is an LLM, whose output is best-effort.

## Zoom in

The pattern: **every chain step declares exactly one output mode in its schema,
and the consuming step's expectation must match it — checked, not assumed.**
The bug: chain A returns JSON, chain B expects markdown (or vice versa), the
parser breaks at runtime, and because LLM output varies, it breaks
*intermittently* — the worst kind.

## The structure pass

**Layers:** producer step → the wire → consumer step.
**Axis:** *contract agreement* — do both sides agree on the format?
**Seam:** the producer→consumer hop. With two typed code modules, the compiler
guards it. With an LLM producer, nothing guards it unless you build the check.

```
  axis = "is the format contract enforced or assumed?"

  ┌─ code → code ─┐ enforced: YES (TS compiler checks Path)
  │  ── seam ──      ◄── enforcement DROPS when producer is an LLM
  └─ LLM → code ──┘ enforced: NO — unless you validate (concept 02)
```

## How it works

### Move 1 — the mental model

You've hit this with a REST API: the frontend expects `{ user: {...} }` and a
backend deploy starts returning `{ data: { user: {...} } }`. Same data,
different envelope, everything downstream breaks. An output mode mismatch is
that, between two chain steps. flattr's `Path` type is the envelope the
compiler enforces between `astar.ts` and `summary.ts`; an LLM step has no
compiler, so the envelope can shift silently.

```
  Pattern — the mismatch as an envelope shift

  step A emits: ```json\n{"lat":..}\n```   ← prose-wrapped JSON
  step B does:  JSON.parse(input)          ← expects raw JSON
                       ▼
                  THROW (intermittent: only when A "helpfully" fences)
```

### Move 2 — walk it against flattr's real contract

**Step 1 — see the contract done right (flattr, today).** Here's the typed
boundary that *can't* mismatch:

```ts
// features/routing/types.ts:31-37 — EXISTS
export type Path = {
  nodes: string[]; edges: string[];
  cost: number; lengthM: number;
  steepEdges: string[];
};
```

`astar.ts` produces a `Path`; `summary.ts` consumes a `Path` (`routeSummary`
takes one). If `astar.ts` changed `lengthM` to a string, `tsc --noEmit` fails
the build *before* it ships. The contract is enforced at compile time. That's
the bar an LLM chain has to reach at runtime.

**Step 2 — see where it breaks (future Seam 2 chain).** The NL chain:
`parse-intent (LLM) → geocode (code)`. parse-intent's schema says it returns
`{lat, lng}` JSON. But the model, being courteous, returns:

```
  Sure! Here are the coordinates:
  ```json
  {"lat": 47.6, "lng": -122.3}
  ```
```

geocode's caller does `JSON.parse(output)` and throws on "Sure!". It worked in
every demo because the demo prompt was terse; it breaks in prod when a model
upgrade makes the model chattier. This is the exact bug concept 02's
fence-strip + `safeParse` exists to kill.

```
  Layers-and-hops — the mismatch and the fix at the LLM→code hop

  ┌─ parse-intent (LLM) ─┐ hop: declares JSON, EMITS prose+fence
  │                      │ ─────────────────────────────────────┐
  └──────────────────────┘                                       ▼
  ┌─ adapter (the fix) ──────────────────────────────────────────┐
  │ strip prose/fences → safeParse against {lat,lng} schema       │
  │ fail → retry stricter (concept 02)                           │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼ clean {lat,lng}
  ┌─ geocode (code) ─────────────────────────────────────────────┐
  │ now the contract holds                                        │
  └───────────────────────────────────────────────────────────────┘
```

**Step 3 — how to spot it in code review.** The review heuristic: at every
chain hop, find where the producer's declared mode and the consumer's
`parse`/`expect` are written. If they're in different files and nobody
asserted they agree, that's the mismatch waiting to happen. flattr makes this
free for code-code hops (the compiler is the reviewer); for LLM hops you
review the adapter that bridges best-effort output to a typed expectation.

### Move 2 variant — load-bearing skeleton

Kernel: **one declared mode per step + an enforced check at the consuming
boundary**. What breaks:

- **No declared mode** → consumer guesses; mismatch is inevitable. *Load-
  bearing.*
- **Declared but unchecked** → works in demo, breaks intermittently in prod
  on a chattier model. *Load-bearing — this is the whole bug.*
- **Adapter that strips + validates** → this is the fix; without it an LLM hop
  is a TS-less boundary. *Load-bearing for LLM hops.*

### Move 3 — the principle

A chain hop is a contract. Code-to-code hops are enforced by the type system;
LLM-to-code hops are enforced by nothing unless you put an adapter there that
strips, parses, and validates. flattr's compile-checked `Path` is the gold
standard — match it at runtime for every LLM step.

## Primary diagram

```
  Output mode mismatch — the contract gradient (FUTURE chain vs EXISTING code)

  ┌─ code → code (EXISTS) ──────────────────────────────────────────┐
  │ astar.ts ═Path═► summary.ts   ← tsc enforces, cannot mismatch    │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ LLM → code (Seam 2, FUTURE) ───────────────────────────────────┐
  │ parse-intent ──"Sure! ```json{...}```"──► geocode               │
  │                          ▼ ✗ JSON.parse throws (intermittent)   │
  │   FIX: insert adapter → strip fence → safeParse → retry         │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the runtime cousin of concept 02 (structured outputs): structured
output is how you make a single step's output trustworthy; output-mode
matching is how you make a *chain* of steps trustworthy. Vendor note for the
Elaborate block: providers vary in how aggressively they fence — some wrap by
default, some never — which is why the adapter belongs in your code, not in
trusting the provider. flattr's compile-checked boundaries are the model to
aspire to. Read `02-structured-outputs.md` for the adapter mechanics and
`06-single-purpose-chains.md` for why the boundaries exist at all.

## Interview defense

**Q: "Chain step B started throwing on parse, intermittently. What happened?"**
Step A declared JSON output but the model started wrapping it in prose or a
code fence — usually after a model upgrade made it chattier. B's `JSON.parse`
choked. It's intermittent because LLM output varies. Fix: an adapter at the
hop that strips fences and `safeParse`s against the schema, with a stricter
retry on fail.

```
  declared: JSON    emitted: "Sure!" + ```json{...}```    → throw
  fix: strip → parse → validate → retry
```

Anchor: *"flattr's code-to-code hops can't have this bug — `tsc` enforces the
`Path` contract at compile time. The bug only appears at an LLM hop, which has
no compiler. The fix is to put a validating adapter where the type system
would have been."*

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the adapter mechanics
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the boundaries
  that need contracts
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — schema-fail rate
  catches drift
- `.aipe/study-data-modeling/` — `Path` and `Edge` as typed contracts
</content>
