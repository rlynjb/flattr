# Retraining Pipelines

*Industry name: retraining / continuous training — scheduled or triggered refresh on fresh data.*

## Zoom out

```
THE REFRESH LOOP
fresh data ──► retrain ──► validate ──► promote ──► serve
    ▲                                                  │
    └────────── on a schedule OR on a trigger ◄────────┘
                (cron / drift alert / data volume)
```

A model is never "done" — the world drifts (file 15), so you periodically re-derive the
model from fresh data. A retraining pipeline automates that: pull new data, retrain,
validate against the old model, and promote only if it's better. flattr has no model to
retrain, but it has a **structurally identical rebuild pipeline** — `pipeline/run-build.ts`
re-derives `graph.json` from fresh OSM + elevation. Same cadence concern, no learning. New
ground as retraining; real as rebuild.

## How it works

### Move 1 — the mental model: re-derive the artifact from current truth

```
STALE ARTIFACT          FRESH SOURCE          NEW ARTIFACT
old model / old graph ◄─ pull current data ─► retrain / rebuild
        ▲                                            │
        └──────── replace only if validated better ──┘
```

Whether the artifact is *weights* (ML) or *graph.json* (flattr), the loop is the same:
fetch current source → regenerate → validate → swap. The discipline is identical; only the
"regenerate" step differs (fit vs deterministic build).

### Move 2 — triggers, gates, and flattr's honest analog

A retraining pipeline decides *when* and *whether*:

1. **Trigger:** scheduled (nightly/weekly), or **event-driven** (drift alert from file 15,
   or "N new labels arrived").
2. **Retrain** on the fresh window of data.
3. **Validate gate:** new model must beat the old on the held-out test (file 03) — never
   promote a regression. (This is where `bench/`-style logging, file 14, proves the win.)
4. **Promote / rollback:** swap the served artifact; keep the old one to roll back.

flattr's `pipeline/run-build.ts` is the deterministic twin:

```
RETRAINING PIPELINE              flattr's run-build.ts
pull fresh data        ◄─ like ─► fetchOverpass(BBOX)  (fresh OSM)
                                  + pickElevation()    (fresh DEM)
regenerate (retrain)   ◄─ like ─► buildGraph(...)      (deterministic)
artifact = weights     ◄─ like ─► writeGraph → data/graph.json
cadence concern        ◄─ like ─► "rebuild when OSM/elevation drifts"
```

Read `run-build.ts`: it fetches current OSM, samples elevation (Google > Open-Meteo > flat
fallback), builds the graph, and writes the artifact. That *is* the "re-derive from fresh
source" half of a retraining pipeline. What it **lacks** is the *learning* and the *validate
gate* — the build is deterministic, so there's no "is the new one better?" check beyond
"did it build." A retraining pipeline would add the gate.

### Move 3 — the principle

**Freshness needs a loop, not a one-off.** Both models and graphs go stale; the mature
move is automating re-derivation on a trigger plus a validation gate, not rebuilding by hand
when someone notices the map is wrong. flattr already owns the "re-derive" muscle in
`run-build.ts`; a learned component would add the "retrain + validate + promote" gate on top.

## In this codebase

**NOT YET EXERCISED as a retraining pipeline — nothing trains.** The honest, real
connection: `pipeline/run-build.ts` is a **rebuild pipeline** — `fetchOverpass` +
`pickElevation` + `buildGraph` + `writeGraph` re-derive `data/graph.json` from current OSM
and elevation. Same cadence-and-freshness concern that drives ML retraining (it answers the
graph-drift problem from file 15), just deterministic.

If a learned **`features/routing/cost.ts`** existed, retraining would slot alongside this
build: on fresh rider data, refit the constrained ≥0/monotone cost (file 04), validate it
beats the current model on a spatial held-out split (file 03), then promote.
`features/grade/classify.ts` is a threshold table — its constants are *edited by hand*, never
retrained.

## See also

- `15-drift-detection.md` — the drift that triggers a retrain/rebuild
- `14-training-run-logging.md` — logging each retrain to prove the new one is better
- `01-supervised-pipeline.md` — the full loop a retrain re-runs end to end
</content>
