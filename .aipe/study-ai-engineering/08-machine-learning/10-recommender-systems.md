# Recommender systems — no strong home; faintest analog is a userMax preset suggestion

**Industry name(s):** recommender system / recommendation engine
(collaborative filtering, content-based). **Type:** Industry standard
(huge in product ML; absent here).

## Zoom out — flattr recommends nothing; the only seam is suggesting a userMax preset

Recommenders predict what a user will want from many candidates —
products, videos, songs — usually by learning from many users'
interactions (collaborative filtering). flattr has no catalog, no
many-user interaction matrix, and no recommendation surface. The
faintest analog is *suggesting a userMax preset* (classify.ts:46) to a new
user — and even that is best done as a content-based *rule*, single-user,
not a collaborative recommender. This file teaches the concept as new
ground and is honest about the absence.

```
  Zoom out — where a recommender would sit (it doesn't)

  ┌─ a RECOMMENDER (does not exist) ─┐
  │ many users × many items matrix    │
  │ predict user→item preference       │
  └────────────────────────────────────┘
        │ flattr has no catalog, no item set, no cross-user matrix
        ▼
  faintest analog: pick a userMax PRESET for a new user
  USERMAX_PRESETS (classify.ts:46): Kick scooter 5 / Walking 8 / Any 15
  → a single-user, content-based RULE, not a recommender
```

## Structure pass

- **Layers:** user-item interactions → similarity / model → ranked
  recommendations.
- **Axis — collaborative vs content-based.** Collaborative needs many
  users (flattr has ~none in this design). Content-based needs only item
  features and one user's context — which is the only feasible flavor here.
- **Seam:** `USERMAX_PRESETS` (classify.ts:46). The "recommendation" is
  picking one preset; the "items" are three presets, the "user" is one
  person.

## How it works

### Move 1 — the mental model

A recommender is a ranking over a catalog, personalized to a user. The two
families: *collaborative* ("users like you also chose X" — needs a crowd)
and *content-based* ("you liked steep-tolerant settings, here's another"
— needs only item attributes + this user). flattr has no crowd and a
catalog of three, so collaborative is off the table by construction.

```
  Pattern — two recommender families

  collaborative:  user×item matrix → "people like you liked…"
                  NEEDS many users (flattr: ~none)
  content-based:  item features + THIS user's context → match
                  NEEDS only one user (flattr: feasible, trivially)
```

### Move 2 — the walkthrough

**Sub-step A — the only candidate: preset suggestion.**

```
  classify.ts:46 — the "catalog" is three presets

  USERMAX_PRESETS = [
    { label: "Kick scooter", userMax: 5 },
    { label: "Walking",      userMax: 8 },
    { label: "Any",          userMax: 15 },
  ]
  "recommend" = pick one for a new user before they've routed anything
```

**Sub-step B — why it's a rule, not a recommender.**

```
  Content-based RULE for the preset (not ML)

  signal: device/mobility hint ("I use a scooter") → userMax 5
          or: observed reroutes on >8% edges       → suggest a lower max
  this is if/else on one user's context, a catalog of 3
  calling it a "recommender system" oversells a lookup table
```

A 3-item catalog with one user is a lookup, not a recommender. The honest
framing is "rule-based preset suggestion," which becomes interesting only
if it *adapts* from the user's own reroute history (still single-user,
content-based, no crowd).

**Sub-step C — what a real recommender would require (and flattr lacks).**

```
  Missing pieces for a true recommender

  a catalog of many items          flattr: 3 presets
  many users' interaction history  flattr: local-first, one user
  a ranking/prediction model       flattr: none
  → all three absent → no recommender home
```

### Move 3 — the principle

Recommenders live on *many users × many items*. flattr is local-first,
single-user, with a 3-item preset catalog — it has neither axis. The
mature answer is to recognize that a content-based, single-user *rule* for
the userMax preset is the entire opportunity, and not to inflate it into
a collaborative recommender. Match the technique to the data you have:
one user, three items, a clear context signal — that's an if/else.

## Primary diagram

```
  Recommender vs flattr's preset suggestion (faintest analog)

  REAL RECOMMENDER (not in flattr)
  many users × many items → personalized ranking
        │ needs a crowd + a catalog
        ▼ flattr has neither

  flattr's only seam (content-based RULE)
  ┌─ USERMAX_PRESETS (classify.ts:46) ─┐
  │ scooter 5 · walking 8 · any 15      │  catalog = 3
  └─────────────┬───────────────────────┘
  one user's context (device / reroute history)
        │
        ▼ if/else → suggest a preset  (NOT a recommender)
```

## Elaborate

The adaptive version is where this gets *slightly* real without becoming a
recommender: watch the user's own accept/reroute events (the same data the
learned cost would use) and, if they keep rerouting around 6% grades,
suggest dropping their userMax from "Walking 8" toward "Kick scooter 5."
That's single-user, content-based, and rule-driven — it personalizes from
*one* person's behavior, never a crowd. It also stays inside flattr's
local-first, privacy-respecting design: no cross-user data leaves the
device, which is exactly why collaborative filtering doesn't fit (it needs
to pool users centrally). The privacy posture and the recommender absence
are the same coin.

## Project exercises

### REC.1 — adaptive userMax preset suggestion (single-user rule)

- **Exercise ID:** REC.1
- **What to build:** a `suggestPreset(rerouteHistory)` function that maps a
  user's recent reroute grades to a recommended preset from
  `USERMAX_PRESETS` — a single-user, content-based rule.
- **Why it earns its place:** it captures the only recommendation-shaped
  opportunity in flattr while staying honest that it's a rule, not a
  collaborative recommender, and stays local-first.
- **Files to touch:** new `features/grade/suggest-preset.ts` (reads
  `USERMAX_PRESETS` from `classify.ts`), `suggest-preset.test.ts` (a user
  who reroutes 6% edges gets a lower preset suggested).
- **Done when:** the function returns one of the three presets and the test
  shows the suggestion shifts down as reroute grades drop — with no
  cross-user data involved.
- **Estimated effort:** half a day.

## Interview defense

**Q: Is there a recommender opportunity in flattr?** Answer: not a real
one. Recommenders need many users and a catalog; flattr is local-first,
single-user, with a 3-item preset list (`USERMAX_PRESETS`). The faintest
analog is suggesting a userMax preset to a new user, but that's a
content-based *rule* on one person's context — adapting from their own
reroute history — not collaborative filtering. I'd build it as an if/else,
and I'd be explicit that calling a 3-item single-user lookup a
"recommender system" oversells it. The privacy design (no cross-user data)
is also why collaborative filtering structurally doesn't fit.

```
  recommender needs: many users × many items
  flattr has: one user × 3 presets → content-based RULE, not a system
```

Anchor: *"`USERMAX_PRESETS` (classify.ts:46) is a 3-item catalog for one
user — there's no crowd to collaboratively filter."*

## See also

- [11-cold-start.md](11-cold-start.md) — picking a preset for a brand-new user is the cold-start case.
- [02-feature-engineering.md](02-feature-engineering.md) — reroute history as the single-user signal.
- [12-on-device-inference.md](12-on-device-inference.md) — why local-first rules out collaborative pooling.
