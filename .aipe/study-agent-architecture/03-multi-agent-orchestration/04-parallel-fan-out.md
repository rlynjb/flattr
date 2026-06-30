# Parallel / fan-out-fan-in

**Industry names:** fan-out/fan-in · parallel agents · map-reduce over
agents. **Type:** Industry standard. **In this codebase: Not yet
implemented** — but the *opportunity* is real: 3 independent route legs are
exactly fan-out work.

> Independent subtasks run simultaneously; a merger combines. Lead with the
> shape.

---

## Zoom out, then zoom in

**Zoom out — the topology (Move 1 shape):**

```
           ┌──────── split ────────┐
           ▼          ▼            ▼
      ┌────────┐ ┌────────┐  ┌────────┐
      │agent 1 │ │agent 2 │  │agent 3 │   (concurrent)
      └────┬───┘ └────┬───┘  └────┬───┘
           └──────────┼───────────┘
                      ▼
              ┌──────────────┐
              │ merge agent  │  synthesizes
              └──────────────┘
```

**Zoom in.** This is `Promise.all()` over independent requests, then a
reduce. The win is latency — three agents in parallel cost the time of the
slowest, not the sum. The constraint: subtasks must be *genuinely
independent* (no subtask needs another's output). If dependent, it's a
pipeline (`03-sequential-pipeline.md`), not a fan-out.

---

## How it works

### Move 1 — the mental model

flattr's "flat afternoon" has natural fan-out: geocoding 3 coffee shops are
3 independent calls. `geocode("cafe A")`, `geocode("cafe B")`,
`geocode("cafe C")` need nothing from each other — fire them concurrently.

```
  fan-out the independent geocodes (the opportunity)

  ┌─ geocode("cafe A") ─┐
  ├─ geocode("cafe B") ─┤  Promise.all → 3 coords  ← time of the slowest
  └─ geocode("cafe C") ─┘                            not the sum
```

### Move 2 — where flattr's work is fan-out vs pipeline

The discipline: separate the independent parts from the dependent parts.

```
  independent (fan-out)              dependent (must be a pipeline)
  ─────────────────────              ──────────────────────────────
  geocode the 3 cafes                search() legs in visit ORDER
  (no leg needs another)             (leg 2 starts where leg 1 ended)
```

Geocoding fans out; the route legs are a pipeline (each leg's start is the
previous leg's end). Getting this wrong — fanning out dependent legs —
produces a disconnected route. The concurrency must also be *bounded* (the
provider's rate limit), which is `../05-production-serving/02-fan-out-backpressure.md`.

### Move 3 — the principle

Fan-out wins latency when subtasks are genuinely independent; it's a
correctness bug when they're not. flattr's geocodes are independent
(fan-out); its route legs are dependent (pipeline) — the same feature
contains both shapes, and naming which is which is the design.

---

## Interview defense

**Q: What in the afternoon-planner fans out, and what can't?**

The 3 cafe geocodes fan out — `Promise.all`, independent, latency of the
slowest. The route legs can't: leg 2 starts where leg 1 ended, so they're a
dependent pipeline. Fanning out the legs would produce a disconnected
route. Same feature, two shapes — and the fan-out needs a concurrency cap
at the provider's rate limit.

Anchor: *"geocoding flattr's 3 cafes is `Promise.all` fan-out; the route
legs between them are a dependent pipeline — one feature, both shapes."*

---

## See also

- `03-sequential-pipeline.md` · `02-supervisor-worker.md`
- `../05-production-serving/02-fan-out-backpressure.md` (bounding the fan-out)
