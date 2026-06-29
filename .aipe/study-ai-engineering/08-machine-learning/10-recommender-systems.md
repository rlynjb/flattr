# Recommender Systems

*Industry name: recommender systems — predicting user preference from behavior.*

## Zoom out

```
RECOMMENDER                       flattr
"what will THIS user prefer?"     "what is the OBJECTIVELY flattest route?"
 learned from behavior             computed from physics
 ┌────────────────────┐           ┌────────────────────┐
 │ user × item ratings │          │ A* over graph cost  │
 │ → predicted taste   │          │ → provable optimum  │
 └────────────────────┘           └────────────────────┘
   subjective, per-person           same answer for everyone
```

A recommender predicts what a *specific user* will like — Netflix rows, Spotify mixes,
"routes you might enjoy." Its truth is **subjective and personal**: there's no single right
answer, only what *this* user prefers. flattr is the deliberate opposite — it computes an
**objective optimum**. Worth studying precisely as the contrast. New ground.

## How it works

### Move 1 — the mental model: fill in the blanks of a preference matrix

```
        route A   route B   route C
rider 1   5         ?         2
rider 2   ?         4         ?      ← recommender predicts the "?" cells
rider 3   3         ?         5         from patterns in the filled ones
```

The core trick (collaborative filtering): riders who agreed on past routes will likely
agree on new ones. Factorize the sparse matrix into latent "taste" vectors, predict the
blanks. Content-based variants instead match item features to a learned user profile.

### Move 2 — what flattr would have to become (and refuses to)

To recommend routes, flattr would need:

1. **Per-user history** — which routes each rider took/rated. flattr stores none; it has no
   user accounts in the routing path.
2. **A learned preference signal** — a fitted model of "rider 1 likes shade / hates
   crossings." flattr has exactly one global knob: `userMax` (from
   `classify.ts` presets — 5/8/15%), which is a *parameter the user sets*, not a preference
   *learned* from behavior.
3. **A ranking, not a winner** — recommenders return a *list* you might like. flattr's A*
   (`features/routing/astar.ts`) returns **the** lowest-cost path — a single provable answer.

The contrast is the lesson:

```
RECOMMENDER                    flattr's A*
output = ranked guesses        output = the optimum
truth  = user's reaction       truth  = the cost function (file 04)
fails  = bad taste match       fails  = wrong cost function, never "bad taste"
```

### Move 3 — the principle

**Recommendation optimizes a *learned subjective* target; routing optimizes a *defined
objective* one.** When the right answer is well-defined (shortest, flattest), you *compute*
it — you don't *learn* it. Reaching for a recommender where an optimum exists adds data
dependence, cold-start (file 11), and bias for no gain.

## In this codebase

**NOT YET EXERCISED — flattr recommends nothing; it solves an optimization.** Every route
comes from A* minimizing the cost in `features/routing/cost.ts`. There is no preference
model, no per-user matrix, no ranking of "routes you might like." This is a *design choice*,
not a gap: a flatness objective has a correct answer, so flattr computes it deterministically
and returns the same route to every rider with the same `userMax`.

If flattr ever recommended *places* ("flat cafés near you") or learned per-rider comfort, it
would inherit the whole recommender stack including cold-start. The one learnable seam
(`cost.ts`) is a *cost regression*, not a preference recommender — and even it is constrained
≥0/monotone (file 04). `classify.ts` is a threshold table, not a preference model.

## See also

- `11-cold-start.md` — the new-rider problem flattr sidesteps by being deterministic
- `04-model-selection.md` — the cost regression that is the real (non-recommender) seam
- `01-supervised-pipeline.md` — the data loop a recommender would need and flattr lacks
</content>
