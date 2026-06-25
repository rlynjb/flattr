# Success metrics and feedback loop

A problem worth investing in has an observable answer to "did it work?" — and the honest version names *what you can measure today* separately from *what you'd need users to measure*. flattr is pre-users, so its real, available metrics are technical (is the engine correct, is it fast enough, do the routes look right), and its product metrics are aspirational (would people switch). Don't blur them.

```
  METRICS — by what you can actually observe

  AVAILABLE NOW (repo / you can measure)        FEEDBACK LOOP
  ─────────────────────────────────────         ─────────────
  correctness: A* cost == Dijkstra cost   ◄──── the test oracle
  search efficiency: A* expands 4–6x       ◄──── the bench harness
    fewer nodes than Dijkstra                    (bench/run.ts)
  route plausibility: does the colored      ◄──── eyeball + a rider's
    route match a flat way a human'd pick         "yeah, that's right"

  NEEDS USERS (can't measure yet)               WHAT IT'D TAKE
  ─────────────────────────────────────         ─────────────
  adoption: do people choose flat-first?    ◄──── ship + instrument
  switching: would they leave their app?    ◄──── interviews / A-B
  trust: do mobility-aid users rely on it?  ◄──── field testing
```

The top half is the loop you already have and should lean on in any review. The bottom half is the loop you'd have to *build* — and saying "I haven't measured this yet, here's how I would" is stronger than inventing a number.

## Metrics available now (and the loop that produces them)

These are real, in the repo, and re-runnable — which is exactly why they're the metrics to cite:

- **Correctness — the optimality oracle.** A\* is tested to return the *exact same cost* as Dijkstra on the same graph. If they ever diverge, the heuristic is inadmissible and the test fails. This is a binary, trustworthy success signal: the router is provably finding optimal paths. The feedback loop is the test suite — it runs on every change.
- **Search efficiency — the bench harness.** `bench/run.ts` counts nodes expanded, heap pushes, and pops per query across the algorithm stages, so "A\* beats Dijkstra" is a measured table (~4–6× fewer expansions here), not a claim. The loop: re-run the bench when the graph or cost model changes; watch the ratio of pops to expansions to know when lazy-deletion staleness would justify a decrease-key heap.
- **Route plausibility — the eyeball test.** Does the route, colored green-to-red by grade, match the flat way a local would actually walk or scoot? This is informal but real: it's the fastest signal that the *product* premise (not just the algorithm) is working. The honest loop is to put it in front of one real scooter rider for one neighborhood they know.

## Metrics that need users (and the loop that doesn't exist yet)

State these as the gap, with the loop you'd build:

| Metric | What it would prove | The loop to build |
|--------|---------------------|-------------------|
| **Adoption** — % of routes where users pick flat-first | People actually want grade-aware routing | Ship instrumented; count mode selection |
| **Switching** — would users leave their current app | The problem is painful enough to change habits | User interviews; a small A/B if there were a userbase |
| **Trust** — do mobility-aid users rely on the routes | The accessibility use case is real and safe | Field testing with target users; a wrong "flat" claim is a trust failure |

## The one metric that matters most, and why

If you could measure only one thing, it's **route plausibility validated by a real target user** — does an actual scooter rider look at flattr's route for a neighborhood they know and say "yes, that's the way I'd go"? It dominates because it's the cheapest signal that bridges from "the algorithm is correct" (which the oracle already proves) to "the product premise is true" (which nothing proves yet). The correctness metrics tell you the engine works; only a real user's reaction tells you the engine works *on the right objective*.

▸ Cite the metric you actually have (A\* == Dijkstra, provably optimal) and name the metric you don't (adoption) — never present an aspiration as a measurement.

## One-page summary

**Core claim:** flattr's available success metrics are technical and trustworthy (provable optimality, measured search efficiency); its product metrics need users it doesn't have yet — and the honest brief keeps the two separate.

- **Now:** A\* cost == Dijkstra cost (oracle, provably optimal); A\* expands 4–6× fewer nodes (bench harness); route plausibility (eyeball + one real rider).
- **Needs users:** adoption, switching, accessibility trust — name the loop you'd build, don't invent numbers.
- **The one that matters most:** a real target user validating route plausibility — the cheapest bridge from "engine correct" to "premise true."

┃ "The oracle proves the engine works; only a real rider tells me it works on the right objective."
