# 10 — Self-critique and self-consistency

*Industry name(s): "self-critique," "self-refine," "self-consistency,"
"reflexion," "sampling + vote." Type label: Industry standard.*

> **Seam, not present.** flattr generates nothing to critique. But it has a
> genuinely high-stakes output that would justify the extra cost: a route
> description that claims "Flat all the way" when there's a steep block
> (`mobile/src/RouteSummaryCard.tsx:31` already branches on `clean =
> steepCount === 0`). Getting that honesty wrong is flattr's worst failure.
> This file teaches self-critique against exactly that output.

## Zoom out — where the extra reliability step sits

Self-critique and self-consistency are reliability multipliers: spend 2–5x the
token budget to make one output more trustworthy. They sit *after* the first
generation, as an extra pass. flattr has exactly one output where that cost is
justified.

```
  Zoom out — the extra pass on flattr's highest-stakes output

  ┌─ generation (future Seam 1) ────────────────────────────────────┐
  │ RouteSummary → "Flat all the way" / "⚠ Flattest available"      │
  │   ★ getting steep-honesty wrong = flattr's worst bug ★          │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼ JUSTIFIES the 2-5x cost
  ┌─ reliability pass (future) ─────────────────────────────────────┐
  │ self-critique: "does this mention steepness iff steepCount>0?"  │
  │ self-consistency: run N times, vote on honesty                  │
  └──────────────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern, two flavors: **self-critique** — ask the model to evaluate and
revise its own output. **self-consistency** — run the same prompt N times and
vote. Both buy reliability with tokens (2–5x). Worth it for high-stakes,
hard-to-review outputs. The catch: a model critiquing itself shares the blind
spots that produced the output — diminishing returns, and a hard ceiling.

## The structure pass

**Layers:** first output → critique/votes → final output.
**Axis:** *reliability per token* — how much trust does the extra pass buy?
**Seam:** the first-output→reliability-pass boundary, where you decide the
stakes justify the multiplier.

```
  axis = "is the extra reliability worth the token multiplier?"

  ┌─ low stakes ──┐ worth it: NO — 1x, ship the first output
  │  ── seam ──      ◄── decided by the cost of being wrong
  └─ high stakes ─┘ worth it: YES — 2-5x for steep-honesty
```

## How it works

### Move 1 — the mental model

You know two ways to make code more reliable: a code review (someone reads it
and flags problems — that's self-critique) and running a flaky test N times to
see if it's really green (that's self-consistency). Self-critique adds a
reviewer; self-consistency adds repetition and a vote. Both cost more; you
reserve them for the code that matters. flattr's honesty claim is the code that
matters.

```
  Pattern — two reliability shapes

  SELF-CRITIQUE:  draft ─► "critique your draft" ─► revise ─► final
                          (one extra pass)

  SELF-CONSISTENCY: prompt ─► run 1 ─┐
                    prompt ─► run 2 ─┼─► vote ─► final
                    prompt ─► run 3 ─┘
```

### Move 2 — both flavors on flattr's honesty claim

**Step 1 — the high-stakes output that justifies the cost.** flattr's UI
already encodes the stakes:

```tsx
// mobile/src/RouteSummaryCard.tsx:28,31 — EXISTS
const clean = summary.steepCount === 0;
... <Text>{clean ? "Flat all the way" : "⚠ Flattest available"}</Text>
```

A future LLM description that says "Flat all the way" when `steepCount > 0` is
the worst possible flattr bug — it breaks the product's core honesty promise
and could send someone up a hill they can't manage. *That* output justifies a
reliability pass. The Seam 1 description for a clean route does not.

**Step 2 — self-critique against the honesty invariant.** The critique prompt
has a concrete, checkable target:

```
  // FUTURE — self-critique pass
  draft = describe(summary)
  critique = ask("Does this description mention steep blocks if and only if
                  steepCount > 0? steepCount=" + summary.steepCount + ". Draft: " + draft)
  if (critique says inconsistent) draft = revise(draft, critique)
```

**Step 3 — but prefer a mechanical check (the honest answer).** Here flattr
exposes the limit of self-critique beautifully: the honesty invariant is
*mechanically checkable* — `description.mentionsSteep === (steepCount > 0)`.
When you can verify with code, you don't pay 2-5x for the model to verify
itself. Self-critique is for outputs you *can't* mechanically check (is this
sentence natural? is this tone right?). flattr's steep-honesty is checkable —
so the right move is a code assertion, and self-critique is reserved for the
subjective polish.

**Step 4 — self-consistency for the genuinely subjective.** If you wanted the
*most natural* description, run the prompt 3 times at temperature, and pick the
one that passes the mechanical honesty check AND reads best. The vote here is
"honest AND natural," with honesty checked by code, naturalness by you or a
judge (concept 05).

```
  Layers-and-hops — reliability pass on the honesty claim

  ┌─ generate ───┐ draft   ┌─ mechanical check (PREFERRED) ─┐ pass/fail
  │ describe()   │ ──────► │ mentionsSteep == (steep>0)?    │ ──► ship/regen
  └──────────────┘         └────────────────────────────────┘
        │ (only for subjective axes)
        ▼
  ┌─ self-critique ──┐ "is the tone right?" ─► revise ─► final
  └──────────────────┘  (2x cost, reserved for unverifiable axes)
```

### Move 2 variant — load-bearing skeleton

Kernel: **an extra pass gated by stakes, preferring mechanical checks**. What
breaks:

- **No reliability pass on the honesty claim** → "Flat all the way" ships on a
  steep route. *Load-bearing for high-stakes output.*
- **Self-critique where a mechanical check exists** → you pay 2-5x for what a
  one-line assertion does, and the model misses what it missed the first time.
  *Waste + the blind-spot ceiling.*
- **Self-consistency on low-stakes output** → 3-5x cost for no product gain.
  *Anti-pattern.*

### Move 3 — the principle

Reliability passes buy trust with tokens — reserve them for high-stakes,
*unverifiable* outputs. When the invariant is mechanically checkable (flattr's
steep-honesty is), a code assertion beats self-critique every time, because the
model shares the blind spots that produced the error.

## Primary diagram

```
  Self-critique / self-consistency on flattr's honesty claim (FUTURE)

  RouteSummary{steepCount} ─► describe() ─► draft
                                              │
              ┌───────────────────────────────┤
              ▼ checkable (PREFER)             ▼ unverifiable
  ┌─ mechanical ──────────────┐   ┌─ self-critique / N-vote ──────────┐
  │ mentionsSteep==(steep>0)? │   │ "tone natural?" → revise / vote   │
  │ 1x cost, no blind spot ✓  │   │ 2-5x cost, blind-spot ceiling     │
  └───────────────────────────┘   └────────────────────────────────────┘
```

## Elaborate

Self-consistency is from Wang et al. ("Self-Consistency Improves Chain of
Thought"); self-refine / Reflexion are the self-critique lineage. The crucial
production caveat — a model can't reliably catch errors it's prone to making —
is why eugeneyan.com and Hamel both push *external* verification (mechanical
checks, a different model as judge) over pure self-critique. flattr is a clean
illustration: its highest-stakes invariant happens to be mechanically
checkable, which is the best possible case. Read `05-eval-driven-iteration.md`
for external verification done right and `09-chain-of-thought.md` for the
reasoning step self-critique builds on.

## Interview defense

**Q: "When is self-critique not worth it?"** When the invariant is mechanically
checkable, or the output is low-stakes. flattr's steep-honesty is checkable in
one line — paying 2-5x for the model to re-check itself is waste, and worse, it
shares the blind spot that caused the error. Reserve self-critique for
high-stakes outputs you genuinely can't verify with code.

```
  checkable invariant → code assertion (1x, no blind spot)
  unverifiable + high-stakes → self-critique / vote (2-5x)
```

Anchor: *"flattr's worst bug is 'Flat all the way' on a steep route —
`RouteSummaryCard.tsx` already branches on `steepCount===0`. That's high-stakes,
which argues for a reliability pass; but it's mechanically checkable, which
means a code assertion beats self-critique."*

## See also

- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — external
  verification > self-critique
- [09-chain-of-thought.md](09-chain-of-thought.md) — the reasoning step under it
- [02-structured-outputs.md](02-structured-outputs.md) — schema makes honesty
  checkable
- `.aipe/study-security/` — never let unverified LLM output trigger side effects
</content>
