# Tree of Thoughts

**Industry names:** Tree of Thoughts (ToT) · branching search over
reasoning. **Type:** Industry standard. **In this codebase: Not yet
implemented** (no LLM loop) — but flattr's A* *is* a scored branching
search, which is the cleanest possible anchor for the shape.

> Explore multiple reasoning branches, score them, pick the best. Rarely
> worth it in production. Cover it so you can say why you *didn't* use it —
> and flattr hands you the perfect contrast: it already does scored
> branching search, deterministically and cheaply.

---

## Zoom out, then zoom in

**Zoom out.**

```
  Zoom out — ToT branches the step slot into many scored candidates

           root question
          ┌──────┼──────┐
          ▼      ▼      ▼
        path A  path B  path C     ← each a reasoning branch
          │      │      │
        score  score  score        ← a model scores each
          └──────┼──────┘
                 ▼
            best path wins
```

**Zoom in.** Instead of one step, generate several candidate
continuations, score them, pursue the best. The branch factor multiplies
token cost. It rarely beats a well-prompted ReAct loop on real tasks.

---

## How it works

### Move 1 — the mental model

You've already *built* scored branching search — it's A*. The frontier in
`astar.ts:30` (`open`, a priority queue) holds branches; the priority
`g + h` (`astar.ts:72`) is the score; `open.pop()` always expands the
best-scored branch next. ToT is A* where the *scoring* is a model call
instead of arithmetic.

```
  A* (flattr) IS scored branching search — the ToT shape, made cheap

  open (PQueue) = the branches waiting        ← astar.ts:30
  g + h          = the score per branch        ← astar.ts:72
  open.pop()     = expand the best branch next ← astar.ts:49
  closed         = prune dead branches         ← astar.ts:61
```

### Move 2 — why flattr makes ToT look expensive

flattr scores branches with arithmetic — microseconds, deterministic,
admissible (the haversine heuristic never overestimates, per the project's
must-not-change constraint). ToT scores branches with model calls —
hundreds of ms each, stochastic, no admissibility guarantee. Same shape,
wildly different cost:

```
  branch scoring — flattr vs ToT

  flattr:  score = g + costFn + h   → µs · deterministic · admissible
  ToT:     score = LLM(branch)      → 100s ms · stochastic · no bound,
                                       cost × branch_factor × depth
```

That's the blunt production verdict: ToT multiplies token cost by the
branch factor and rarely beats a well-prompted single path. flattr proves
branching search *can* be cheap — but only when the score is a function,
not a model.

### Move 3 — the principle

Branching search is powerful when scoring is cheap (A*) and a luxury when
scoring is a model call (ToT). The common production answer is "I
considered ToT and didn't — the branch-factor token multiplier didn't pay
for itself." flattr is the existence proof that the *shape* is fine; the
cost lives entirely in what fills the scoring slot.

---

## Interview defense

**Q: When would you use Tree of Thoughts?**

Rarely. It's A* where the scoring function is a model call — same
branching frontier, but each score costs hundreds of ms and tokens, times
the branch factor times depth. flattr's A* shows scored branching search
is cheap *when the score is arithmetic*; ToT removes that, so it rarely
beats a well-prompted ReAct path. The senior answer is usually why I
*didn't* reach for it.

Anchor: *"flattr's A* is Tree of Thoughts with the scoring slot filled by
`g+h` — same branching frontier, but µs and admissible instead of tokens
and stochastic."*

---

## See also

- `02-agent-loop-skeleton.md` · `03-react.md` · `05-reflexion-self-critique.md`
- Sibling guide `study-dsa-foundations` — A*, the priority queue: the
  branching-search internals.
