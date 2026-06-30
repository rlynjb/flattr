# Unvalidated Artifact Load

**Industry name(s):** trust-on-deserialization / unvalidated deserialization;
"parse, don't validate" inverted. **Type:** Language-agnostic (TS-flavored here).

This is the single worst exposure in flattr — ranked first for a reason: it's
the easiest trust assumption to trip and it fails the hardest, far from where the
mistake lives.

---

## Zoom out — where this lives

The whole app stands on one file it never checks. `graph.json` is the prebuilt
artifact; every route, every heatmap, every nearest-node snap reads from it.

```
  Zoom out — graph.json is the foundation under everything

  ┌─ BUILD TIME (your machine) ────────────────────────────────┐
  │  pipeline/run-build.ts → writes data/graph.json            │
  │  (copied by hand into mobile/assets/graph.json)            │
  └─────────────────────────────┬──────────────────────────────┘
                                │  bundled into the app
  ┌─ RUNTIME (mobile app) ──────▼──────────────────────────────┐
  │  ★ loadGraph.ts:10  graph as unknown as Graph ★  ← we are here│
  │         │  no schema check, no runtime validation          │
  │         ▼                                                   │
  │  directedAstar ─ nearestNode ─ graphToGeoJSON ─ computeZones│
  │  (every consumer assumes the Graph is well-formed)         │
  └────────────────────────────────────────────────────────────┘
```

The box marked with ★ is a one-line function. That one line is a trust
decision: *"whatever is in this JSON file, I declare to be a valid `Graph`."*
The TypeScript type says `Graph`; the runtime value is whatever bytes are on
disk. The `as unknown as` double-cast is the language telling you, in syntax,
*"I've turned off all the type checks for this conversion."*

## Zoom in — the concept

The pattern is **trust-on-deserialization**: data crosses a boundary as bytes,
you parse it, and you treat the parsed shape as if a type system guaranteed it —
when nothing did. The question it answers: *what happens when the artifact is
malformed, truncated, or drifted from the schema the consumers expect?* In
flattr the answer is "a crash deep inside A*, with a stack trace pointing at the
router, not at the bad file." → see also `audit.md` lens 1 and 3.

---

## The structure pass

**Layers:** (outer) the JSON file on disk → (middle) `loadGraph()` the cast →
(inner) every routing consumer that dereferences nodes and edges.

**Axis traced — `trust`: "is the data validated here?"**

```
  One axis (trust) traced down the artifact's path

  layer                         is the data validated?
  ────────────────────────────  ──────────────────────
  graph.json on disk            n/a (just bytes)
  loadGraph.ts:10 (the cast)    NO — `as unknown as Graph`   ← seam
  directedAstar (astar.ts:64)   assumes valid (deref edge)
  byId.get(edgeId)! (line 65)   assumes valid (non-null `!`)
  graph.nodes[next] (line 72)   assumes valid (deref node)
```

**The seam:** `loadGraph.ts:10`. That's where the trust answer *should* flip
from "untrusted bytes" to "validated Graph" — and instead it flips from
"untrusted" to "trusted" with nothing in between. Every consumer downstream
inherits a promise that was never checked. The `!` non-null assertions at
`astar.ts:65` and the bare `graph.nodes[next]` at `astar.ts:72` are the
*receipts* of that unchecked promise: they only hold if the artifact is perfect.

---

## How it works

### Move 1 — the mental model

You already know this shape from `fetch()`. When you write `const data = await
res.json() as User`, TypeScript believes you — but the server could return
`{ error: "..." }` and `data.name` is `undefined` at runtime. The `as` is a
*promise you made to the compiler*, not a check the compiler ran. `loadGraph`
is the same move, escalated: `as unknown as Graph` is the compiler saying "these
types don't even overlap, but you insisted."

```
  The pattern: a cast is a promise, not a proof

   bytes ──parse──► value : any ──cast──► value : Graph
                                  ▲
                                  │  ★ NO CHECK HAPPENS HERE ★
                                  │  the type is now a lie if the
                                  │  bytes didn't match the shape
                                  ▼
              consumers deref .nodes[id], .adjacency[id], edge.toNode
              ─ first bad reference → runtime crash, deep in A*
```

The kernel of the *vulnerability* is: **the gap between the type-level promise
and the runtime reality, with no validation layer to close it.**

### Move 2 — the walkthrough

**The cast itself.** Here's the entire load path — eleven lines, one of them
load-bearing:

```ts
// mobile/src/loadGraph.ts
import type { Graph } from "features/routing/types";
import graph from "../assets/graph.json";   // bundler parses JSON → plain object

export function loadGraph(): Graph {
  return graph as unknown as Graph;           // ← line 10: the trust decision
}
```

Line 10 is the whole finding. `graph` is typed by the bundler as a wide
structural type (or `any`), and `as unknown as Graph` forces it to `Graph`.
TypeScript needs the `unknown` hop precisely *because* the inferred JSON type and
`Graph` don't overlap enough for a direct cast — that double-cast is the smell.
No call to a validator, no `assertIsGraph(graph)`, nothing checks that
`graph.nodes` exists, that every `edge.toNode` resolves to a real node id, that
`adjacency` references real edges, or that coordinates are finite numbers.

**Where it actually breaks.** The crash doesn't happen at load — it happens later,
inside the router, which makes it *worse* (the stack trace blames A*, not the
file). Trace one bad artifact through:

```
  Execution trace — a graph.json with a dangling edge ref

  state: edge "e7".toNode = "n99", but nodes["n99"] does not exist

  step  code site                       what happens
  ────  ──────────────────────────────  ───────────────────────────────
  1     loadGraph.ts:10                  cast succeeds (no check) ✓
  2     astar.ts:64  adjacency[current]  returns ["e7", ...]      ✓
  3     astar.ts:65  byId.get("e7")!     edge found               ✓
  4     astar.ts:66  otherEnd(edge,..)   returns "n99"            ✓
  5     astar.ts:72  graph.nodes["n99"]  → undefined
  6     heuristicFn(undefined, goal)     → haversine reads .lat of
                                          undefined → THROW 💥
```

The two specific landmines, both in `features/routing/astar.ts`:

- **`byId.get(edgeId)!`** (`astar.ts:65`) — the `!` asserts the edge exists. If
  `adjacency` references an edge id that isn't in `graph.edges`, `byId.get`
  returns `undefined`, the `!` lies, and `edge.id` / `otherEnd(edge, current)`
  throws on the next line.
- **`graph.nodes[next]`** (`astar.ts:72`, also `:45`) — if an edge points to a
  node id missing from `graph.nodes`, `heuristicFn(graph.nodes[next], goal)`
  passes `undefined` into `haversine`, which reads `.lat` of `undefined`.

Note the *one* place flattr does check: `astar.ts:40` guards the
start/goal node — `if (!graph.nodes[startId] || !goal) return { path: null }`.
That's a graceful miss for *bad input ids*. There's no equivalent guard for a
*bad artifact* — the internal references are all trusted.

**Why this is availability, not confidentiality.** Nothing leaks. The attacker
(or, far more likely, a build that drifted or a truncated file) doesn't read
secret data — they crash the app. For a routing tool, "the map screen throws and
shows *Failed to load graph*" (the only fallback, `MapScreen.tsx:164`, which
only catches errors thrown *inside* `prefixGraph`, not inside A*) is a denial of
function.

### Move 2 variant — the load-bearing skeleton

The kernel of a *fix* (a validation layer) has three parts; name each by what
breaks without it:

1. **Structural check** — `graph.nodes`, `graph.edges`, `graph.adjacency` exist
   and have the right container types. *Missing → a missing top-level field
   crashes on first access instead of erroring cleanly.*
2. **Referential-integrity check** — every `edge.fromNode`/`toNode` resolves to a
   real node; every `adjacency[id]` references a real edge. *Missing → the
   dangling-reference crash above (`astar.ts:65`/`:72`) survives.*
3. **Domain check** — coordinates finite, in lat/lng range; `lengthM ≥ 0`;
   `gradePct` within ±`MAX_GRADE_PCT`. *Missing → a NaN coordinate poisons
   haversine and every cost computation silently (wrong routes, not a crash).*

**Skeleton vs hardening:** parts 1–2 are the kernel — they're what turns a deep
crash into a clean load-time error. Part 3 is hardening that also catches the
*silent* corruption class (the one `01-` covers from the build side). A
schema-validation library would do all three; a hand-rolled `assertIsGraph`
covering 1–2 is the minimum that earns its place.

### Move 2.5 — current state vs future state

```
  Phase A (today)              Phase B (with validation)
  ─────────────────────────    ──────────────────────────────
  loadGraph(): cast only       loadGraph(): parse → validate → return
  bad artifact → A* crash      bad artifact → throw at load site
  blame lands on router        blame lands on the file (correct)
  no fallback for bad data     MapScreen.tsx:164 catch already exists
                               and would now catch it cleanly
```

What *doesn't* have to change: the catch at `MapScreen.tsx:164` already wraps
graph load and renders "Failed to load graph." Move the validation inside
`loadGraph` (or before `prefixGraph`) and that existing fallback starts working
for the bad-artifact case for free. The fix is small and the safety net is
already wired.

### Move 3 — the principle

A type annotation is a claim about data that *already crossed a trust boundary*;
it is not a check that the data is what you claimed. The rule that generalizes:
**validate at the boundary, once, where the bytes become objects — never trust a
cast to do a validator's job.** "Parse, don't validate" (Alexis King) is the
positive version: make the parse step *produce* the trusted type, so an invalid
input can't construct it.

---

## Primary diagram

The whole finding in one frame: the trust line, the cast that crosses it
unchecked, and the two deref sites where a bad artifact detonates.

```
  Unvalidated artifact load — full picture

  ┌─ UNTRUSTED ────────────────────────────────────────────────┐
  │  graph.json  (bytes — could be drifted/truncated/tampered)  │
  └───────────────────────────┬────────────────────────────────┘
            trust line ........│........ NO VALIDATION HERE
                               ▼
  ┌─ TRUSTED (declared, not proven) ───────────────────────────┐
  │  loadGraph.ts:10   graph as unknown as Graph                │
  │         │                                                   │
  │         ▼                                                   │
  │  directedAstar → search() ─────────────────────────────────│
  │     astar.ts:65   byId.get(edgeId)!     ← dangling edge 💥  │
  │     astar.ts:72   graph.nodes[next]     ← missing node  💥  │
  │     (astar.ts:40  start/goal guarded ✓ — input ids only)    │
  └────────────────────────────────────────────────────────────┘
   fix: insert assertIsGraph() at the trust line → crash becomes
        a clean load-time error caught by MapScreen.tsx:164
```

---

## Elaborate

This pattern is the client-side twin of the server-side "unvalidated
deserialization" class (CWE-502) — same root cause (trusting a parsed shape),
different blast radius (crash/corruption here vs RCE when the deserializer can
instantiate arbitrary types, which JSON.parse cannot). The reason it shows up in
flattr is the build/runtime split: the artifact is produced by one process and
consumed by another, with a manual copy step in between (`loadGraph.ts:3-4`
comments document the hand-copy). Any time producer and consumer are decoupled,
the schema is a *contract* that nothing enforces unless you write the check.
You've felt this exact seam before: `migrations/0003_chunks.sql` defines a table
shape, and a row that violates it is rejected by the DB — that rejection *is* the
validation layer flattr is missing for `graph.json`. Read next: `01-` (the same
trust gap from the *build* side, where the bad data is born), and the `study-data-modeling`
guide for the `Graph` schema this finding assumes.

---

## Interview defense

**Q: "Your `loadGraph` does `as unknown as Graph`. Walk me through the risk."**

The cast is a promise to the compiler, not a runtime check. The artifact crosses
a trust boundary as bytes; the cast declares it a `Graph` without proving it. A
malformed artifact — dangling edge ref, missing node, NaN coordinate — passes the
cast and crashes deep inside A*, not at the load site.

```
  bytes ──cast (no check)──► "Graph" ──deref──► 💥 byId.get(id)!  astar.ts:65
                                                 💥 nodes[next]    astar.ts:72
```

*Anchor:* "The crash blames the router; the bug is in the loader."

**Q: "Is this a vulnerability or just a bug?"**

It's an *availability* finding, not a confidentiality one — nothing leaks; the
failure mode is denial of function. The exploit path is realistic without a
malicious actor: a drifted build or a truncated bundle file is enough. That's
what makes it the highest-priority finding despite "no attacker."

*Anchor:* "Most likely 'attacker' here is your own build pipeline."

**Q: "Cheapest correct fix?"**

A runtime validation layer at the load site — structural + referential-integrity
checks (parts 1–2 of the skeleton). The non-obvious payoff: the fallback at
`MapScreen.tsx:164` already catches load-time throws, so moving the check there
makes the existing safety net work for the bad-artifact case for free.

*Anchor:* "Validate at the boundary; let the existing catch do its job."

---

## See also

- `01-external-data-trust-boundary.md` — the same corruption, born at the
  *build* side (OSM/elevation entering the pipeline).
- `03-user-input-to-third-party-url.md` — the other live boundary (outbound).
- `audit.md` — lens 1 (trust boundaries) and lens 3 (input validation).
- `00-overview.md` — why this ranks #1.
