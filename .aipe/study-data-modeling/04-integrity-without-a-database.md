# Integrity Without a Database

**Industry name(s):** referential integrity / schema validation at the trust
boundary / schema versioning. **Type:** Industry standard (data integrity),
applied to a serialized artifact instead of a DB.

---

## Zoom out, then zoom in

In Postgres, a foreign key is enforced *by the engine* — you physically cannot
insert an `edge` pointing at a `node` that doesn't exist. flattr has the same
FK-shaped relations (`Edge.fromNode/toNode → Node.id`) but no engine, so nothing
enforces them. The integrity question moves entirely onto the build pipeline and
a single `as` cast. Here's the boundary where that cast happens.

```
  Zoom out — the trust boundary is one cast

  ┌─ Build layer (pipeline/, trusted) ─────────────────────────────┐
  │  computeGrades derefs nodes[e.toNode] → crashes on a bad FK     │  guard #1
  │                                  │ writes graph.json            │  (build-only)
  └──────────────────────────────────┬─────────────────────────────┘
                                      │ graph.json — plain JSON, no schema tag
  ┌─ Trust boundary ───────────────────▼────────────────────────────┐
  │  loadGraph(): return graph as unknown as Graph   ← ★ blind cast ★│  NO guard
  └──────────────────────────────────┬─────────────────────────────┘
  ┌─ Runtime layer (mobile/, assumes the shape is valid) ───────────┐
  │  A* derefs graph.nodes[goalId] → undefined crash, far from cause│
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: there's no referential-integrity check, no `not-null`/`unique`/`check`
enforcement, and **no schema version** on the artifact. `loadGraph()` casts the
JSON straight to `Graph` and trusts it. The question: *what holds the model's
invariants, and what happens when they break?*

---

## The structure pass

**Layers.** Two: the *trusted* side (the build pipeline, which produces the
artifact) and the *assuming* side (the app, which consumes it). The artifact
sits between them with no validator.

**Axis — "what enforces this invariant?"** Trace it across the invariants:

```
  One question across the invariants: who enforces it?

  invariant                          enforced by
  ─────────                          ───────────
  edge.fromNode resolves to a Node   build pipeline ONLY (grade.ts deref)
  edge.toNode resolves to a Node     build pipeline ONLY
  gradePct in [-40, 40]              computeGrades clamp (grade.ts:30) — at build
  graph shape matches Graph type     NOTHING at runtime — `as unknown as Graph`
  artifact version matches app       NOTHING — no version field exists

  every runtime invariant is "assumed", not "enforced" — that's the seam
```

**Seam.** The whole finding lives at one boundary: `loadGraph()`
(`mobile/src/loadGraph.ts:9-11`). Above it, the build pipeline guarantees a
well-formed graph *if it ran*. Below it, the app trusts the bytes. The trust
axis flips from "produced-by-trusted-code" to "assumed-valid" right at that
cast — and a hand-edited file, a partial write, or a version skew crosses that
seam undetected.

---

## How it works

### Move 1 — the mental model

A blind cast is `JSON.parse(x) as User` — you tell the compiler "trust me, this
is the shape," and at runtime there's no check. You've felt this bug: the API
returns a slightly different shape, the cast says nothing, and your code
explodes three functions later on `user.profile.name` when `profile` is
undefined. flattr's `loadGraph` is exactly that cast, on the whole graph.

```
  The kernel: a cast moves the failure from the boundary to deep in the code

  graph.json ──► (as unknown as Graph) ──► app trusts it
                       │ no validation here
                       ▼
        bad data flows DOWNSTREAM until a deref crashes
        (the crash site is far from the actual cause)
```

### Move 2 — the walkthrough

**The blind cast — where validation should be and isn't.**

```ts
// mobile/src/loadGraph.ts:9-11
export function loadGraph(): Graph {
  return graph as unknown as Graph;   // ← double cast: even TS's structural check is bypassed
}
```

`as unknown as Graph` is the strongest possible "trust me" — the `unknown`
intermediate strips even TypeScript's structural compatibility check, so *any*
JSON satisfies it. There is no `nodes` presence check, no "every `edge.fromNode`
is a key in `nodes`" check, no shape validation. The artifact is trusted whole.

**What breaks, and *where*.** Suppose `graph.json` has an edge whose `fromNode`
is `"n9999"`, a node that doesn't exist. Nothing catches it at load. It surfaces
later, far from the cause:

```ts
// features/routing/astar.ts:39-42 — a missing start/goal node returns null (silent)
const goal = graph.nodes[goalId];
if (!graph.nodes[startId] || !goal) {
  return { path: null, ... };   // route just "fails" — no error, no reason
}
// ...and a dangling edge endpoint crashes mid-expansion:
// astar.ts:72  heuristicFn(graph.nodes[next], goal)  → graph.nodes[next] is undefined
//              → haversine reads .lat of undefined → TypeError, deep in the search
```

The failure mode is the worst kind: **distance between cause and symptom.** A
bad FK in the data manifests as either a silent "no route" (`astar.ts:40`) or a
`TypeError` inside A*'s heuristic call — neither names "your graph has a dangling
edge."

```
  Cause → symptom distance (the integrity failure mode)

  CAUSE (in data):  edge e7.fromNode = "n9999"  (no such node)
        │ loadGraph casts it through, unchecked
        ▼
  SYMPTOM (in code): graph.nodes[next] === undefined  at astar.ts:72
                     → TypeError reading .lat, deep in expansion
  a referential-integrity check at load would fail HERE ──┐
  with "edge e7 references missing node n9999"  ◄─────────┘  (named, at the boundary)
```

**The build pipeline is the *only* integrity guarantee.** It's a real one, but
narrow. `computeGrades` derefs both endpoints:

```ts
// pipeline/grade.ts:27
const riseM = nodes[e.toNode].elevationM - nodes[e.fromNode].elevationM;
//                  ▲ throws if e.toNode isn't in nodes — build fails loudly
```

So any graph *this pipeline produces* has resolvable endpoints — a dangling edge
crashes the build (`grade.ts:27`) before it can be shipped. That covers the
common case. What it doesn't cover: a hand-edited `graph.json`, a partial/
corrupt write, or a file built by an *older* pipeline version against a *newer*
app — none of those re-run `computeGrades`, so none get the guarantee.

**The missing schema version — the silent-mis-read hazard.** Confirmed: there's
no `version` or `schemaVersion` field in `types.ts`, in `build-graph.ts`, or in
the shipped `graph.json` (it starts `{"city":"seattle-mvp","bbox":[...]`). So if
the `Edge` shape changes — say `gradePct` is renamed, or a field is added that
the app requires — an app binary bundled against the new shape and an old
`graph.json` (or vice versa) doesn't refuse to load. It casts, reads `undefined`
for the moved field, and produces wrong routes silently.

```
  No version tag → skew is silent

  app expects Edge v2 (has `surfacePenalty`)
  graph.json is v1     (no `surfacePenalty`)
        │ loadGraph casts anyway — no version compared
        ▼
  edge.surfacePenalty === undefined → cost math goes NaN → silently wrong routes
  a `version` field + a check at loadGraph would REFUSE to load instead
```

### Move 2 variant — the load-bearing skeleton

The kernel of integrity-at-a-boundary: **validate the contract where untrusted
data enters, and version the contract so skew is detectable.**

- *No referential check at load* → a dangling FK surfaces as a deref crash deep
  in A* (`astar.ts:72`), not at the boundary. The check that's missing:
  "every `edge.fromNode/toNode` is a key in `nodes`."
- *No schema version* → build/app skew mis-reads silently instead of refusing
  to load. The field that's missing: `Graph.version`, compared in `loadGraph`.
- *The build-time deref* (`grade.ts:27`) is the *only* present guard, and it
  only protects artifacts this pipeline produced.

The hardening that would close this is small: a `validateGraph(g)` called once
inside `loadGraph` that (a) checks every edge endpoint resolves, (b) checks
`g.version === EXPECTED_VERSION`. One pass over 1879 edges, run once at startup
— cheap, and it moves every failure to the boundary with a named cause.

### Move 2.5 — current state vs future state

```
  Phase A (now)                      Phase B (add the guard)
  ─────────────                      ───────────────────────
  loadGraph: `as unknown as Graph`   loadGraph: validateGraph(parsed)
  dangling FK → crash deep in A*     dangling FK → throws at load, named
  no version → silent skew           version check → refuses on mismatch
  build-time deref is the only guard boundary validation + build guard
  cost to add: ~1 pass, 1 field
```
The cost of Phase B is one O(E) validation pass at startup and one `version`
field added to the type and the build (`build-graph.ts:29`). For a read-only
single-artifact model, that's the entire migration story (see `05` and the
audit's lens 5) — there's no live data to migrate, just a version tag to start
stamping.

### Move 3 — the principle

Validate at the trust boundary, and version the contract. Without a database
enforcing FKs, the discipline a DB gave you for free has to move into one
function at the seam where untrusted bytes become trusted objects. The cost of
skipping it isn't "no integrity" — it's "integrity failures that surface far
from their cause." A loud failure at the boundary is worth more than a silent
one downstream.

---

## Primary diagram

The trust boundary, the one present guard, and the two missing ones.

```
  Integrity map — one guard present, two missing, all at the loadGraph seam

  ┌─ BUILD (trusted) ──────────────────────────────────────────────┐
  │  computeGrades derefs nodes[e.toNode]  ── GUARD #1 (build-only) │
  │     dangling FK → build crashes loudly (grade.ts:27)           │
  └──────────────────────────────────┬─────────────────────────────┘
                                      │ graph.json (no version field)
  ┌─ loadGraph (THE trust boundary) ───▼────────────────────────────┐
  │  return graph as unknown as Graph   ← blind cast, NO validation │
  │     ✗ MISSING: referential check (every FK resolves)           │
  │     ✗ MISSING: version check (g.version === EXPECTED)          │
  └──────────────────────────────────┬─────────────────────────────┘
  ┌─ RUNTIME (assumes valid) ──────────▼────────────────────────────┐
  │  A* derefs graph.nodes[next] → undefined crash (astar.ts:72)   │
  │     symptom far from cause; "no route" or TypeError, unnamed    │
  └─────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

This is the serialized-artifact version of the oldest data rule: enforce
invariants at the boundary, not by hoping callers are careful. A DB gives you
FK/`not-null`/`check`/`unique` for free; a JSON artifact gives you nothing, so
the boundary check is yours to write (libraries like `zod` exist for exactly
this — parse, don't cast). The schema-version gap is the same lesson applied to
*time*: serialized data outlives the code that wrote it, so it needs a version
tag the reader checks, the way a wire protocol carries a version byte. flattr's
model is small enough that both fixes are a few lines — which is precisely why
they're worth adding before the model grows.

Cross-link: how a dangling-edge failure actually surfaces and gets diagnosed is
`study-debugging-observability`; the trust-boundary framing is `study-security`.

---

## Interview defense

**Q: There's no database — so where does integrity live?**
Almost nowhere enforced at runtime. The relations are FK-shaped
(`Edge.fromNode/toNode → Node.id`) but nothing checks they resolve. `loadGraph`
is `graph as unknown as Graph` (`loadGraph.ts:10`) — a blind cast. The only real
guard is the build pipeline: `computeGrades` derefs both endpoints
(`grade.ts:27`), so a dangling edge crashes the build. That protects artifacts
this pipeline made, not hand-edited or version-skewed ones.

```
  build deref = the ONLY guard (build-time)
  loadGraph cast = the trust boundary with NO check
  dangling FK → crashes deep in A*, not at load
```
Anchor: "integrity lives in the build pipeline's deref and nowhere else — the
load boundary trusts the bytes."

**Q: What's the cheapest thing to add, and why that one first?**
A schema `version` field plus a `validateGraph` at `loadGraph`. Version first,
because serialized data outlives the code: with no version tag, a build/app
shape skew mis-reads *silently* (`undefined` for a moved field → NaN cost →
wrong routes). One field plus one comparison turns silent corruption into a
loud refusal. The referential check is the same O(E) pass, run once at startup.

```
  add: Graph.version + check in loadGraph
  silent skew → loud refusal at the boundary
```
Anchor: "version the serialized contract first — silent skew is the worst
failure, and it's one field to fix."

---

## See also

- `01-graph-as-entity-model.md` — the FK-shaped relations this file says nothing enforces
- `05-tile-prefixing-and-id-namespacing.md` — id collisions on merge (a different integrity concern, handled)
- `study-debugging-observability` — how a dangling edge actually surfaces and gets traced
- `study-security` — validation at the trust boundary as a security posture
