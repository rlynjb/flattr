# Cold Start

*Industry name: the cold-start problem — no data for a new user or item.*

## Zoom out

```
THE EMPTY-HISTORY TRAP
new rider ──► model has 0 past routes ──► no basis to predict ──► ???
new edge  ──► 0 riders have used it    ──► no signal           ──► ???
```

Any model that learns from history fails on the thing with no history yet: the user who
just signed up, the street that just got added. Cold start is *the* recurring pain of
learned-preference systems (file 10). flattr is interesting because it **sidesteps cold
start entirely** — by being deterministic, it needs no history to give a great first answer.
New ground.

## How it works

### Move 1 — the mental model: a model is only as good as its history

```
WARM (lots of history)          COLD (none)
rider with 200 routes ──► sharp   brand-new rider ──► model shrugs,
personalized prediction            falls back to a generic guess
```

The fix is always "what do you do *before* you have data?" — and every answer is a partial
retreat from personalization.

### Move 2 — the standard cold-start tactics (and why flattr needs none)

If flattr had a *learned route-preference* model (file 10), a new rider would cold-start:

1. **Popularity fallback** — recommend what's popular overall until you learn the user.
2. **Content/feature fallback** — use known *attributes* (rider sets `userMax`) instead of
   *history* to bootstrap a profile.
3. **Onboarding elicitation** — ask a few preference questions up front.
4. **Hybrid decay** — start generic, blend in personalization as history accumulates.

Now the honest contrast — **flattr's first route is already optimal:**

```
LEARNED-PREFERENCE APP            flattr
new rider, route 1: weak guess    new rider, route 1: PROVABLY optimal
needs N rides to warm up          needs 0 rides — A* + cost.ts is complete
                                  from day one
```

flattr's "knowledge" lives in the **graph + cost function**, not in per-rider history. A
first-time user gets the same fully-optimized, lowest-cost path as a veteran. There is no
warm-up curve because there is nothing to warm up.

### Move 3 — the principle

**If your system's intelligence is in a *defined objective* rather than *accumulated user
data*, cold start vanishes.** This is a strong, underrated argument for deterministic
optimization: no cold start, no per-user data to collect/store/leak, identical quality for
everyone on day zero.

## In this codebase

**NOT YET EXERCISED — flattr has no learned model, so there is no cold-start problem.** The
graph (`data/graph.json`) and cost (`features/routing/cost.ts`) are complete the moment the
app installs; A* (`features/routing/astar.ts`) returns the optimum on the very first query.
The only per-user input is `userMax` (a setting from `classify.ts` presets), which is a
*parameter*, not a *learned history* — so even that doesn't cold-start.

Cold start would appear only if a learned route-preference model (file 10) were added.
flattr's actual learnable seam — a constrained ≥0/monotone cost in `cost.ts` (file 04) —
is trained *offline on edges, not online per rider*, so it also wouldn't cold-start at the
user level. `classify.ts` is a threshold table; it has no history and needs none.

## See also

- `10-recommender-systems.md` — the learned-preference world where cold start lives
- `06-domain-gap.md` — the *new-city* cold-start of a learned cost model (different axis)
- `01-supervised-pipeline.md` — the history-collection loop flattr never built
</content>
