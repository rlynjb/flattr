# User Override Locks
*Human-in-the-loop override / write-protection — Language-agnostic*

## Zoom out

When a model writes into a field a human can also edit, you need a rule for who wins. The standard move is an override lock — an `_overridden_at` timestamp (or a dirty flag) so a later model run *skips* any field the user has touched, instead of silently clobbering their edit. flattr has no model-written fields, so it needs no lock — but the GradeSlider is a clean example of the opposite case worth naming.

```
LAYERS — the lock guards human edits from model writes
┌──────────────────────────────────────────────┐
│ model run ─► wants to write field X            │
│                  │ is X._overridden_at set?    │ ◄── the lock check
│        yes ──────┴──► skip (human owns it)      │
│        no  ──────────► write                     │
└──────────────────────────────────────────────┘
```

## How it works

**Move 1 — the mental model.** A field can have two authors: the model and the user. Without a lock, the next model run overwrites whatever the user just typed — infuriating. The lock records "a human set this at time T." Before the model writes, it checks the lock; if set, it leaves the field alone. The user's edit is sticky until they explicitly clear it.

```
PATTERN — co-authored field needs an owner
  field.value          "Dolores Park"
  field._overridden_at  2026-06-16T…   ◄── set when user edits
  next model run ─► sees timestamp ─► does NOT overwrite
```

**Move 2 — the mechanism.** On every user edit, stamp `_overridden_at = now`. On every model write, gate on it: `if (field._overridden_at) skip; else write`. Clearing the field (or an explicit "reset to AI") nulls the timestamp and re-opens it to the model. The subtlety is scope — lock per *field*, not per record, so the model can still update the columns the user hasn't touched. No lock is needed at all when only one author exists.

```
MECHANISM — write gate
  onUserEdit(f, v):   f.value=v; f._overridden_at = now
  onModelWrite(f, v): if f._overridden_at: return   ◄── lock wins
                      else: f.value = v
```

**Move 3 — principle.** When a model and a human can write the same field, the human's timestamp wins; when only the human writes it, you need no lock at all.

## In this codebase

**Not yet exercised in flattr — and largely not needed.** flattr has no LLM-written fields, so there's no model author to lock out. Worth contrasting: the GradeSlider's `userMax` is a *pure user knob* — it flows through `features/grade/classify.ts` (`bandsForUserMax`, `classifyDirected`) and `features/routing/cost.ts` (`penalty(g, max)`) as the single source of truth for "where red begins." Nothing computes or overwrites it, so no lock is required; it's the single-author case from Move 2. If a future model ever *suggested* a max grade ("looks like you walk — try 8%?"), then you'd want an `_overridden_at` so the suggestion never stomps a value the user dialed in by hand.

## See also
- [04 — Structured outputs](04-structured-outputs.md)
- [07 — Heuristic before LLM](07-heuristic-before-llm.md)
