# Options and Opportunity Cost — flattr

> Four options, including `do nothing`. Each names what it buys and what it costs
> you to choose it (the opportunity cost = the next-best option you give up).
> Coach posture: there's a recommended call, and it's stated up front.

## The verdict first

> **Recommended: Option B — run the discovery slice.** It is the only option
> that buys information about the empty column (demand). Every other option
> spends solo-dev hours improving the column that's already full (solvability).

Now the four options, and why B wins.

## The decision in one frame

```
  flattr — four moves, what each buys, what each gives up

                    buys you...              opportunity cost
                    ───────────              ────────────────
  A  do nothing     a finished portfolio     never learn if anyone
     (ship as-is)   artifact, zero new       wants it; no demand datum
                    risk                      ever

  B  discovery ★    the FIRST real demand     ~1-2 weeks of dev time
     slice          signal (5 travelers,      (and the answer might be
                    one bbox, A→B prefs)      "no one cares")

  C  more engine    a more impressive         hours sunk into the PROVEN
     (bidir, k-alt) DSA portfolio piece       column; demand still 0

  D  more coverage  a bigger map              cost-before-demand; free
     (multi-city)   (city-scale graph)        elevation 429s; still 0 demand
```

Read the right column top to bottom. Three of four options pay their cost into a
column that's already full. Only B pays into the empty one.

## Option A — do nothing more (ship/freeze as-is)

**This is a real option, not a strawman.** flattr today is a working, tested,
on-device grade-aware router with a clean correctness story. As a *portfolio
artifact* it already does its job: it proves Rein can build a routing engine from
the graph up, with an admissible heuristic, an oracle-checked optimality gate,
a measured algorithm progression, and an honest fallback.

- **Buys:** a finished, defensible artifact. Zero new risk. Frees 100% of hours
  for other projects in the pivot-to-AI arc (`me.md`).
- **Opportunity cost:** you never find out if the *problem* is real. The §3 user
  table stays a hypothesis forever. If flattr's value is "I built a router,"
  that's fine; if its value is "I solved a real travel problem," A forecloses it.
- **When A is correct:** if flattr is explicitly a DSA/system-design portfolio
  piece and *not* a product attempt. Then there's nothing to validate — the
  artifact is the deliverable. Be honest about which one it is.

## Option B — run the discovery slice  ★ recommended

Build nothing new; bundle one neighborhood and put the existing colored-path +
climb-number UI in front of 5 real self-powered travelers (full cut in `02`).

- **Buys:** the first demand evidence flattr has ever had. Converts the empty
  column of `00`'s diagram into a data point — even a *negative* result is a win
  (it cheaply kills the product question).
- **Opportunity cost:** ~1-2 weeks, and the emotional cost that the answer might
  be "people shrug." That risk is the *reason* to run it cheaply before
  investing more.
- **Why it wins:** it's the only option whose output changes what you'd do next.
  A, C, and D all leave you exactly as ignorant about demand as you are today.

## Option C — build more engine (bidirectional, k-alternatives, CH)

The spec §14.5 stretch goals: bidirectional A*, k alternative routes,
contraction hierarchies, ALT landmarks.

- **Buys:** genuine DSA depth and a more impressive benchmark table (the
  bench harness already supports adding stages — `bench/run.ts`).
- **Opportunity cost:** every hour here is an hour not spent learning whether
  anyone wants the thing. You'd be optimizing the search over a graph nobody has
  asked to route across.
- **When C is correct:** *only* under Option A's framing (pure portfolio) — if
  the goal is to show algorithmic range, C is the strongest portfolio move. As a
  *product* move it's premature optimization of demand-unvalidated software.

## Option D — expand coverage (multi-city / city-scale)

Spec §10 Phase 4: vehicle presets, multi-city pipeline, saved routes.

- **Buys:** a bigger map; more places to route.
- **Opportunity cost:** the worst ratio of the four. Coverage is a cost you pay
  to *serve* demand; paying it before demand exists is backwards. Plus it
  collides with a hard constraint: free Open-Meteo elevation **429s under heavy
  testing** (project context) — scaling the pipeline fights the free-tier
  ceiling that spec §11.A already flagged as make-or-break.
- **When D is correct:** after B returns positive *and* you know which
  neighborhoods the validated users actually travel.

## The opportunity-cost principle

```
  spend hours where the uncertainty is, not where the comfort is

       certainty  ◄─────────────────────────────►  uncertainty
       ───────────                                  ───────────
       engine works        ░░░░░░░░░░░░░░░░░░        anyone wants it?
       (A* == Dijkstra)                              (no data at all)
            ▲                                              ▲
            │                                              │
       C and D invest here                          B invests here
       (the easy, proven side)                      (the hard, unknown side)
```

The senior move is to invest against uncertainty. The engine being done is
*exactly* the reason the next dollar should not go to the engine.

## See also

- `02-scope-cuts-and-non-goals.md` — what Option B actually bundles, and the
  engine work it deliberately cuts.
- `04-success-metrics-and-feedback-loop.md` — how you'd know Option B succeeded.
- `05-skeptical-reviewer-questions.md` — defending the "do nothing more on
  features" stance in a review.
