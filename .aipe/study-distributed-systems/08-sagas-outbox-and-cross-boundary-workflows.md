# Sagas, outbox, and cross-boundary workflows
### multi-step workflows, compensation, transactional outbox, reconciliation — `not yet exercised`
**Industry name:** saga, compensating transaction, transactional outbox · **Type:** Industry standard

## Zoom out, then zoom in

Verdict first: **sagas, outbox, and compensation are `not yet exercised`.** These patterns exist to keep a *multi-step workflow that spans multiple systems* correct when it fails halfway — and that requires steps with *side effects you'd have to undo*. flattr's only multi-step flow is the build pipeline, and every step is a pure transform or an idempotent read, so a half-failed build leaves *nothing to compensate*. This file teaches the patterns and shows precisely why flattr's pipeline doesn't need them — which is itself a clean lesson about when sagas earn their keep.

```
  Zoom out — where a saga WOULD live (and why it's empty)

  ┌─ Coordination layer (build pipeline / pump) ────────────────┐
  │  parse ─► split ─► sample elev ─► compute grades ─► graph    │
  │  ┌ ★ where saga steps + compensation WOULD sit ★ ┐          │ ← empty
  │  │   (every step is pure or an idempotent read →   │          │
  │  │    a failed step leaves nothing to undo)         │          │
  │  └────────────────────────────────────────────────────┘        │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ═══ NETWORK ═══ (reads only, no writes)
  ┌─ Provider layer ──────────▼──────────────────────────────────┐
  │  Overpass / Open-Meteo — GET/POST reads; nothing to roll back │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a saga answers "I have steps A→B→C across different systems with no shared transaction — if C fails, how do I undo A and B?" The outbox answers "how do I atomically *both* commit my local state *and* emit an event, without a distributed transaction?" Both presuppose *writes with side effects*. flattr's pipeline is a chain of reads and pure functions ending in one local file write — a half-failure just produces no file. There's no partial side effect stranded across a boundary, so there's nothing to compensate.

## Structure pass

**Layers.** The pipeline is the only multi-step flow: `parseOsm` → `splitWays` → `sampleElevations` → `computeGrades` → write `graph.json` (`build-graph.ts:22-30`, `run-build.ts:43-51`).

**The axis: failure recovery — "if step N fails, what state is stranded, and how do I undo it?"**

```
  One question — "if this step fails, what's left stranded?" — traced

  ┌──────────────────────────────────────┐
  │ parseOsm / splitWays (pure)           │  → nothing stranded: in-memory,
  └──────────────────────────────────────┘    GC'd. just throw and abort.
      ▼
  ┌──────────────────────────────────────┐
  │ sampleElevations (idempotent read)    │  → nothing stranded: a read leaves
  └──────────────────────────────────────┘    no side effect to undo.
      ▼
  ┌──────────────────────────────────────┐
  │ write graph.json (the ONLY write)     │  → if THIS fails, no file (or a
  └──────────────────────────────────────┘    partial file overwritten next run)
```

**The seam.** The only write boundary is the final `writeFileSync`. A saga seam exists where a *committed* side effect in one system must be undone because a *later* step failed. flattr has no such ordering — the single write is *last*, so nothing committed before it can need undoing. That "write last, after all fallible work" shape is exactly what lets it skip sagas. Name it: no compensation because no early committed side effects.

## How it works

#### Move 1 — the mental model

You know the problem from a checkout flow: reserve inventory → charge card → create shipment. If shipment creation fails, you must *refund* the card and *release* the inventory — there's no single transaction across three systems. A saga is that sequence-plus-undo.

```
  The saga pattern flattr does NOT have — for vocabulary

  forward:   reserve ──► charge ──► ship
                │          │         ✗ fails here
  compensate:  release ◄── refund ◄──┘
             (run the UNDO of each completed step, in reverse)

  outbox:   [ commit local row + outbox event ] atomically
                          │ later
                          ▼  a relay publishes the event (at-least-once)
            ⇒ no lost event even if the publish crashes
```

flattr's pipeline is the *anti*-pattern that needs neither: a linear transform with the only commit at the very end.

#### Move 2 — why the pipeline needs no saga, walked honestly

**Step 1 — the steps are pure or idempotent reads.** Bridge from a `.map().filter()` chain. `parseOsm`, `splitWays`, `computeGrades` are pure functions over in-memory data; `sampleElevations`/`fetchOverpass` are idempotent reads (`03`). *Consequence:* if any of them throws, the only "state" is in-memory objects that get garbage-collected. There's no reserved inventory, no charged card, no emitted event — nothing committed to undo. The whole forward sequence is *retryable from the top* (re-run the build) rather than *compensatable*.

```
  Forward-only, no compensation needed

  parse ─► split ─► sample ─► grade ─► [WRITE graph.json]
    ✗ any of these fails ──► throw ──► process exits ──► no file written
                                          │
                                          └─ next `npm run build:graph` just
                                             re-runs from the top. retry, not undo.
```

**Step 2 — the single write is last and idempotent-ish.** Bridge from an upsert. The only side effect is `writeFileSync("data/graph.json", ...)` (`run-build.ts:11-13`) — and it's the *final* step, after all fallible network work. *Consequence:* a failure *before* it leaves no file; a failure *during* it could leave a truncated file, but the next run overwrites it wholesale (the write is a full replace, not an append). So even the write is effectively idempotent — re-running converges to a correct file. No outbox needed because there's no "commit local state AND emit event" pair to make atomic.

```
  Write-last makes the whole pipeline a single logical commit

  [ all fallible work: reads + pure transforms ]  ←─ no side effects
                       │ all succeeded?
                       ▼
              writeFileSync(graph.json)  ←─ the ONE commit, full replace
   ⇒ the pipeline behaves like one transaction: it either produces a
      complete file or it doesn't. nothing partial escapes to another system.
```

**Step 3 — the runtime "workflow" is even simpler.** Bridge from a single async function. On the phone, `pump`'s build is `fetchOverpass → bestEffortElevation → buildGraph → setState`. The "commit" is a React `setState` — purely local, no cross-boundary effect. A failure is caught and the old state kept (`useTileGraph.ts:121`). *Consequence:* there's not even a file write to worry about; the workflow is one in-memory transaction that either updates the merged graph or doesn't.

#### Move 2.5 — what makes sagas real (the trigger)

```
  Phase A (now) vs Phase B (§11 E2 server-side build farm w/ writes)

  NOW — linear read+transform        BUILD FARM WITH SIDE EFFECTS
  ───────────────────────────        ─────────────────────────────
  steps pure / idempotent reads      step: persist tile to blob store
  one local write, last              step: update a tile index/DB row
  failure ⇒ re-run from top          step: notify clients / invalidate cache
  no compensation needed               ⇒ if "notify" fails AFTER "persist" +
  no outbox needed                       "index", you have committed side
                                          effects ⇒ SAGA (compensate) OR
                                          OUTBOX (atomic persist+event)
```

The trigger is a workflow with *multiple committed side effects across systems*. That arrives with §11 E2's build farm if a tile build does more than write one file — e.g. persist the tile to blob storage, update an index row, *and* publish an invalidation event. The moment two of those commit and a third fails, you need either compensation (undo the persist + index) or a transactional outbox (commit persist + index + an outbox event atomically, relay the event later). Today there's exactly one commit, last, so neither applies.

#### Move 3 — the principle

Sagas and outboxes are the price of *multiple committed side effects across systems with no shared transaction*. flattr pays nothing because it has exactly one commit and it's last — the entire fallible pipeline runs *before* anything is written, so a failure produces no partial state to reconcile. The general lesson: **structure a workflow so the irreversible commit is the last step, after all fallible work; then a failure is a retry, not a rollback.** flattr does this for free; a system that can't (because steps commit early) is exactly the system that needs a saga.

## Primary diagram

The recap — flattr's forward-only pipeline vs. the saga machinery it doesn't need.

```
  Sagas/outbox in flattr — recap

  ┌─ EXISTS — forward-only pipeline, commit LAST ───────────────┐
  │  parse ─► split ─► sample(read) ─► grade ─► WRITE graph.json │
  │  failure anywhere ⇒ no file ⇒ re-run from top (retry)        │
  └───────────────────────────────────────────────────────────────┘

  ┌─ `not yet exercised` (empty) ───────────────────────────────┐
  │  ✗ saga / compensating transactions  ✗ transactional outbox  │
  │  ✗ reconciliation jobs                                       │
  │                                                              │
  │  trigger: §11 E2 build farm where a tile build commits MULTIPLE│
  │           side effects (persist + index + notify) across systems│
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** No saga/outbox code exists. The honest implementation note is the pipeline shape that *avoids* needing one — write-last:

```
  pipeline/build-graph.ts (22–30)  +  pipeline/run-build.ts (43–51)

  // build-graph.ts — all steps pure / idempotent, NO side effects:
  const ways = parseOsm(osm);                       ← pure
  const { nodes, edges } = splitWays(ways, maxSegM);← pure
  const nodes2 = await sampleElevations(nodes, elevation, ...);← idempotent read
  const edges2 = computeGrades(nodes2, edges);      ← pure
  return { city, bbox, nodes2, edges2, adjacency };  ← returns a value, writes nothing

  // run-build.ts — the ONE write, dead last, after the whole build succeeds:
  const graph = await buildGraph(...);               ← all fallible work first
  writeGraph(graph, "data/graph.json");              ← single commit, full replace
       │
       └─ because the write is last and full-replace, a mid-pipeline failure
          leaves no partial state in any other system. there is nothing to
          compensate — re-running the build is the entire recovery story.
```

The runtime equivalent — the "commit" is a local `setState`, caught on failure:

```
  mobile/src/useTileGraph.ts  (113–122)

  const g = await buildGraph(kind, bbox, osm, elev, ...);
  const region = { bbox, graph: prefixGraph(g, kind) };
  if (kind === "corridor") { corridorRef.current = region; setCorridor(region); }
  else { viewRef.current = region; setView(region); }   ← local "commit"
  } catch {
    // failed — keep last region. no partial cross-system state to undo.
  }
```

## Elaborate

The saga pattern was named for long-lived database transactions and rediscovered for microservices: when you can't hold a lock across services, you replace "one ACID transaction" with "a sequence of local transactions, each with a compensating action." The transactional outbox solves the adjacent problem — the dual-write ("save to DB *and* publish to Kafka") that can't be atomic — by writing the event into the same DB transaction as the state change, then relaying it. Both are answers to *committed side effects you can't roll back together*.

flattr is the instructive *negative* example: it has a multi-step workflow but needs neither pattern, because it's structured so the only irreversible action is last. That's not luck — it's the single most effective workflow-design move there is, and it's worth naming explicitly in an interview: *make the commit the last step.* Systems that violate it (charge the card in step 1, ship in step 3) are precisely the ones forced into saga complexity.

Where it grows up: §11 E2's build farm, the moment a tile build acquires multiple committed side effects across systems (persist + index + notify). Then either compensation or an outbox becomes mandatory, plus a reconciliation job to catch the cases where even compensation fails. Read next: `03` (the idempotency that makes "retry from top" safe) and `06` (the queue a build-farm workflow would run on).

## Interview defense

**Q: "Your build pipeline has several steps across a network. How do you handle a partial failure halfway through?"**
By structure, not by compensation. Every step before the end is either a pure transform or an idempotent read, and the *only* side effect — writing `graph.json` — is the last step, a full file replace. So a failure anywhere mid-pipeline leaves no committed state in any system: I just re-run the build from the top. There's nothing to roll back, which is exactly why I need no saga and no outbox. The general move is "make the irreversible commit the last step" — then failure is a retry, not a rollback.

```
   [ reads + pure transforms (all fallible work) ] ─► WRITE (the one commit, last)
        ✗ fail here ──► no file ──► re-run from top    no partial state escapes
```
*Anchor: commit last, after all fallible work — failure becomes retry, not rollback.*

**Q: "When would you actually need a saga here?"**
At the §11 E2 build-farm stage, if a single tile build committed *multiple* side effects across systems — say persist the tile to blob storage, update an index row, then publish a cache-invalidation event. If the publish fails after the first two commit, I have stranded state and need either compensation (undo persist + index) or a transactional outbox (commit persist + index + the event atomically, relay later). Today there's one commit, last, so neither applies. *Anchor: sagas are for multiple committed side effects across systems — I have one, and it's last.*

## Validate

1. **Reconstruct:** define a saga and a transactional outbox in one line each. What single structural property of flattr's pipeline makes both unnecessary?
2. **Explain:** in `build-graph.ts:22-30` + `run-build.ts:43-51`, why does "write last" mean a mid-pipeline failure leaves nothing to compensate?
3. **Apply:** the §11 E2 build farm adds "persist tile to blob → update index row → publish invalidation." Identify the first point a partial failure strands state, and say whether you'd reach for a saga or an outbox.
4. **Defend:** a reviewer wants "compensating rollback logic" added to the current pipeline. Argue why there's nothing to compensate today and what change would make it necessary.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the idempotency that makes "retry from top" safe.
- `06-queues-streams-ordering-and-backpressure.md` — the queue a multi-step build-farm workflow would run on.
- `02-partial-failure-timeouts-and-retries.md` — the per-step failure handling beneath the workflow.
- `.aipe/study-system-design/` — the build/runtime split and where a workflow engine would sit.
