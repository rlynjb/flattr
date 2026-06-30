# Domain gap — graph built from one city, used elsewhere (faint but real)

**Industry name(s):** domain gap / distribution shift / train-serve skew
(spatial flavor). **Type:** Industry standard concern.

## Zoom out — flattr's graph is one Seattle slice; a cost fit there may not transfer

Domain gap is when the data you trained on differs systematically from
the data you serve on. flattr has no trained model, so no learned cost
has a gap yet — but the *graph itself* is built from one small place
(Capitol Hill, Seattle — config.ts:10), and that's a real, concrete
domain-gap setup waiting to happen the moment a learned cost trained
there gets pointed at another city.

```
  Zoom out — the gap lives between BUILD (one city) and a future
  learned cost serving elsewhere

  BUILD: pipeline reads OSM+elevation for BBOX (Capitol Hill, Seattle)
         config.ts:10  → mobile/assets/graph.json
        │
        ▼  IF a cost were fit on THIS graph's grade distribution…
  SERVE: …and shipped to flat Amsterdam or hilly San Francisco
        │
        ▼  ★ cost.ts penalty() now sees grades it never trained on
           = domain gap
```

The hand-tuned `penalty()` is gap-immune (it's a formula, not fit to a
city). A *learned* cost would inherit Seattle's grade distribution and
carry that bias to wherever it serves.

## Structure pass

- **Layers:** training domain (one bbox) → distribution shift → serving
  domain (another city/user/season) → degraded predictions.
- **Axis — same-distribution vs shifted.** The hand-tuned penalty assumes
  nothing about the city, so it's robust. A fit model assumes the
  training city's grade/surface mix.
- **Seam:** the build-time bbox (`BBOX`, config.ts:10) defines the
  training domain. The serve-time city defines the gap.

## How it works

### Move 1 — the mental model

A model is a compression of the data it saw. Point it at data with a
different shape and it extrapolates badly — confidently wrong on a
distribution it never met. You've felt the analog in frontend: a layout
tuned on your laptop that breaks on a small phone. Same idea, the
"viewport" is the data distribution.

```
  Pattern — domain gap

  train domain          serve domain
  ┌ Seattle grades ┐    ┌ Amsterdam grades ┐
  │ flat..15%, hilly│   │ ~0-2%, very flat  │
  └────────┬────────┘   └────────┬──────────┘
           └──── model fit here ─┘ extrapolates wrong
```

### Move 2 — the walkthrough

**Sub-step A — flattr's training domain is explicitly small.**

```
  config.ts:10 — the training domain is a deliberate slice

  BBOX = [-122.3284, 47.6181, -122.3214, 47.6241]
  // "a small Capitol Hill slice, Seattle … steep area"
  // kept small to stay under free API rate limits
```

The comment is honest: small, steep, Seattle. A cost fit on these edges
learns Seattle-Capitol-Hill grade statistics. The grade *penalty curve*
might be city-agnostic in truth (an 8% grade is an 8% grade anywhere),
but a fit model can pick up spurious correlations — e.g. Seattle's
surface mix, block lengths, crossing density — that don't hold elsewhere.

**Sub-step B — the kinds of shift to expect.**

```
  Three gaps a learned flattr cost could hit

  geographic   another city: different grade/surface distribution
  user         a wheelchair user vs a jogger: different effort curve
  temporal     winter ice vs summer: same edge, different real cost
```

The user gap connects to the by-user split (`03-train-val-test.md`): test
on a held-out *user* and you measure resistance to the user gap directly.

**Sub-step C — why the hand-tuned penalty is the safe default.**

```
  Robustness — formula vs fit

  penalty() = k1·g, k2·(g-half)²   ← no city baked in, transfers
  learned f(x) fit on Seattle      ← carries Seattle's distribution
  → keep the formula as a FALLBACK when serving a new domain
```

### Move 3 — the principle

A learned model is only valid on the distribution it trained on. flattr's
graph comes from one explicit bbox, so any cost fit on it owns that
city's biases. The mitigation isn't clever — it's to measure the gap
(compare grade distributions across cities) and keep the city-agnostic
hand-tuned penalty as the fallback for domains you haven't trained on.
That's the same instinct as cold-start: rules where there's no data.

## Primary diagram

```
  Domain gap for a future flattr learned cost

  ┌─ TRAIN domain (real today) ─────────────┐
  │ Capitol Hill, Seattle  [config.ts:10]    │
  │ steep, specific surface/block mix         │
  └──────────────┬───────────────────────────┘
                 │ ship the model elsewhere
  ┌─ SERVE domain (the gap) ─▼──────────────┐
  │ flat city / different user / winter       │
  │ grades & surfaces the model never saw     │
  └──────────────┬───────────────────────────┘
  ┌─ mitigation ─▼──────────────────────────┐
  │ measure distribution shift (PSI)          │
  │ fall back to formula penalty() off-domain │
  └───────────────────────────────────────────┘
```

## Elaborate

The clean way to *detect* domain gap is the same statistic used for drift
(`15-drift-detection.md`): compare the grade (or surface) distribution of
the serving city against the training city with a population-stability
index. A high PSI says "you're off-domain, don't trust the learned cost
here." This is why drift and domain gap are siblings — drift is the gap
appearing *over time* in the same place; domain gap is the same shift
appearing *across place* at once. flattr's single-bbox build makes the
cross-place version concrete and the temporal version hypothetical.

## Project exercises

### GAP.1 — grade-distribution profile per graph

- **Exercise ID:** GAP.1
- **What to build:** a script that, given a `graph.json`, prints the
  histogram of `absGradePct` across edges — the "domain fingerprint" you'd
  compare between two cities to quantify the gap.
- **Why it earns its place:** it makes domain gap measurable instead of
  hand-wavy, and reuses real `Edge.absGradePct` data.
- **Files to touch:** new `pipeline/grade-profile.ts`,
  `pipeline/grade-profile.test.ts` (assert the histogram sums to the edge
  count; assert it runs on the bundled Capitol Hill graph).
- **Done when:** the script outputs a grade histogram for
  `mobile/assets/graph.json` and the test locks the bin counts.
- **Estimated effort:** half a day.

## Interview defense

**Q: flattr's graph is one Seattle neighborhood. What happens when you
expand?** Answer: the hand-tuned penalty is fine — it's a formula with no
city baked in. The risk shows up only if I *learn* the cost: a model fit
on Capitol Hill's steep, Seattle-specific grade and surface distribution
carries that bias to a flatter city, that's domain gap. I'd detect it by
comparing grade distributions (PSI) between cities and fall back to the
formula penalty off-domain. It's the spatial twin of drift, and the
by-user split already guards the per-user version of the gap.

```
  formula penalty → transfers (no city baked in)
  learned cost on one city → owns its distribution → gap elsewhere
```

Anchor: *"`config.ts:10` defines the training domain as one small Seattle
bbox — a learned cost inherits exactly that."*

## See also

- [15-drift-detection.md](15-drift-detection.md) — the temporal twin; same PSI statistic.
- [03-train-val-test.md](03-train-val-test.md) — by-user split guards the user gap.
- [07-transfer-learning.md](07-transfer-learning.md) — adapting a model across domains.
- [11-cold-start.md](11-cold-start.md) — formula fallback when off-domain or data-poor.
