# 02 — Unvalidated artifact load

**Industry name(s):** *unsafe deserialization* / *trusting a type assertion as a
runtime guarantee* / *boundary validation gap on a data artifact*.
**Type label:** Industry standard.

> This is the **highest-severity finding in the repo** — not because it leaks
> anything, but because it's the most likely thing to actually break in
> production, and it breaks in the worst place (deep in A*, not at load).

---

## Zoom out, then zoom in

Here's the whole app-startup path. The mobile app doesn't compute the street
graph live at launch — it ships a prebuilt artifact, `graph.json`, bundled into
the app. At startup it reads that file and hands it to the router. One line does
the handoff:

```
  Zoom out — where the artifact load sits

  ┌─ Build (offline, your machine) ─────────────────────────────┐
  │  run-build.ts → pipeline → JSON.stringify → data/graph.json  │
  └──────────────────────────┬──────────────────────────────────┘
            copied into       │  mobile/assets/graph.json (bundled)
  ┌─ App startup (mobile) ────▼──────────────────────────────────┐
  │  import graph from "../assets/graph.json"                     │
  │  return graph as unknown as Graph    ★ THE LOAD ★             │ ← here
  │  (loadGraph.ts:7-10)                                          │
  └──────────────────────────┬───────────────────────────────────┘
                 Graph        │  (asserted, NOT validated)
  ┌─ Routing ────────────────▼───────────────────────────────────┐
  │  prefixGraph → A* → reads .nodes, .edges, .adjacency          │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in. The concept: an *artifact* is data produced by one process and
consumed by another, across a trust boundary in *time* (build-then-run) rather
than space (client-then-server). The question this load answers: *what happens
if the artifact is malformed, truncated, or schema-drifted from what A*
expects?* The answer in flattr today: **nothing checks, so it crashes deep
inside the router with a cryptic error** — or worse, half-works and routes
wrong.

---

## The structure pass

**Layers:** build producer → serialized JSON on disk → bundler → `loadGraph`
consumer → A* router.

**The one axis: trust (specifically, "what's verified at the load point?").**
Trace it:

```
  Trust at the artifact boundary

  ┌────────────────────────────────────┐
  │ build: JSON.stringify(graph)        │  → produces a STRING. No schema
  │   (run-build.ts:12)                 │     stamped, no version, no checksum
  └────────────────────────────────────┘
      ┌────────────────────────────────┐
      │ bundler: file → JS module       │  → TS infers a STRUCTURAL type from
      │   import graph from "...json"   │     the literal — NOT the Graph type
      └────────────────────────────────┘
          ┌────────────────────────────┐
          │ loadGraph: as unknown as    │  → ASSERTS Graph. `unknown` first
          │   Graph (loadGraph.ts:10)   │     erases the inferred type, then
          └────────────────────────────┘     casts. Zero runtime check.
              ┌────────────────────────┐
              │ A*: graph.nodes[id].lat │  → TRUSTS the assertion fully
              └────────────────────────┘
```

**The load-bearing seam:** the `as unknown as Graph` at `loadGraph.ts:10`. This
is *the* point where an unverified blob becomes a fully-trusted `Graph`. The
axis (is it verified?) is "no" on the left of this line and "assumed yes" on the
right — and nothing in between makes the assumption true. A seam where trust
flips on an *assertion* instead of a *check* is exactly the dangerous kind.

The `as unknown as` double-cast is itself a tell. TypeScript would *reject* a
direct `graph as Graph` if the inferred JSON type isn't assignable — so the code
launders it through `unknown` to silence the compiler. That's the type system
telling you "I can't prove this," and the code answering "trust me anyway."

---

## How it works

### Move 1 — the mental model

You've hit this exact bug shape before: `const user = JSON.parse(localStorage
.getItem("user")!) as User`, and then three components later something explodes
because the stored blob was from an old app version missing a field. The cast
told the compiler it was a `User`; the runtime data disagreed; the failure
surfaced far from the load. Same shape here, bigger blast radius.

```
  The pattern (anti-pattern): assert-don't-check

   disk blob ──► [ as Graph ]  ──► consumer
   (unknown)      (a LIE the         (A*, trusts
                   compiler           every field)
                   believes)
                       │
                       └── no gate. malformed blob
                           passes straight through

   the fix: replace the cast with a parse
   disk blob ──► [ schema.parse() ] ──► Graph  (or throw HERE)
```

The kernel: a type assertion (`as T`) is a **compile-time** claim with **zero
runtime cost and zero runtime effect**. It does not inspect the value. It's a
promise to the compiler, not a check on the data.

### Move 2 — the walkthrough

**Step 1 — the producer writes an untyped string.** `writeGraph`
(`run-build.ts:11-13`) is just `JSON.stringify(graph)`. No schema version, no
field manifest, no checksum lands in the file. So the artifact carries *no
self-description* — a consumer can't even tell which build produced it.

```
  Producer side (run-build.ts:11-13)

  Graph (typed in memory) ──► JSON.stringify ──► "{...}" (string, no schema)
                                                  └─► data/graph.json
```

**Step 2 — the consumer asserts the type away.** The entire load is two lines:

```ts
// mobile/src/loadGraph.ts:6-10
import type { Graph } from "features/routing/types";
import graph from "../assets/graph.json";

export function loadGraph(): Graph {
  return graph as unknown as Graph;   // ← no validation, double-cast
}
```

Read it: `import graph from "...json"` gives TypeScript a *structural* type
inferred from the literal's shape — but a bundled JSON's inferred type generally
isn't assignable to `Graph` (optional fields, tuple-vs-array widening), so
`as Graph` alone won't compile. `as unknown as Graph` erases the inferred type
to `unknown`, then asserts `Graph`. Net effect: **the compiler is satisfied and
nothing runs.** Whatever bytes are in the file are now a `Graph` as far as the
rest of the app is concerned.

**Step 3 — where it actually breaks.** A* and its helpers index the graph
trusting the assertion. `nearestNode` and `directedAstar` read
`graph.nodes[id].lat`, `graph.adjacency[nodeId]`, `edge.gradePct`. Walk the
failure for three realistic drift scenarios:

```
  Execution trace — malformed artifact, three drifts

  drift A: a node missing `elevationM`
    load        → passes (no check)
    A* expand   → cost.ts reads edge.gradePct (precomputed, OK)
    BUT grade  → if grades recomputed: undefined - n = NaN → bad route
    surfaces   → WRONG ROUTE, no error. Worst kind: silent.

  drift B: adjacency references an edge id not in edges[]
    load        → passes
    A* expand   → graph.edges.find(e=>e.id===ref) → undefined
    next read   → undefined.toNode → TypeError, DEEP in A*
    surfaces   → CRASH, cryptic stack inside the router.

  drift C: truncated JSON (partial write / bad copy)
    import      → bundler may fail at build, OR ship partial object
    load        → passes the cast
    A* first op → graph.nodes is {} → nearestNode returns null
    surfaces   → "Failed to load graph" IF caught at MapScreen.tsx:31,
                 else null-deref downstream.
```

The only safety net today is the `try/catch` around `prefixGraph(loadGraph())`
at `MapScreen.tsx:28-34`, which renders "Failed to load graph." — but that only
catches a *throw at load*, and the cast doesn't throw. It catches drift C's
truncation-if-it-throws; it does **not** catch drift A (silent) or drift B
(throws later, inside A*, outside the try).

**Step 4 — the fix, concretely.** Replace the assertion with a parse. Two
flavors:

```
  Fix A — schema parse (Zod-style), throws at the boundary

  import { GraphSchema } from "./graphSchema";
  export function loadGraph(): Graph {
    return GraphSchema.parse(graph);   // throws HERE, with a field path,
  }                                    // caught by MapScreen's try/catch

  Fix B — hand-rolled guard (no dep), same effect
    assert graph.nodes is object, every node has finite lat/lng/elevationM,
    every adjacency ref resolves to an edge, throw a clear Error if not.
```

Either way the win is *locality*: the failure moves from "TypeError deep in A*"
to "graph.json failed validation: nodes['n12'].elevationM expected number" at
the load line — caught by the existing `try/catch`, shown as a clear message.

### Move 2 variant — the load-bearing skeleton

Kernel of a safe artifact load:

1. **The single load point.** One function owns the deserialize. *Breaks if
   missing:* casts scatter and some path skips validation. flattr *has* this —
   `loadGraph` is the one door. Good bones.
2. **The runtime validation.** The blob is checked against the expected schema
   *before* it's trusted. *Breaks if missing:* a malformed artifact fails far
   from the load, cryptically. **This is the missing part** — the cast replaces
   the check.
3. **The fail-closed behavior.** On invalid data, throw/refuse at the load, not
   limp onward. *Breaks if missing:* silent wrong output (drift A). flattr is
   *fail-open* today for non-throwing drift.

**Skeleton vs hardening:** validation (2) + fail-closed (3) are skeleton. A
*version stamp* in the artifact (so the app can say "this graph is from an
incompatible build") and a *checksum* (to catch truncation) are hardening — nice,
not load-bearing.

### Move 3 — the principle

A type assertion is not validation. `as T` is a compile-time promise that does
nothing at runtime — the instant data crosses from outside the program (a file,
a network response, `localStorage`) the only thing that makes the type *true* is
a runtime parse. The discipline: **parse at the boundary, assert never.** Every
`as` on external data is a silent bet that the producer and consumer never
drift. They always drift.

---

## Primary diagram

The full load path with the gap and the fix marked.

```
  Unvalidated artifact load — full recap

  ┌─ BUILD (offline) ───────────────────────────────────────────┐
  │  pipeline → JSON.stringify (run-build.ts:12)                  │
  │  → data/graph.json  (no schema, no version, no checksum)      │
  └──────────────────────────┬───────────────────────────────────┘
              copy            │  → mobile/assets/graph.json (bundled)
  ┌─ LOAD (loadGraph.ts) ────▼───────────────────────────────────┐
  │  import graph from json                                       │
  │  ╔══════════════════════════════════════════════════╗        │
  │  ║ return graph as unknown as Graph   ← THE GAP      ║        │
  │  ║ (no runtime check; double-cast launders unknown)  ║        │
  │  ╚══════════════════════════════════════════════════╝        │
  │  FIX: GraphSchema.parse(graph) → throws here, caught upstream │
  └──────────────────────────┬───────────────────────────────────┘
            Graph (asserted)  │
  ┌─ CONSUME (A*) ───────────▼───────────────────────────────────┐
  │  nearestNode / directedAstar read .nodes .edges .adjacency    │
  │  drift → NaN route (silent) | TypeError deep in A* (cryptic)  │
  │  only net today: try/catch at MapScreen.tsx:28 (load-throw    │
  │  only) → "Failed to load graph."                              │
  └───────────────────────────────────────────────────────────────┘
```

---

## Elaborate

Unsafe deserialization is OWASP A08:2021 — though the *classic* version (Java
`readObject`, Python `pickle`, PHP `unserialize`) is about *code execution* from
a crafted blob. flattr's version is the milder, more common one: not RCE
(JSON can't carry code), but **integrity/availability** — a malformed blob
breaking the consumer. The reason it still ranks highest *here* is base-rate:
there's no attacker needed. A bad copy, a build that changed the `Graph` shape
without re-bundling, a partial write — all produce the same crash, and they're
*likely* in a project where the artifact and the schema (`types.ts`) evolve
independently.

The root cause is shared with `01`: TypeScript's types are erased at runtime, so
trusting `as T` on external data is trusting a guarantee that doesn't exist past
`tsc`. The industry answer is *schema-first deserialization* — Zod, io-ts,
Valibot, or hand-rolled guards — where the schema is the single source of truth
and the static type is *derived from it* (`type Graph = z.infer<typeof
GraphSchema>`), so the type and the runtime check can't drift.

Read next: `01` (the network version of this gap), and `study-data-modeling`
for the `Graph` schema that a validator would encode.

---

## Interview defense

**Q: What's the single biggest security risk in this codebase?** Not a breach —
there's nothing to steal. It's the unvalidated artifact load at
`loadGraph.ts:10`: `graph.json` is cast `as unknown as Graph` with no runtime
check. If the artifact is malformed or schema-drifted, the app either crashes
deep inside A* with a cryptic `TypeError` or — worse — silently produces a wrong
route. It's the highest *availability/integrity* risk because it needs no
attacker: a bad copy or a schema change triggers it.

```
  the sketch I'd draw

  graph.json ──► [as unknown as Graph]  ──► A*
   (any bytes)    ↑ a cast, not a check        │
                  │                            ▼
   fix: schema.parse() throws HERE   ...else TypeError deep in router
        caught by MapScreen try/catch       (or silent NaN route)
```

**Anchor:** *"`as unknown as Graph` is the compiler being told to trust data it
can't prove. The fix is to parse at the boundary so failure is local and
loud."*

**Q: Why is the existing `try/catch` at MapScreen not enough?** Because the cast
doesn't throw. The `try/catch` at `MapScreen.tsx:28` only catches a throw *at
load* — it'd catch JSON that fails to parse, but the `as` cast on
already-parsed-by-the-bundler data never throws, so silent drift (a missing
field) sails past it and surfaces later, inside A*, outside the `try`. A schema
`.parse()` would move the throw *to* the load line, *inside* the existing
`try/catch` — reusing the net that's already there.

**Q: Load-bearing part people forget?** Fail-*closed*. People remember to add
validation but let it *warn and continue*. For a graph, continuing on a missing
field gives you a silent wrong route — arguably worse than a crash, because a
hiker trusts the grade. Validation must throw, not warn.

---

## See also

- `01-external-data-trust-boundary.md` — same "TS types ≠ runtime guarantees"
  root cause, at the network fetch instead of the file load.
- `audit.md` lens 1, 3, 8 — boundary map, injection, and the red-flag checklist
  (this is the HIGH row).
- Siblings: `study-data-modeling` (the `Graph` schema to validate against),
  `study-debugging-observability` (why a deep-in-A* crash is a debugging tax,
  and how a boundary throw fixes the locality), `study-system-design` (the
  build-time→runtime artifact handoff).
