# Problem Brief — flattr

> The 10-point core, in order. Each point is tagged **EVIDENCE** (provable from
> this repo) or **INFERENCE** (plausible, unproven — converted to a discovery
> question in `05`). Read the tag before you read the claim.

## Where the problem sits

Before the ten points, put the problem on the map. flattr lives entirely on the
client; there is no demand-sensing layer anywhere in the stack, which is exactly
why the right column of `00`'s diagram is empty.

```
  flattr — the whole system, with the missing layer marked

  ┌─ User / Demand layer ───────────────────────────────────┐
  │   ✗ NO USERS  ✗ NO ANALYTICS  ✗ NO INTERVIEWS           │ ← the gap
  │     (docs/flattr-spec.md §3 user table = hypothesis)     │   this book is about
  └───────────────────────────────┬─────────────────────────┘
                                  │  (no signal flows up)
  ┌─ Client layer (Expo / RN) ────▼─────────────────────────┐
  │   MapScreen.tsx · GradeSlider · RouteSummaryCard         │  ← SHIPS, works
  └───────────────────────────────┬─────────────────────────┘
                                  │  reads static artifact
  ┌─ Engine layer (TS, hand-rolled) ▼───────────────────────┐
  │   ★ astar.ts · cost.ts · pqueue.ts · graph.ts ★         │  ← PROVEN correct
  └───────────────────────────────┬─────────────────────────┘
                                  │  consumes
  ┌─ Build pipeline (offline) ────▼─────────────────────────┐
  │   osm.ts · elevation.ts · grade.ts → graph.json (544KB) │  ← PROVEN runs
  └─────────────────────────────────────────────────────────┘
```

Everything below the top band is real and tested. The top band is empty. Hold
that picture.

---

## 1. User or operational problem — who experiences what pain

**INFERENCE.** The asserted pain (`docs/flattr-spec.md` §1, §3): people who
travel under their own power — kick-scooter commuters, pedestrians avoiding
hills, wheelchair / stroller / rolling-luggage users — get routed by Google Maps
on shortest/fastest, which "hides per-block grade inside a smoothed elevation
curve." The claimed unmet need: *"a route that avoids what they can't comfortably
climb, and a map that shows where the flat is at a glance."*

What's real about this: the *mechanism* of the pain is concrete and correct.
Google Maps does optimize distance/time and does not expose per-segment grade.
That is verifiable. What is **not** verified: that any real person feels this
strongly enough to change tools. The §3 user table is the author's hypothesis,
not a research finding. There is no interview, no survey, no support ticket, no
forum quote anywhere in the repo.

> Coach note: in a review, say it like this — "The pain is *plausible and
> specific*, but I have not validated it. What I've validated is that it's
> *technically addressable*." Then point at the engine.

## 2. Evidence and current cost — what the repo proves

**EVIDENCE.** This is the strong column. The repo proves the problem is solvable
with free data and a hand-rolled engine:

```
  Proof chain — each link is a file you can open

  free data  ──►  grade graph  ──►  correct router  ──►  honest answer
  ─────────       ───────────       ─────────────       ─────────────
  pipeline/       split.ts          astar.ts            cost.ts:6
  osm.ts          grade.ts          + admissible h      BLOCKED = 1e9
  elevation.ts    → graph.json      (haversine)         (finite, not Inf)
  geocode.ts      544 KB, real      = A* == Dijkstra    → "flat vs.
                  (mobile/assets)     optimality gate     disconnected"
```

The load-bearing proofs, with line anchors:

- **Optimality gate** — `features/routing/astar.test.ts:38` asserts A* returns
  the *same* path cost as Dijkstra (`toBeCloseTo`, 6 digits); `:47,:51` assert
  A* expands `toBeLessThanOrEqual` Dijkstra's node count. Dijkstra is the oracle;
  A* is checked against it. This is real correctness rigor.
- **Search efficiency is measured, not asserted** — `bench/run.ts` runs Dijkstra
  → A* → bidirectional over fixed interior pairs and records `nodesExpanded`,
  `pushes`, `pops`, `ms`, `cost` per algorithm; `bench/report.ts` formats the
  table. The "fewer nodes for the same answer" claim is producible on demand.
- **The domain cost model is direction-aware** — `cost.ts` `penalty()` is free
  downhill (`g <= 0 → 0`), linear in the moderate band, quadratic in the steep
  band, `BLOCKED` over `userMax`. Signed by travel direction via
  `directedGrade`.
- **Honest fallback is a graph property, not a UI patch** — `BLOCKED = 1e9`
  (finite) at `cost.ts:6` means an only-steep path is still returned and flagged;
  `null` is reserved for a genuinely disconnected graph. Two distinct real
  states. See `.aipe/study-system-design/04-honest-fallback-routing.md`.
- **It ships** — `mobile/src/MapScreen.tsx` and friends render the graph on an
  Expo app; `graph.json` is a real 544 KB artifact, not a fixture.

**Current cost of the problem: unmeasured.** There is no number for how many
people are mis-routed, how much extra climb they suffer, or what a flat route
saves them. Zero. That blank is the single most important fact in this brief.

## 3. Why now — what changed or what cost compounds

**EVIDENCE (for the technical "why now") + INFERENCE (for the demand "why now").**

What genuinely changed and makes *building* this feasible now:

- Free, queryable street data (OSM via Overpass) and free elevation
  (Open-Meteo) both exist and the pipeline consumes them — `pipeline/overpass.ts`,
  `pipeline/elevation.ts`. You don't need a DEM license or a paid elevation API.
- On-device compute is enough to run A* over a bbox graph client-side; the Expo
  app does exactly this with a 544 KB artifact.

What has **not** changed in a way the repo can prove: any urgency on the demand
side. There is no "grade-aware routing is suddenly in demand" signal. The honest
"why now" is *"the tooling cost to attempt it dropped to zero"* — which is a
reason it's cheap to *try*, not a reason anyone is *waiting*.

## 4. Beneficiaries and exclusions

**INFERENCE (beneficiaries) / EVIDENCE (exclusions, via spec §13).**

Asserted beneficiaries (`docs/flattr-spec.md` §3) — all unproven as real users:

```
  one knob (userMax), three asserted user shapes

  userMax ~5%   ──►  kick scooter / push commuter   (INFERENCE)
  userMax ~8%   ──►  pedestrian avoiding hills       (INFERENCE)
  userMax ~5%   ──►  wheelchair / stroller / luggage (INFERENCE, "hard ceiling")
```

Note the slider story shifted in the actual build: git history shows commit
`b24797c` *"drop the max-grade slider, keep the preset buttons only."* So the
shipped knob is now **presets**, not a free slider — the "one number, everyone
sets their own red" framing from spec §2 is partly walked back in code. Name that
if asked; it's a small honesty point about the spec drifting from the build.

Intentional exclusions (spec §13, this is EVIDENCE of deliberate scoping):
turn-by-turn voice nav, live traffic, transit integration, crowdsourced hazards,
accounts/sync, the LLM destination parser. All explicitly out of v1.

## 5. Constraints — technical, product, time

**EVIDENCE.** All four are fixed and visible in the repo:

- **Free-tier data** — OSM + Open-Meteo only; Open-Meteo 429s under heavy
  testing (project context, external-data caveat). Accuracy is gated by free
  elevation resolution — spec §11.A calls grade accuracy "the make-or-break,"
  and coarse elevation produces "a map that lies about the steep blocks, i.e.
  worse than nothing" (§12).
- **Hand-rolled engine** — no third-party router (spec §14, locked). This is a
  *learning/portfolio* constraint, not a user constraint — important distinction.
- **Offline client** — static `graph.json`, no live backend. Limits coverage to
  prebuilt bboxes.
- **Single developer** — solo. Every feature competes with discovery for the
  same hours.

## 6. Options — including `do nothing`

Full treatment in `03-options-and-opportunity-cost.md`. The headline: because the
engine already works and demand is unproven, **`do nothing more on features`** is
a genuinely strong option, and the real fork is *discovery vs. more engine*.

## 7. Smallest useful scope — the narrowest validating slice

**The validating slice already mostly exists; the missing piece is putting it in
front of a human and watching.** Concretely:

```
  smallest slice that tests the PREMISE (not the engine)

  ┌─ ONE bundled neighborhood ──────────────────────────────┐
  │  prebuilt graph.json for a single hilly bbox             │  ← exists
  │  (e.g. downtown + Capitol Hill, spec §10 Phase 0)        │
  │                                                          │
  │  set endpoints  →  grade-routed path, colored by         │
  │  (A → B)            directedGrade  +  ONE climb number    │  ← exists
  │                     (RouteSummaryCard: distance, climbM,  │
  │                      steepCount — summary.ts)             │
  └──────────────────────────────────────────────────────────┘
        the NEW work is not code. it's: show this to 5 real
        self-powered travelers and measure if the flat route
        beats the Google Maps route in their judgment.
```

The engine, the colored path, and the climb number (`routeSummary` →
`distanceM`, `climbM`, `steepCount`) are all built. The validating *act* — does a
real walker/scooter-rider prefer flattr's route over the default one — has never
been done. That act is the slice. Full cut in `02`.

## 8. Non-goals and cuts

**EVIDENCE (spec §13) + this book's recommended cuts.** Explicit non-goals:
city-wide coverage, turn-by-turn, accounts, multi-modal/transit. Detailed in
`02-scope-cuts-and-non-goals.md`.

## 9. Success metrics — observable outcomes + feedback loop

Split into **available-now** (engine correctness, bench numbers, route
plausibility — all measurable today) vs. **needs-users** (adoption, switching,
trust — measurable only with the discovery slice). Full treatment in
`04-success-metrics-and-feedback-loop.md`.

## 10. Risks and objections

The review-room questions and the answers that hold are in
`05-skeptical-reviewer-questions.md`. The sharpest one: *"You built a solution
looking for a problem — defend the demand."* The answer is not to fake demand;
it's to own the EVIDENCE/INFERENCE split and name the discovery slice.

---

## The brief in one line

You can prove flattr **works**. You cannot prove anyone **wants** it. The
correct investment is the cheapest experiment that converts the §3 user table
from hypothesis into evidence — not another algorithm.

## See also

- `00-overview.md` — the EVIDENCE/INFERENCE split this brief is built on.
- `03-options-and-opportunity-cost.md` — why discovery beats more engine.
- `.aipe/study-dsa-foundations/05-graphs-and-traversals.md` — the A*/Dijkstra
  foundation behind the optimality gate.
