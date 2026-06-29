# Study — Debugging & Observability (flattr)

> The question this guide answers: **when the router returns a wrong, weird, or
> empty answer, what evidence already exists to explain it — and what's missing?**

flattr has no Sentry, no structured logger, no metrics backend, no traces. And
yet it is *more* observable than most apps that ship all four. The reason is that
the observability is baked into the **return values**, not bolted on as a side
channel: every search hands back the counters that explain its own work
(`nodesExpanded`, `pushes`, `pops`), every route hands back the list of edges it
had to compromise on (`steepEdges`), and every degraded build hands back a flag
that says "the grades I'm showing you are fake" (`degraded`).

That's the spine of this guide: **flattr's evidence travels in-band, as data the
caller can assert on, render, or page off of.** The counters aren't logged — they
are the function's contract.

---

## The seam that splits this from its neighbors

```
  ┌─ study-testing ─────────────────────────────────────────────┐
  │  KNOWN failure conditions caught before release.            │
  │  "A* cost EQUALS Dijkstra cost" — the optimality oracle.    │
  └─────────────────────────────────────────────────────────────┘
            seam = known vs unknown
  ┌─ study-debugging-observability (HERE) ──────────────────────┐
  │  UNKNOWN behavior explained with evidence.                  │
  │  "why did A* expand 6× more nodes here?" — read the counters.│
  │  "why is the whole map green?" — curl the API, check degraded.│
  └─────────────────────────────────────────────────────────────┘
            seam = explain vs measure
  ┌─ study-performance-engineering ─────────────────────────────┐
  │  the SAME counters, read as a budget, not a diagnosis.      │
  └─────────────────────────────────────────────────────────────┘
```

The optimality oracle is shared with `study-testing` — it lives there as a
*correctness gate*. Here it shows up again as a *correctness probe*: the same
"compute it a second way and demand agreement" move, used to explain an unknown
discrepancy rather than guard a known one. Same mechanism, two postures. The
bench counters are shared with `study-performance-engineering` — there they're a
budget, here they're a diagnosis. Cross-link, don't re-teach.

---

## What the repo actually exercises (ranked by consequence)

1. **In-band search instrumentation** — every search returns
   `nodesExpanded / pushes / pops` (`features/routing/types.ts:45-51`),
   incremented inside the loop (`features/routing/astar.ts:35-77`), reported
   side-by-side across five algorithm stages by the bench harness
   (`bench/run.ts:29-56`). This is the repo's strongest observability asset.
   → `01-in-band-search-instrumentation.md`

2. **The optimality oracle as a correctness probe** — A* vs Dijkstra, asserted
   equal in cost (`features/routing/astar.test.ts:38-46`). Compute the answer a
   second, dumber way; if they disagree, the heuristic is broken. The single
   most powerful debugging tool in the repo.
   → `02-optimality-oracle-probe.md`

3. **Route-honesty signals** — `BLOCKED = 1e9` finite-not-infinite
   (`features/routing/cost.ts:4-5`) keeps "no flat route" distinct from "no
   route"; `steepEdges` (`features/routing/astar.ts:117-128`) carries the
   compromise list; `RouteSummaryCard.tsx:28-42` surfaces it to the user as
   three honest states.
   → `03-route-honesty-signals.md`

4. **Degrade-and-surface at the network seam** — Open-Meteo 429 → flat fallback
   → `degraded` flag → user-visible "Grades approximate" note → self-heal retry
   (`mobile/src/useTileGraph.ts:16-31, 189-218`; `mobile/src/MapScreen.tsx:372-379`).
   → `04-degrade-and-surface-seam.md`

---

## not yet exercised — and when it starts to matter

These are honest gaps, not failures. flattr is a pure-engine + on-device app
with no server, so most production-observability machinery has nothing to attach
to *yet*. Each gets a trigger that flips it on.

```
  ┌─────────────────────────────┬──────────────────────────────────────┐
  │ machinery                   │ trigger that makes it relevant         │
  ├─────────────────────────────┼──────────────────────────────────────┤
  │ structured logging          │ first time a build fails in CI and you │
  │ (levels, fields, JSON)      │ can't reproduce — 8 console.* calls    │
  │                             │ (pipeline/run-build.ts, bench/run.ts)  │
  │                             │ are all there is today.                │
  ├─────────────────────────────┼──────────────────────────────────────┤
  │ metrics / SLIs / SLOs /     │ first deploy to real users — you'd     │
  │ alerts                      │ want p95 route latency + degraded-rate │
  │                             │ as a paging signal. Counters exist;    │
  │                             │ nothing collects them over time.       │
  ├─────────────────────────────┼──────────────────────────────────────┤
  │ traces / request lifecycle  │ first multi-service hop. Today the     │
  │ (spans, correlation IDs)    │ longest causal chain is one in-process │
  │                             │ pipeline; no IDs needed.               │
  ├─────────────────────────────┼──────────────────────────────────────┤
  │ error tracking (Sentry etc.)│ first time a user hits a crash you     │
  │ + crash reporting           │ never see. No DSN, no dep, in either   │
  │                             │ package.json.                          │
  └─────────────────────────────┴──────────────────────────────────────┘
```

The audit (`audit.md`) walks all eight lenses and marks each `not yet exercised`
honestly with its trigger.

---

## The one operational habit worth copying

**curl the API before you debug the pipeline.** It's written into the project
memory and the context doc: Open-Meteo 429s under heavy testing, and when it
does, every grade comes back flat — which looks exactly like a grade-computation
bug. The discipline (`curl` the upstream first, confirm it's the source, *then*
debug your code) is the cheapest "instrument before you fix" move in the repo.
This is the through-line behind the "all grades green" incident in
`04-degrade-and-surface-seam.md`.

---

## Reading order

```
  00-overview.md                       ← you are here
  audit.md                             ← 8-lens audit, gaps named honestly
  01-in-band-search-instrumentation.md ← the counters that explain the search
  02-optimality-oracle-probe.md        ← compute it twice, demand agreement
  03-route-honesty-signals.md          ← BLOCKED-finite + steepEdges + the card
  04-degrade-and-surface-seam.md       ← 429 → flat fallback → degraded → UI
```

Cross-links: `study-testing` (the oracle as a gate), `study-performance-engineering`
(the counters as a budget), `study-system-design`
(`04-honest-fallback-routing.md`, `05-elevation-provider-fallback.md` — the
architecture these debugging signals ride on).
