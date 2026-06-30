# Train / val / test — split BY USER, or you lie to yourself

**Industry name(s):** train/validation/test split; held-out evaluation.
**Type:** Industry standard (the discipline that makes a metric trustworthy).

## Zoom out — the split is the only thing that tells you the cost generalizes

A learned edge cost is trained on accept/reroute events. The split
decides which events train the model and which judge it. flattr has no
events and no model, so no split exists — but the *right* split is
non-obvious here and worth teaching as new ground: split **by user**, not
by event, or your test score is a fantasy.

```
  Zoom out — the split sits between data and training, off to the side
  of A* (A* never sees it)

  accept/reroute events (NOT collected)
        │
        │  split BY USER (NOT done)
        ▼
  ┌ train users ┐  ┌ val users ┐  ┌ test users ┐
  │ fit penalty │  │ tune k1k2 │  │ FINAL score│
  └──────┬──────┘  └─────┬─────┘  └─────┬──────┘
         └─────► cost.ts penalty() ◄────┘
                 (A* unaffected by the split)
```

The split never touches the router. It's purely an evaluation honesty
mechanism for the model that *would* sit behind `penalty()`.

## Structure pass

- **Layers:** all events → split → {train, val, test} → fit / tune /
  final-score.
- **Axis — by-event vs by-user.** Split by event and the same user
  appears in train *and* test; the model memorizes that user's
  preference and the test looks great but generalizes to nobody. Split by
  user and the test measures the only thing that matters: a *new* user.
- **Seam:** the grouping key. For flattr it's the user id on each event,
  not the edge or the route.

## How it works

### Move 1 — the mental model

In DSA terms you already know the trap: train/test on overlapping data is
like benchmarking a cache against the exact queries you warmed it with.
Of course it's fast — it's seen them. The fix is a *cold* held-out set.
For a per-user cost model, "cold" means a user the model has never
trained on.

```
  Pattern — group-aware split

  events ──► group by user ──► assign whole users to splits
                                 ┌ train: users A,B,C
                                 ├ val:   users D
                                 └ test:  users E
  NEVER: user A's events in both train and test
```

### Move 2 — the walkthrough

**Sub-step A — why by-user, concretely for flattr.**

```
  The leak — same user in train and test

  user A hates hills (reroutes every >5% edge)
  random split: A's events land in train AND test
  model learns "A reroutes steep edges"
  test: A's held-out events → model nails them → 95%!
  reality: new user B → model has no idea → fails
```

The grade penalty is *supposed* to be personalized (`userMax` is per
user). That's exactly why a by-event split lies: the model can cheat by
identifying the user, not learning the grade→effort relationship.

**Sub-step B — the three splits and their jobs.**

```
  Three sets, three jobs

  train (≈70% of users)  fit the cost: k1,k2 or GBT
  val   (≈15% of users)  tune: pick k1/k2 grid, model type, stop early
  test  (≈15% of users)  touch ONCE, at the end, for the reported number
```

The test set is sacred: every time you peek and adjust, you've leaked it
into your decisions and it stops being a held-out measure. Val absorbs
all the tuning.

**Sub-step C — flattr already has a split utility (different purpose).**

`pipeline/split.ts` exists — but it splits *edge geometry*, not data for
ML (it segments long edges so none exceed `MAX_SEGMENT_M`, config.ts:13).
Do not mistake it for a train/test split. The ML split would be new code,
keyed on user id.

```
  False friend — two unrelated "splits"

  pipeline/split.ts   → cut long edges into ≤12m segments (geometry)
  ML train/val/test   → partition USERS' events (does NOT exist)
```

### Move 3 — the principle

A held-out test set answers one question: *will this work on data it has
never seen?* The grouping key defines "never seen." For a personalized
cost where the user id is itself predictive, the only honest key is the
user — group-wise splitting. Get the key wrong and every downstream
number, every "we improved routing by X%," is measuring memorization.

## Primary diagram

```
  By-user split for flattr's cost model (none exists)

  all accept/reroute events (NOT collected)
        │  key = user id
        ▼
  ┌───────────┬──────────┬───────────┐
  │ TRAIN     │ VAL      │ TEST      │
  │ users A-C │ user D   │ user E    │
  │ fit cost  │ tune     │ score 1×  │
  └─────┬─────┴────┬─────┴─────┬─────┘
        ▼          ▼           ▼
     penalty()  pick k1k2   reported metric
   no user appears in two sets  ← the invariant
```

## Elaborate

There's a second leak to watch: *route* overlap. If user A's morning and
evening commute share edges, and you split A's events at all, those edges
correlate across the split. By-user splitting handles this for free
(A is wholly in one set), which is another reason to prefer it over
by-route. The amount of data flattr would need before any of this matters
is real — a handful of users isn't enough to hold one out — which is why
the honest first move is hand-tuned rules, not a model (see cold-start).

## Project exercises

### SPLIT.1 — by-user splitter for the cost dataset

- **Exercise ID:** SPLIT.1
- **What to build:** a `splitByUser(events, ratios)` function that
  partitions accept/reroute events into train/val/test *by user id*, with
  an assertion that no user id appears in more than one set.
- **Why it earns its place:** it encodes the one non-obvious decision
  (group key = user) and makes the leak structurally impossible.
- **Files to touch:** new `pipeline/cost-split.ts`,
  `pipeline/cost-split.test.ts` (assert disjoint user sets; assert ratios
  are approximately met by user count).
- **Done when:** the test proves the user-id sets are pairwise disjoint
  and a synthetic single-user dataset raises (too small to hold out).
- **Estimated effort:** half a day.

## Interview defense

**Q: You're building a personalized routing cost. How do you split your
data, and what's the trap?** Answer: split by user, not by event. The
cost is personalized (flattr's `userMax` is per-user), so a random split
lets the same user land in train and test — the model learns to identify
the user instead of the grade→effort relationship, and the test score is
inflated memorization. Group-wise by user makes "held-out" mean "a new
user," which is the only number that matters. Watch the false friend:
`pipeline/split.ts` splits edge geometry, not data.

```
  by-event split → user in train+test → memorize → fake score
  by-user split  → user in one set    → generalize → real score
```

Anchor: *"the user id is predictive, so it must be the grouping key —
otherwise the model cheats by recognizing the user."*

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — where the split sits in the pipeline.
- [02-feature-engineering.md](02-feature-engineering.md) — `steepEdges` as a feature-level leak.
- [11-cold-start.md](11-cold-start.md) — too few users to hold one out → hand-tuned rules first.
