# Unvalidated artifact load

**Industry name:** deserialization without validation / trust-on-load (Industry
standard). The TypeScript-specific shape: an `as unknown as T` cast that
*asserts* a type the compiler can't and the runtime won't verify.
Project-specific instance: `graph.json` → `Graph` in the mobile app.

---

## Zoom out, then zoom in

Here's the whole thing. The mobile app doesn't compute the street graph — it
ships a prebuilt one as a 544 KB JSON file baked into the bundle, loads it
once at startup, and hands it to the routing engine as gospel. The line that
does the handoff tells TypeScript "this JSON is definitely a valid `Graph`."
Nothing — not the compiler, not the runtime — ever confirms that's true.

```
  Zoom out — where the load sits

  ┌─ Build pipeline (laptop, earlier) ──────────────────────────────┐
  │  run-build.ts → buildGraph → writeFileSync("data/graph.json")    │
  └────────────────────────────┬─────────────────────────────────────┘
            copy into the app's │ assets/  (manual step)
  ┌─ App bundle (phone) ────────▼─────────────────────────────────────┐
  │  assets/graph.json (544 KB, JSON)                                 │
  └────────────────────────────┬─────────────────────────────────────┘
                  loadGraph()   │  ★ `as unknown as Graph`  ← we are here
  ┌─ Routing engine (trusts it 100%) ──▼──────────────────────────────┐
  │  nearestNode · directedAstar · graphToGeoJSON — all read .nodes,  │
  │  .edges, .adjacency as if guaranteed well-formed                  │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: this is **deserialization without validation** — you parse external
bytes into an in-memory object and start using it without checking it matches
the type you claimed. The `as unknown as Graph` cast is a *promise to the
compiler*, not a *check at runtime*. This file walks what that promise costs:
the consequence isn't a breach (the artifact is your own build), it's that a
single malformed field ships a hard-crashing app to every user with no
recoverable error.

---

## Structure pass — the trust axis across the load

Trace one question: **at each step, does anyone confirm the data is a valid
Graph?** The answer is "no" at every layer — which is exactly why this is a
finding. The interesting seam is where "no" *stops mattering* because the
data has already been dereferenced.

```
  One question: "is the data validated as a Graph here?"

  ┌──────────────────────────────────────────────┐
  │ import graph from "graph.json"   (bundler)    │  → NO (just parses JSON)
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ loadGraph(): `as unknown as Graph`        │  → NO (asserts, can't check)
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ nearestNode / directedAstar  reads it │  → TOO LATE (dereferences)
          └──────────────────────────────────────┘

  the answer is "no" the whole way down — there is no gate at all
```

- **Layers:** bundler parse → `loadGraph` cast → engine consumption.
- **Axis:** trust ("is the Graph shape verified before use?").
- **Seam:** the `loadGraph` cast at `loadGraph.ts:10`. It's the boundary
  where untrusted bytes *become* a trusted typed object in the program's eyes
  — and it's a seam with no gate. The cast is load-bearing precisely because
  it's where validation *should* live and doesn't. Contrast with file 01: there
  the gate exists but leaks NaN; here there is no gate at all.

---

## How it works

### Move 1 — the mental model

You know the trap from `const data = await res.json() as User`. `res.json()`
returns `any`/`unknown`; the `as User` makes the red squiggles go away but
checks *nothing* — if the response is missing `email`, you find out when
`user.email.toLowerCase()` throws at runtime. `as unknown as Graph` is the
same move, just with the `unknown` step made explicit to force the compiler
to allow it.

```
  The pattern — a cast is a promise, not a check

   JSON bytes ──parse──► value: unknown ──`as Graph`──► value: Graph
                                              │
                                              └─ COMPILE-TIME ONLY.
                                                 zero runtime cost,
                                                 zero runtime check.
                                                 the type is now a LIE
                                                 if the bytes don't match.
```

The skeleton of "validated load" has three parts: **parse** (bytes → value),
**validate** (confirm value matches the schema — the part flattr omits), and
**use** (act on the typed value). Drop the validate step and "use" becomes
the de-facto validator: the first property access that hits a missing field
is where you learn the load was bad — by crashing.

### Move 2 — the walkthrough

**Part 1 — the bundler parses, doesn't validate.** `import graph from
"../assets/graph.json"` runs at bundle time. Metro turns the JSON into a
JS object and infers a *structural* type from the literal — but that inferred
type is "whatever shape this exact file happened to have," which is why the
code needs `as unknown as Graph` to force it to the real interface. Bridge
from `JSON.parse`: same thing, the result is just an object, not a
guaranteed-shaped one. Where it breaks: if you regenerate `graph.json` with a
pipeline change that renames `gradePct` to `grade`, the bundle still builds,
the cast still compiles, and the field is now `undefined` at runtime.

```
  Part 1 — parse with no shape guarantee

  graph.json bytes ──Metro/JSON──► plain object
                                       │
                                       └─ structurally inferred, NOT
                                          checked against the Graph interface
```

**Part 2 — the cast launders the type.** `loadGraph` returns `graph as
unknown as Graph`. The double cast is needed because the inferred JSON type
and `Graph` don't overlap enough for a single `as Graph` — so the author goes
through `unknown` (the "I know better" escape hatch) to silence the compiler.
What concretely happens: from this line on, every consumer sees a fully-typed
`Graph` with `.nodes`, `.edges`, `.adjacency`, and the compiler will *never*
warn about a missing field again. The type system has been told to stop
helping at exactly the boundary where it would help most.

```
  Part 2 — the cast (the seam with no gate)

  plain object ──`as unknown`──► unknown ──`as Graph`──► Graph
                                                           │
                       ════════ TRUST BOUNDARY ════════════
                       below this line the engine believes
                       every node/edge/adjacency entry exists
```

**Part 3 — the engine dereferences on faith.** The first real consumer is
`nearestNode(graph, point)` (called from `MapScreen.tsx:125`), which iterates
`graph.nodes` and reads `.lat`/`.lng` on each. Then `directedAstar` walks
`graph.adjacency[nodeId]` to get edge ids and looks each up in `graph.edges`.
Bridge from a `.map(item => item.id)` over an API list where one item is
`null`: the same `Cannot read property of undefined`. Here's the failure
chain for three realistic malformations:

```
  Part 3 — three malformed artifacts, three runtime outcomes

  malformation                       first crash site            user sees
  ─────────────────────────────────  ──────────────────────────  ─────────────
  edge.toNode points to missing id   grade/nearest reads          white screen,
                                     nodes[id].lat → undefined    no recovery
  elevationM is a string "12"        cost math → NaN              wrong route,
                                                                  silent
  adjacency[id] lists a deleted      A* looks up edges[eid]       white screen
    edge id                          → undefined.fromNode

  the bundle compiled fine in every case — the cast hid all three
```

**The one guard that does exist (and what it doesn't cover).**
`MapScreen.tsx:28-34` wraps `loadGraph()` in a `try/catch` and renders
"Failed to load graph." on throw. But this only catches a throw *during*
`prefixGraph(loadGraph())` — and the cast never throws (it's compile-time).
So a structurally-broken-but-parseable graph passes this guard and crashes
*later*, deep in the routing engine, where there is no catch. Concrete
consequence: the friendly error screen fires for "file totally missing" but
*not* for "file present but malformed" — the more likely failure after a bad
build.

### Move 2.5 — current state vs future state

This is built-but-not-hardened. The artifact pipeline works; the validation
step was never added because the producer and consumer are the same author's
code, so the shape is "known good by construction."

```
  Phase A (now)                        Phase B (hardened)
  ─────────────────────────────        ──────────────────────────────
  loadGraph(): graph as unknown        loadGraph(): GraphSchema.parse(graph)
    as Graph                             (zod / manual validator)
  trusts the build was correct         confirms shape at load
  bad build → deep runtime crash       bad build → one clear error at startup
  zero load cost                       one-time parse cost (~ms for 544 KB)
```

The takeaway is what *doesn't* change: the engine, the routing, the types —
all stay identical. Phase B adds exactly one gate at one line. The migration
cost is a schema definition plus the parse call; the payoff is moving the
crash from "deep in A* on a random user's phone" to "at startup, with a
message naming the bad field."

### Move 3 — the principle

A type cast is a claim about data you haven't verified; the compiler enforces
it on your *code* and never on your *bytes*. The general rule: **the boundary
between serialized bytes and typed objects is a validation boundary whether or
not you treat it as one.** If you skip the check, the first property access
becomes your validator — and it validates by crashing, at the worst possible
place. "It's my own build" lowers the *probability* of bad data; it doesn't
change the *blast radius* when it happens.

---

## Primary diagram

The full frame: build produces bytes, the cast launders them into a trusted
type with no gate, the engine crashes on the first bad field.

```
  Unvalidated artifact load — full frame

  ┌─ Build (earlier, laptop) ───────────────────────────────────────┐
  │  buildGraph → writeFileSync(data/graph.json)                     │
  └────────────────────────────┬─────────────────────────────────────┘
              manual copy into  │ mobile/assets/graph.json (544 KB)
  ┌─ Bundle parse (Metro) ──────▼─────────────────────────────────────┐
  │  import graph from "graph.json"  → plain object (no shape check)  │
  └────────────────────────────┬─────────────────────────────────────┘
            loadGraph()         │
  ═════════════════════════════╪══════ TRUST BOUNDARY (no gate) ══════
            `as unknown as Graph`│  ← asserts type, verifies nothing
  ┌─ Routing engine (trusts 100%) ▼───────────────────────────────────┐
  │  nearestNode  → nodes[id].lat                                      │
  │  directedAstar → adjacency[id] → edges[eid].fromNode              │
  │  graphToGeoJSON → edges.map(...)                                   │
  │     malformed field ▶ undefined deref ▶ WHITE SCREEN (no catch)   │
  │     (the try/catch in MapScreen only covers a THROW, which the    │
  │      cast never does — so structural breakage slips past it)      │
  └───────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The bundled base graph loads exactly once at app startup
(`MapScreen.tsx:28`, inside a `useMemo`). The *same* cast pattern recurs for
the runtime-built tiles: `useTileGraph.ts` builds graphs on-device from live
Overpass/Open-Meteo data and merges them — those go through `buildGraph` (so
they're constructed by typed code, not cast from JSON), but they're then
merged with the cast-loaded base via `mergeGraphs`/`stitchGraph`. So the
base graph's unvalidated shape contaminates the merged graph the engine
actually routes over.

```
  mobile/src/loadGraph.ts  (lines 6–11) — the whole finding, three lines

  import type { Graph } from "features/routing/types";   ← the claimed type
  import graph from "../assets/graph.json";              ← parsed, unchecked
  export function loadGraph(): Graph {
    return graph as unknown as Graph;                    ← THE CAST
  }
       │
       └─ `as unknown as Graph` is a double cast. Single `as Graph` won't
          compile (inferred JSON type ≠ Graph), so it routes through
          `unknown` — TypeScript's "trust me" hatch. After this line every
          consumer sees a guaranteed Graph. Remove the cast and the
          compiler would force you to prove the shape — which is the point.
```

```
  mobile/src/MapScreen.tsx  (lines 28–34) — the guard that misses

  const baseGraph = useMemo(() => {
    try {
      return prefixGraph(loadGraph(), "base");  ← only catches a THROW
    } catch {
      return null;                              ← shows "Failed to load graph."
    }
  }, []);
       │
       └─ This catches "asset missing / not parseable" (loadGraph throws).
          It does NOT catch "asset present but malformed" — the cast never
          throws, so a bad-shape graph passes here and crashes later in
          nearestNode/directedAstar where there is no try/catch. The guard
          defends the wrong failure mode.
```

```
  features/routing/nearest.ts (the first dereference) — where it actually crashes

  // iterates graph.nodes, reads n.lat / n.lng on each
  // an edge.toNode pointing at a missing node id → nodes[id] is undefined
  //   → undefined.lat → TypeError, no recovery
       │
       └─ This is the sink. It trusts that every id referenced anywhere in
          the graph resolves to a real node. That invariant is exactly what
          a validator at loadGraph would confirm — and what the cast skips.
```

**The fix, named:** define a runtime schema (zod is the standard, or a hand-
rolled validator matching the DSA-from-scratch ethos) and replace the cast
with `GraphSchema.parse(graph)` in `loadGraph`. Validate three invariants the
engine relies on: every `edge.fromNode`/`toNode` exists in `nodes`, every
`adjacency` edge id exists in `edges`, and every `elevationM`/`gradePct` is a
finite number (which also closes file 01's NaN leak at the consumer). One-time
cost of parsing 544 KB is single-digit milliseconds; the payoff is a clear
startup error instead of a deep crash.

---

## Elaborate

"Deserialization without validation" is the same root cause behind a whole
family of higher-severity bugs in server contexts — insecure deserialization
(CWE-502), where untrusted bytes become trusted objects that carry behavior,
not just data. flattr's version is the *benign* end of that spectrum: the
bytes are your own build artifact and carry only data, so the worst case is a
crash, not code execution. But the discipline is identical — the byte→object
boundary is a validation boundary. The reason it's worth a dedicated file
even though "it's my own data" is that the **blast radius** is total: one bad
build white-screens every install, and the friendly error screen specifically
doesn't catch it.

This connects directly to file 01: both are trust-boundary findings, and
both fail the same way (silent corruption / crash, not breach). The
difference is the gate — file 01 has a leaky one (`MAX_GRADE_PCT`), this has
none. Read `.aipe/study-data-modeling/` for the `Graph` schema's shape and
`.aipe/study-system-design/` for why the build-time/runtime artifact split
exists in the first place (it's a deliberate architecture call — the security
cost is just the un-gated load).

---

## Interview defense

**Q: You load a 544 KB JSON and cast it `as unknown as Graph`. What's the
risk?** The cast is a compile-time promise with no runtime check, so the
byte→object boundary has no validation gate. If the artifact ships malformed
— a dangling edge reference, a string where a number belongs — nothing
catches it until the routing engine dereferences a missing field and the app
white-screens. It's not a breach (it's my own build), but the blast radius is
every install, and the existing try/catch only covers a missing file, not a
malformed one.

```
  bytes ─parse─► object ─`as Graph`─► [NO GATE] ─► engine ─► deref ─► crash
                                       ▲
                          validation belongs here; cast skips it
```

*Anchor:* "the cast is a promise to the compiler, not a check at runtime."

**Q: It's your own data — why bother validating?** Because "my own data"
lowers the odds, not the blast radius. The load-bearing skeleton part people
forget is the **validate** step between parse and use — drop it and the first
property access becomes your validator, crashing deep in A* on a user's phone
instead of at startup with a named bad field. One `GraphSchema.parse` moves
the failure from worst-place to best-place.

```
  parse ─► [validate ◄ the omitted step] ─► use
              │
              └─ without it, "use" validates by crashing
```

*Anchor:* "skip validation and the first deref becomes the validator."

---

## Validate

**Reconstruct.** Write the three-part validated-load skeleton (parse /
validate / use) and mark which step `loadGraph.ts:10` omits.

**Explain.** Why does `as unknown as Graph` compile when `as Graph` alone
doesn't, and why does neither check the runtime shape? (Single cast: types
don't overlap; double cast routes through `unknown`; both are erased at
runtime.)

**Apply to a scenario.** A pipeline change renames `gradePct` to `grade` and
you regenerate `graph.json`. Does the bundle build? Does `loadGraph` throw?
Where does the app actually break, and does the `MapScreen.tsx:28` try/catch
save it? (Builds yes; throws no; breaks in cost math / GeoJSON as `undefined`;
try/catch does not save it.)

**Defend the decision.** Argue for adding a zod schema at `loadGraph.ts:10`
vs leaving the cast and relying on the build being correct. What's the
one-time cost, and what specifically does validating
`edge.toNode ∈ nodes` buy that the current code lacks?

---

## See also

- `01-external-data-trust-boundary.md` — the same trust-boundary failure mode
  with a leaky gate instead of no gate; the NaN-finiteness check belongs in
  both fixes.
- `audit.md` lens 3 (input-validation) and lens 1 (trust-boundaries).
- `.aipe/study-data-modeling/` — the `Node`/`Edge`/`Graph` schema and its
  referential invariants (the things a validator would check).
- `.aipe/study-system-design/` — the build-time/runtime artifact split as an
  architecture decision.
