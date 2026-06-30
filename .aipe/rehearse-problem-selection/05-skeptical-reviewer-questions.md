# Skeptical Reviewer Questions

This is the review room. Coach posture: for each question you get the
sharp version, the answer that holds, the diagram you'd sketch while you
talk, and a one-line anchor. The rule throughout — **never defend an
inference as if it were evidence.** The strongest answers concede the
gap and name the cheap experiment.

---

## Q1. "AccessMap already does hill-avoidance for pedestrians. Why does this exist?"

The incumbent question. The spec itself names AccessMap (§1, §12) — don't
pretend it doesn't exist.

```
  AccessMap vs flattr — where the wedge is (asserted)

  ┌─ AccessMap ───────────┐      ┌─ flattr ──────────────┐
  │  fixed pedestrian      │      │  user-set max grade    │
  │  grade thresholds      │  vs  │  (userMax) drives BOTH │
  │  one threshold for all │      │  routing cost AND map  │
  │                        │      │  colors off one number │
  └────────────────────────┘      └────────────────────────┘
   incumbent, real users           the wedge — UNVALIDATED
```

**The answer that holds:** "The asserted wedge is personalization — a
kick scooter's tolerable grade is far lower than a hiker's, and flattr
keys both the router and the map colors off one user-set number
(`userMax`, spec §2). That's a real *design* difference — `cost.ts:16-22`
parameterizes the penalty on `userMax`. But whether that difference
*matters to users* versus AccessMap's fixed thresholds is an
**inference**, not something the repo proves. AccessMap has users; I have
an oracle-correct router and zero users. The honest move is to test the
wedge against AccessMap directly with one real walker before claiming
it's better."

**Anchor:** "The wedge is real in code, unproven with humans — and I'd
test it head-to-head, not assert it."

---

## Q2. "90m DEM smooths exactly the short steep pitches that matter most. Isn't your core data too coarse to trust?"

The sharpest technical objection, and the spec concedes it (§12: "grade
accuracy is the whole product").

```
  The DEM resolution problem — what gets smoothed

  real terrain:   ___/▔▔\___/▔▔▔\__   short steep pitches
  90m DEM sample: ___╱▔▔▔▔▔▔▔▔▔╲___   pitches averaged out
                       ▲
              a 30m-long 12% ramp can read as 4% — the user
              hits a wall the map painted green
```

**The answer that holds:** "Correct, and it's the biggest real risk to
the product. Open-Meteo's 90m DEM (`pipeline/elevation.ts`) averages
elevation across a span longer than many of the pitches that actually
stop a kick scooter. I mitigate at the edges — the pipeline splits ways
to ~12m segments before sampling, so I'm not assigning one grade to a
whole block — but I can't recover detail the source doesn't have. This is
option D in my options analysis: harden accuracy with a finer DEM, almost
certainly paid, which breaks the free-tier constraint. I'd only spend
that *after* a user tells me distrust of the colors — not lack of
interest — is what stops them. Otherwise I'd be buying precision nobody
asked for."

**Anchor:** "Grade accuracy is the whole product and 90m is coarse — I'd
fix it only when a user proves trust is the blocker."

---

## Q3. "You dropped your own central slider for three presets (b24797c) before a single user touched it. Didn't you just walk back your core thesis?"

The question that proves the reviewer read the git log. Don't get
defensive — this is your most useful piece of free signal.

```
  b24797c — the walk-back, named honestly

  THESIS (spec §2)          SHIPPED (b24797c)
  ┌────────────────┐        ┌────────────────┐
  │ "one slider,    │       │  🛴 5%          │
  │ everyone sets   │  ──►   │  🚶 8%          │
  │ where red       │       │  🏔️ 15%         │
  │ begins"         │        │  3 fixed presets│
  │ 14 settings     │        │  "Per request"  │
  └────────────────┘        └────────────────┘
   continuous personalization → quantized to 3 buckets
```

**The answer that holds:** "Yes — partially, and I'd flag it as exactly
that. The thesis was continuous personalization: one slider, your number.
`b24797c` quantized it to three presets, and the commit says 'Per
request.' That's a narrowing of the central wedge, made before any user
asked for the granularity. Two honest reads: either continuous control
was overkill and three named buckets (scooter / walking / any) are
clearer — which would be a *finding*, if a user had produced it — or I
simplified the UX to feel shippable and quietly shrank the differentiator.
I can't tell which, because there's no user behind 'Per request.' Note
that the underlying engine still takes a continuous `userMax`
(`cost.ts`), so the thesis is intact in code; only the input got
quantized. Reversing it is a one-component change. This is precisely the
kind of decision I'd want a real user to drive instead of a vibe."

**Anchor:** "It's a real partial walk-back of the wedge, the engine still
supports the full thesis, and it's the kind of call a user should make,
not me."

---

## Q4. "One 0.35 km² neighborhood. How does proving anything there generalize?"

The scope-skeptic question.

```
  One neighborhood — what it does and doesn't prove

  PROVES (EVIDENCE)              DOESN'T PROVE (INFERENCE)
  ─────────────────              ────────────────────────
  router is correct here ✓       it scales to a city
  honest fallback fires  ✓       demand exists anywhere
  grade constrains paths ✓       free-tier survives scale
  (Capitol Hill is steep
   on purpose — config.ts)
```

**The answer that holds:** "It proves the *mechanism*, not the *market*.
Capitol Hill was chosen because it's steep (`pipeline/config.ts`) — a
flat neighborhood would make the product invisible, so this is the
hardest validating ground, not the easiest. Correctness generalizes: the
oracle and bench run on synthetic grids of any size, and the algorithm
doesn't care about the bbox. What does *not* generalize from one
neighborhood is demand — and scaling coverage (option C) is weeks of work
against the free-tier rate limit and the offline bundle-size constraint.
I deliberately don't pay that cost until the one-walker test says people
want it where they live."

**Anchor:** "One steep neighborhood proves the mechanism; generality of
demand is unproven and I won't buy coverage before signal."

---

## Q5. "Where are your users? Show me one piece of demand evidence."

The question the whole book is built to answer. Do not flinch, do not
fabricate.

```
  The demand question — answered with honesty, not a TAM slide

  ┌─ what I have ─────────────┐   ┌─ what I don't ──────────┐
  │ oracle-correct router  ✓  │   │ users              ✗    │
  │ bench-measured A*      ✓  │   │ telemetry          ✗    │
  │ shipped on a city      ✓  │   │ research / surveys ✗    │
  │ honest fallback        ✓  │   │ adoption numbers   ✗    │
  └───────────────────────────┘   └─────────────────────────┘
        Claim A: PROVEN              Claim B: UNPROVEN
```

**The answer that holds:** "I have none, and I won't invent any. There's
no analytics SDK in `mobile/package.json`, no telemetry, no deployment —
I checked. What I have is proof the problem is *technically* solvable:
a hand-rolled directional A*, an A*==Dijkstra optimality oracle in CI,
bench numbers showing 3.9–7.4× fewer expansions than Dijkstra, an honest
finite-BLOCKED fallback that distinguishes 'no flat route' from 'no
route,' and a working Expo app on a real Seattle neighborhood. What I
*don't* have is any evidence a human wants it. The cheapest way to get
that is one self-powered traveler, one route they know, one question:
'is this the path you'd actually take?' I'd run that before writing
another line — and if the answer is no, do-nothing and 'this is a strong
algorithm artifact' are both real, honest landing spots."

**Anchor:** "Technically solvable: proven. Worth solving: unproven. I'd
spend one afternoon, not one month, to find out which."

---

## Q6. "Why hand-roll the router at all? Valhalla or OSRM would route in a weekend."

The build-vs-buy challenge.

```
  Hand-rolled vs off-the-shelf — the constraint behind it

  ┌─ buy (Valhalla/OSRM) ─┐      ┌─ build (this repo) ───┐
  │ routes in a weekend    │      │ graph + A* from        │
  │ but it's a black box   │  vs  │ scratch — the WORK is  │
  │ for grade-cost tuning  │      │ the artifact (spec §14)│
  └────────────────────────┘      └────────────────────────┘
```

**The answer that holds:** "Deliberate, and it's a constraint, not an
oversight (spec §14: no Valhalla/OSRM/GraphHopper — the graph work is the
point). Two reasons hold. First, the product's whole value is a custom
directional grade-penalty cost function (`cost.ts:16-22`) — off-the-shelf
routers don't expose cost tuning at that granularity cleanly. Second,
this is a portfolio repo for a frontend-to-AI/systems pivot; a
hand-rolled, oracle-verified, benchmarked A* is the artifact. If demand
validated and scale became the bottleneck, swapping to a hardened engine
is a defensible later move — but that's option C territory, after a user
says yes."

**Anchor:** "Hand-rolling is the point of the artifact and the cost
function needs the control — buying is a post-validation option."

---

## The review room, in one frame

```
  Every answer collapses to the same honest spine

  ┌────────────────────────────────────────────────────────┐
  │  EVIDENCE (file:line)        →  defend hard, it's proven │
  │  INFERENCE (about humans)    →  concede, name the cheap  │
  │                                 experiment, keep         │
  │                                 do-nothing live          │
  │                                                          │
  │  the move that wins the room: refuse to launder an       │
  │  inference into a fact. one walker, one route, one       │
  │  question — before another line of code.                │
  └────────────────────────────────────────────────────────┘
```

That's the book. The engine is built and provably correct. Whether it's
worth more of your time is one honest afternoon away — and you don't get
to skip it.
