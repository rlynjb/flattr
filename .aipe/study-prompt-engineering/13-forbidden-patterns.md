# 13 — Forbidden patterns and rotating formulas

*Industry name(s): "forbidden patterns," "rotation," "anti-repetition,"
"diversity prompting," "negative constraints." Type label: Industry standard.*

> **Seam, not present.** flattr generates no repeated text. But it would, the
> moment Seam 1 ships: a user requesting routes all day would get a route
> description every time, and every one would open "This route is a flat..."
> because LLMs converge on phrasings. This file teaches anti-repetition
> against that future stream of descriptions.

## Zoom out — where repetition would set in

LLMs converge: run the same chain repeatedly and every output sounds the same.
The fix lives in the prompt — an explicit list of forbidden openings and a set
of rotating formulas. It matters only for *generative chains run repeatedly for
the same user*. flattr's Seam 1 description is exactly that.

```
  Zoom out — repetition across a stream of route descriptions

  ┌─ Seam 1, called repeatedly (future) ────────────────────────────┐
  │ route 1 → "This route is a flat 2 km..."                         │
  │ route 2 → "This route is a flat 3 km..."   ← same opening        │
  │ route 3 → "This route is a flat 1 km..."   ← same opening        │
  │           ★ forbidden-openings list + rotation breaks this ★     │
  └──────────────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: **explicitly list forbidden openings and enumerate rotating
formulas in the prompt, optionally feeding recent outputs back as "don't
repeat these."** It matters for any generative chain a user sees repeatedly. It
does NOT matter for one-shot classifiers or structured outputs — there,
convergence is a *feature* (you WANT the same label for the same input).

## The structure pass

**Layers:** the chain → one output → the stream of outputs.
**Axis:** *desired variance* — do you want sameness or difference here?
**Seam:** the classifier/generator boundary. Below it (classifiers) sameness is
correct; above it (user-facing generation) sameness is the bug.

```
  axis = "do you WANT the output to be the same each time?"

  ┌─ classifier ──┐ want sameness: YES — same input → same label
  │  ── seam ──      ◄── desired variance flips
  └─ generator ───┘ want sameness: NO — repetition reads robotic
```

## How it works

### Move 1 — the mental model

You know `Math.random()` without a seed gives variety and a fixed seed gives
the same value every time. An LLM run repeatedly is closer to the fixed-seed
case than you'd expect — it has favorite phrasings and reaches for them every
time. Anti-repetition is manually injecting variance: forbidding the favorite
openings and rotating through alternatives, the way you'd cycle a list instead
of always grabbing index 0.

```
  Pattern — rotation breaks convergence

  WITHOUT:  [chain] → "This route is..." → "This route is..." → "This route..."
                          ▲ model's favorite opening, every time

  WITH:     forbid ["This route is", "Your route"] + rotate [
              "Mostly flat —", "A gentle", "Expect", ...]
            → varied openings across the stream
```

### Move 2 — anti-repetition on flattr's descriptions

**Step 1 — forbid the convergent openings.** In the system prompt (concept 01,
section 1), an explicit negative list:

```
  // FUTURE — system prompt
  "Never open with: 'This route is', 'Your route', 'Here is'.
   Vary the opening every time."
```

Negative constraints are weaker than positive ones (the model may still drift
back), which is why you pair them with rotation.

**Step 2 — enumerate rotating formulas.** Give the model a set to cycle:

```
  "Rotate openings across these shapes:
   - lead with distance:  '3.2 km, mostly flat...'
   - lead with terrain:   'Gentle the whole way...'
   - lead with the catch: 'One steep block, otherwise flat...'"
```

For flattr these rotations are *grounded in the data* — the "lead with the
catch" formula is only used when `steepCount > 0`, which means rotation and the
honesty invariant (concept 10) cooperate rather than fight.

**Step 3 — feed recent outputs back (the loopd caption pattern).** The stronger
version: pass the last N descriptions into the prompt as "don't repeat these
openings." This is exactly loopd's caption chain with rotation history — the
prompt sees what it already said and avoids it:

```
  // FUTURE — rotation history (concept 04: costs tokens)
  context = `Recent openings to AVOID: ${recentOpenings.join(", ")}`
```

Note the token cost (concept 04): rotation history grows the per-call payload,
so cap it at the last 3–5.

```
  Layers-and-hops — rotation history feeding back into the prompt

  ┌─ prior outputs ─┐ last 3 openings   ┌─ prompt ──────┐ vary opening
  │ store           │ ────────────────► │ "avoid these" │ ──► new desc
  └─────────────────┘                   └───────────────┘      │
        ▲                                                       │
        └───────────────── append new opening ─────────────────┘
```

### Step 4 — where it does NOT apply

flattr's Seam 2 destination parser (NL → `{lat,lng}`) is a classifier —
"somewhere flat near the water" should parse to the *same* structured args
every time. Rotation there would be a bug. And the structured `RouteSummary`
itself never rotates — three numbers are three numbers. Anti-repetition is
*only* for the human-facing prose stream.

### Move 2 variant — load-bearing skeleton

Kernel: **forbidden openings + rotation, applied only to generative streams**.
What breaks:

- **No anti-repetition on a repeated generative chain** → every description
  reads identically; the product feels robotic. *Load-bearing for UX.*
- **Forbidden list without rotation** → model drifts back to a forbidden
  opening; negatives alone are weak. *Load-bearing — pair them.*
- **Rotation on a classifier** → same input yields different labels;
  correctness bug. *Anti-pattern — wrong side of the seam.*
- **Unbounded rotation history** → token bloat (concept 04). *Hardening — cap
  it.*

### Move 3 — the principle

LLMs converge on phrasings; variety is something you engineer, not something
you get for free. Forbid the favorites and rotate alternatives — but only for
user-facing generative streams. For classifiers and structured output,
convergence is correct, and rotation would be a bug.

## Primary diagram

```
  Anti-repetition on flattr's description stream (FUTURE)

  ┌─ Seam 1 prompt ──────────────────────────────────────────────────┐
  │ [system] forbid: "This route is", "Your route", "Here is"         │
  │          rotate: [distance-lead | terrain-lead | catch-lead]      │
  │ [context] recent openings to avoid (last 3, capped — concept 04)  │
  │ [context] {d, climb, steep}                                       │
  └───────────────────────────┬──────────────────────────────────────┘
                              ▼ varied prose across the stream
   route1 "3.2 km, mostly flat"  route2 "Gentle the whole way"  route3 ...

  ✗ NOT applied to: Seam 2 parser (classifier) · RouteSummary (structured)
```

## Elaborate

This is the least-academic concept in the set — pure production craft. It's the
reason every "AI wrote this" blog post sounds identical: nobody engineered the
variance. The reader has shipped exactly this in loopd's caption chain with
rotation history, which is the canonical anchor. It interacts with token
budgeting (rotation history costs tokens, cap it — concept 04) and with the
honesty invariant (rotation formulas are gated on `steepCount`, so they
cooperate with concept 10). Read `08-few-shot.md` for the inverse tension:
strong few-shot makes outputs converge *toward the examples*, which fights
rotation — balance the two.

## Interview defense

**Q: "Every output from your generative chain sounds the same. Fix?"** LLMs
converge on favorite phrasings, so you engineer variance: forbid the convergent
openings in the system prompt, enumerate rotating formulas, and for the strong
version feed the last few outputs back as "don't repeat these." But only for
user-facing generative streams — on a classifier, sameness is correct and
rotation is a bug.

```
  generative stream → forbid + rotate (variety is the feature)
  classifier        → leave it (sameness is the feature)
```

Anchor: *"flattr's Seam 1 description stream would converge — every route
opening 'This route is a flat...'. Forbidden openings + rotation fixes it,
grounded in the data (the 'catch-lead' formula only fires when steepCount>0, so
rotation and honesty cooperate). The Seam 2 parser and the `RouteSummary`
struct are classifiers/structured — they must NOT rotate."*

## See also

- [08-few-shot.md](08-few-shot.md) — strong few-shot fights rotation; balance
- [04-token-budgeting.md](04-token-budgeting.md) — rotation history costs tokens
- [10-self-critique.md](10-self-critique.md) — rotation gated on the honesty
  invariant
- [00-overview.md](00-overview.md) — the classifier-vs-generator seam map
</content>
