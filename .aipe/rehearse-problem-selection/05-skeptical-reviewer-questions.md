# Skeptical Reviewer Questions — flattr

> The review-room questions, the answer that holds, the trap, and a one-line
> anchor for each. Coach posture: "say this, not that." The recurring move is
> the same one this whole book is built on — own the EVIDENCE/INFERENCE split
> before the reviewer forces it. Never fake demand.

## The discovery questions to answer before investing

Before the Q&A, here are the open questions this book cannot answer from the repo
— the things the discovery slice exists to resolve. A reviewer respects you more
for listing these than for pretending they're settled.

```
  open discovery questions — unanswered by the repo

  1. Does any real self-powered traveler feel grade-pain
     strongly enough to change tools?              ← the whole premise
  2. Shown both routes, do they CHOOSE the flat one
     for the grade (not for distance/familiarity)? ← the switching test
  3. Is free Open-Meteo elevation accurate enough
     that the colors don't lie?                    ← spec §11.A / §12 crux
  4. Is the differentiator (personalized userMax)
     actually felt vs. AccessMap's fixed bands?    ← spec §12 overlap risk
  5. Which neighborhoods do validated users actually
     travel — i.e. where would coverage pay off?   ← answer AFTER Q1-2
```

Now the pressure test.

---

## Q1. "Isn't this a solution looking for a problem? Defend the demand."

**The honest answer holds; a faked one collapses.**

> "Yes — and I'll name it before you do. The repo proves the problem is
> *technically solvable*: oracle-checked optimal routing, a measured algorithm
> progression, honest fallback, all on free data, on device. It proves *nothing*
> about demand — there are no users, no interviews, no analytics. The §3 user
> table in the spec is a hypothesis I wrote, not a finding. So the correct next
> investment isn't another feature — it's the cheapest experiment that turns that
> hypothesis into evidence: one neighborhood, five real travelers, A→B in flattr
> vs. Google Maps, measure which they pick and why."

```
  the answer's shape — own both columns

  "it WORKS"  ──┐
  (evidence,    ├──►  "...and demand is UNMEASURED.
   point at      │      here's the experiment that measures it."
   astar.test)  ─┘            ▲
                              └── this sentence is what reads as senior
```

- **Trap:** inventing a user count or "lots of people hate hills." The moment
  you assert demand you can't source, you've lost.
- **Anchor:** *"Proven solvable, unproven wanted — discovery is the next dollar."*

## Q2. "Why build the engine before validating the problem?"

> "Honestly, the build order was backwards for a *product* — and right for a
> *portfolio piece*. The engine is the DSA artifact: hand-rolled A*, admissible
> heuristic, the Dijkstra-oracle gate. If flattr's goal is to show I can build
> routing from the graph up, it's done. If the goal is a product, then I'm now at
> the point where the next move is discovery, not more code — which is exactly
> what `03` Option B recommends."

- **Trap:** pretending the build order was demand-driven. It wasn't; the spec is
  engineering-first (§14, §15). Own it.
- **Anchor:** *"Engine-first was right for the portfolio, and now discovery is
  the next move."*

## Q3. "Google Maps and AccessMap exist. Why does flattr get to exist?"

> "Google Maps optimizes distance/time and hides per-block grade in a smoothed
> curve — verifiable. AccessMap shows grade but with fixed pedestrian thresholds.
> flattr's claimed wedge is personalization: the route and the colors both key
> off one user-set ceiling, so a kick scooter's 'red' starts far below a hiker's.
> But — and this is the honest part — I have *not* validated that this
> personalization is a felt difference. Spec §12 already flags the AccessMap
> overlap as a risk. Whether the wedge matters to a real user is discovery
> question 4."

- **Trap:** overclaiming the differentiator as proven value. It's a plausible
  wedge, not a measured one.
- **Anchor:** *"The wedge is personalized grade; whether it's felt is unproven —
  it's a discovery question."*

## Q4. "What if elevation data is too coarse and the map lies?"

> "That's the load-bearing risk, and the spec names it first — §11.A calls
> elevation accuracy make-or-break, §12 says coarse data makes a map 'worse than
> nothing.' The pipeline runs on free Open-Meteo, which 429s under load and is
> resolution-limited. So route plausibility (metric 1c) is only as good as that
> data. The mitigation is in the slice: validate on *known-hilly* blocks where I
> can ground-truth the grade — if the colors disagree with reality there, I learn
> it before I scale."

- **Trap:** claiming accuracy is solved. It isn't; it's gated by the free-tier
  constraint.
- **Anchor:** *"Accuracy gates everything; I validate it on ground-truthable
  blocks first."*

## Q5. "Why not just add bidirectional A* / k-routes / city coverage next?"

> "Because all of those spend hours on the column that's already full. The engine
> works; demand is zero. `03` lays this out — Options C and D improve proven
> things and leave demand exactly as unknown. The only option that buys
> information about the unknown is the discovery slice. The senior move is to
> invest against the uncertainty, and the uncertainty is entirely on the demand
> side."

- **Trap:** treating more engine as obviously the next step because it's the fun,
  comfortable side.
- **Anchor:** *"Spend hours where the uncertainty is — that's demand, not the
  engine."*

## Q6. "What does success even look like here? Give me a number."

> "Two buckets. Available now, from the repo: A* equals Dijkstra on cost,
> expands fewer nodes, returns plausibly flatter routes on hilly pairs, and
> distinguishes 'no flat way' from 'no way.' Those prove the engine. The demand
> numbers — adoption, switching, trust — I deliberately won't fake; there's no
> product live, so there's no funnel. The first real number comes from the slice:
> of five travelers shown both routes, how many choose flattr *for the grade*.
> Three of five is my bar to consider investing further."

- **Trap:** producing a DAU/retention/market-size number. There's no product —
  any such number is fabricated.
- **Anchor:** *"Engine metrics now; demand metrics only after the five-traveler
  slice — and I won't invent the rest."*

## Q7. "When is the right call to just stop?"

> "If the slice comes back negative — travelers shrug, or pick the default route,
> or don't trust the colors — that's a *successful* experiment that says stop or
> pivot. And `03` Option A is legitimate even now: if flattr is explicitly a
> portfolio artifact, it's already done its job and there's nothing left to
> validate. The failure mode isn't stopping; it's pouring more solo-dev hours into
> a product premise no one tested."

- **Trap:** treating "stop" as failure. A cheap negative result is a win.
- **Anchor:** *"A cheap 'no' is a successful experiment; the real failure is
  building past an untested premise."*

## The meta-move under every answer

```
  the recovery pattern when pressed on demand

  reviewer pushes on "who wants this?"
            │
            ▼
  DON'T invent a user / number / market   ← instant credibility loss
            │
            ▼
  DO: "I don't have that evidence. Here's
       the experiment that would produce it,
       and the bar I'd hold it to."        ← reads as senior judgment
```

"I don't know yet — here's how I'd find out" beats a confident fabrication every
single time in a senior review.

## See also

- `00-overview.md` — the EVIDENCE/INFERENCE split every answer leans on.
- `03-options-and-opportunity-cost.md` — the `do nothing` / discovery reasoning
  behind Q5 and Q7.
- `04-success-metrics-and-feedback-loop.md` — the two-bucket metric story behind
  Q6.
- `docs/flattr-spec.md` §12, §15.1 — the spec's own honest-caveat framing this
  book extends from scale to demand.
