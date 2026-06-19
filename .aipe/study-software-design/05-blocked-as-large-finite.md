# BLOCKED as a large finite number
### Define errors out of existence / sentinel-over-exception — Project-specific design move

## Zoom out, then zoom in

"There's no route flat enough for you" is a thing the app must say. The design
question is whether that's an *error* or just an *expensive path*. flattr's
answer is the cleanest decision in the codebase. Here's where it's made.

```
  Zoom out — where BLOCKED lives

  ┌─ Engine layer (features/routing) ─────────────────────────────┐
  │  cost.ts: penalty()  ── over-max edge? ──► ★ return BLOCKED ★  │ ← we are here
  │                                            (1e9, not Infinity, │
  │             │                               not a throw)       │
  │             ▼                                                  │
  │  search() sums costs → still returns a PATH (the least-bad one)│
  └───────────────────────────┬──────────────────────────────────┘
                              │ path + steepEdges[]
  ┌─ UI layer ▼───────────────────────────────────────────────────┐
  │  RouteSummaryCard: "Flat all the way" / "⚠ Flattest available" │
  │                    / "No route between those points"           │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** You know how returning `-1` from `indexOf` instead of throwing
"not found" lets the caller treat "absent" as ordinary control flow? `BLOCKED`
is that idea, tuned. An edge steeper than your comfort max doesn't throw and
doesn't cost `Infinity` — it costs `1e9`, a number so large the router avoids it
unless it's the *only* way through. The pattern is **define the error out of
existence**: there's no "no flat route" exception to catch, because
"flattest-but-steep" is just a normal path with some edges flagged. The genuine
error — "no route at all" — stays distinct, because *that* one really does
return `null`.

## Structure pass

**Layers.** The **cost layer** (`penalty` returns `BLOCKED`), the **search
layer** (`search` sums it and still finds a path), and the **honesty layer**
(`steepEdges` flagging + the UI card). The trick is that the error never becomes
a control-flow event at any layer — it stays a *value*.

**Axis — "how is the failure represented at each layer?"**

```
  One question down the layers: "how is 'too steep' represented?"

  ┌──────────────────────────────────────┐
  │ penalty (cost.ts)                    │  → a NUMBER (1e9), not a throw
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ search (astar.ts)                │  → an expensive edge; still relaxed
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ summarizePath (astar.ts)     │  → an entry in steepEdges[]
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ RouteSummaryCard         │  → "⚠ Flattest available"
              └──────────────────────────┘

  the failure is a value the whole way down — never an exception, never Infinity.
```

**Seam.** The load-bearing distinction is `BLOCKED` (finite) vs `path === null`
(disconnected). The two failure modes — "too steep" and "no route" — are kept on
*opposite sides* of that seam. Conflate them (use `Infinity`, or throw) and the
app can't tell "I found a hilly path, fair warning" from "those points aren't
connected." Two different messages, one design decision.

## How it works

### Move 1 — the mental model

The shape is a number line with a wall that's tall but not infinite.

```
  Pattern — BLOCKED is a tall wall, not an infinite one

  cost
   1e9  ┤ ████ ← BLOCKED: over-max edges. avoided unless they're the
        │ ████   ONLY way through. then they're taken, and flagged.
        │
   low  ┤ ░░░░ ← normal edges (flat-ish). preferred.
        └──────────────────────────────────► edges

  Infinity would make over-max edges UNTAKEABLE → "flattest available"
  collapses into "no route." the wall must be finite.
```

A finite wall means the search will climb it if it must. An infinite wall (or a
thrown exception) means it won't — and the user who'd happily take one steep
block to get home gets "no route" instead of a route with a warning.

### Move 2 — the walkthrough

**Setting the wall — `penalty`'s over-max branch.** Bridge from a form
validator that returns an error *string* instead of throwing: the failure is
data the caller can inspect, not an event that unwinds the stack.

```
  penalty(g, max):
      ...
      if g > max: return BLOCKED        // 1e9 — finite, huge
      ...
```

The boundary that bites: `BLOCKED` must be large enough to dominate any
realistic sum of normal edge costs, but *finite*. Pick it too small and the
router treats a steep shortcut as merely "a bit pricey" and routes you up a
cliff. Pick `Infinity` and you've re-created the exception you were avoiding.
`1e9` against street-meter costs (tens to thousands) is the right order of
magnitude.

**Summing the wall — search stays oblivious.** `search` adds `BLOCKED` into the
running cost like any other number (`astar.ts:68`). It has no special case for
"too steep." If a path with one over-max edge is the only way through, its total
cost is ~`1e9`-and-change, which beats `null` (no path), so the search returns
it. The error-handling code that *would* live in `search` — a try/catch, an "is
this Infinity" check — simply doesn't exist. That absence is the design win.

**Flagging the wall — honesty without a special case.** `summarizePath`
separately records which edges exceeded `userMax` into `steepEdges`
(`astar.ts:126`), using `directedGrade` — independent of the cost math.

```
  summarizePath(nodes, edges, userMax, costFn):
      for each edge i:
          cost += costFn(edge, from, userMax)            // may include BLOCKED
          if userMax finite AND directedGrade(edge, from) > userMax:
              steepEdges.push(edge.id)                    // honesty list
      return { ..., steepEdges }
```

So the route *knows* it's steep, but that knowledge is a list, not an error. The
UI reads `steepEdges.length`: zero → "Flat all the way", non-zero → "⚠ Flattest
available". And `path === null` (a different return, from a disconnected graph)
→ "No route between those points."

```
  State diagram — three outcomes, two mechanisms

         search result
        ╱            ╲
   path = null      path ≠ null
      │                 │
      ▼            steepEdges.length
  "No route"        ╱        ╲
                  == 0       > 0
                   │           │
                   ▼           ▼
          "Flat all the way" "⚠ Flattest available"
```

### Move 3 — the principle

Before you write a handler for an error, ask whether the error needs to exist.
Often a redefinition makes the special case disappear: "no flat route" isn't a
failure, it's "the flattest route, which happens to be steep." The two
genuinely-different outcomes ("steep" vs "disconnected") then need *no* shared
error channel — one is a flag on a normal return, the other is the absence of a
return. Fewer exceptions, fewer handlers, fewer places to get it wrong.

## Primary diagram

The full path of the "error" that never becomes one.

```
  BLOCKED — the defined-out error, full picture

  ┌─ cost.ts ──────────────────────────────────────────────────┐
  │ penalty: g > max  →  return BLOCKED (1e9, finite)           │
  └───────────────────────────┬────────────────────────────────┘
                              ▼ a big number, summed like any other
  ┌─ astar.ts search() ────────────────────────────────────────┐
  │ no special case. if it's the only path, returns it.        │
  │ summarizePath: steepEdges = edges where directedGrade>max  │
  └───────────────────────────┬────────────────────────────────┘
                  ┌───────────┴───────────┐
            path === null            path with steepEdges[]
                  │                         │
  ┌─ UI: RouteSummaryCard ─────────────────────────────────────┐
  │ "No route"        "Flat all the way" / "⚠ Flattest avail."  │
  └─────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Set `userMax` to "Kick scooter" (5%) in a hilly neighborhood and
many edges go over-max. Without `BLOCKED`-as-finite the app would say "no route"
constantly; with it, you get the flattest available path plus "⚠ 3 steep
blocks." Drop a pin on an island with no graph connection and you genuinely get
`null` → "No route." Two different truths, told apart.

**The definition + the over-max branch — `features/routing/cost.ts:5,16–22`.**

```
  cost.ts  (lines 5, 19)

  export const BLOCKED = 1e9;
       └─ "Large but FINITE, so an only-steep path is still returned and flagged."
          (the comment IS the design rationale — audit Lens 7 praises this)

  export function penalty(g, max, …) {
    if (g <= 0) return 0;
    if (g > max) return BLOCKED;     ← over comfort → tall finite wall, not throw
    ...
  }
```

**The honesty flag — `features/routing/astar.ts:120–130`.**

```
  astar.ts  (lines 120–130, inside summarizePath)

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]; const from = nodes[i];
    cost += costFn(edge, from, userMax);                  ← may add BLOCKED, no branch
    lengthM += edge.lengthM;
    if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
      steepEdges.push(edge.id);                           ← flag, independent of cost
    }
  }
  return { nodes, edges: edgeIds, cost, lengthM, steepEdges };
       │
       └─ steepEdges is the honesty channel. the cost math doesn't branch on
          "too steep"; the flag does. two concerns, cleanly separated.
```

**The three-way readout — `mobile/src/RouteSummaryCard.tsx:15,26`.**

```
  RouteSummaryCard.tsx  (lines 15, 26)

  if (!found || !summary) { … "No route between those points." }   ← path === null
  const clean = summary.steepCount === 0;                          ← steepEdges.length
  …  clean ? "Flat all the way" : "⚠ Flattest available"
       │
       └─ reads the two mechanisms (null vs steepEdges) as three messages.
          (audit Lens 7 flags the !found/!summary branch as the one non-obvious
           spot — the logic is right, the shape could be three explicit cases.)
```

## Elaborate

This is APOSD's strongest error-handling move: **define errors out of
existence.** The related idea is *exceptions as a last resort* — flattr reaches
for a sentinel value (`BLOCKED`) over a thrown exception, so the failure flows
as data through the same path as success. It also touches *masking errors at a
low level* in spirit, but it's cleaner than masking: the "error" was never
modeled as an error to begin with. The project context lists this as a
`must-not-change` constraint ("`BLOCKED` is large-finite, not Infinity") — which
tells you the team learned its value, probably after an early version that
conflated steep with disconnected.

Read next: `02-penalty-as-the-domain-seam.md` (where `BLOCKED` is returned),
`01-parametric-search-over-cost-fns.md` (where it's summed without a special
case).

## Interview defense

**Q: Why `1e9` and not `Infinity`? Isn't a magic number worse than a clean
sentinel?** Because `Infinity` would make over-max edges *untakeable*, which
collapses "flattest-but-steep" into "no route." The product promise is honesty:
show the least-bad route and *flag* the steep parts. A finite wall lets the
router climb it as a last resort; the flag (`steepEdges`) tells the user. The
"magic number" is documented at its definition (`cost.ts:4–5`) and is a
deliberate constant, not a stray literal.

```
  Infinity (wrong)              vs   1e9 finite (right)
  ┌────────────────────┐            ┌─────────────────────────┐
  │ steep edge = ∞      │            │ steep edge = 1e9         │
  │ → never taken       │            │ → taken if ONLY option   │
  │ → "no route" lie    │            │ → "flattest available"   │
  └────────────────────┘            └─────────────────────────┘
```

**Q: What's the load-bearing part people forget?** That `steepEdges` is a
*separate* mechanism from the cost. The cost math has no "too steep" branch at
all — `BLOCKED` flows through it as an ordinary number. The honesty lives in a
flag computed independently (`astar.ts:126`). Two concerns, two mechanisms, no
shared special case. That separation is why there's no error-handling code to
read in `search`.

**Anchor:** "`BLOCKED` is a tall but finite wall. Over-max edges are expensive,
not impossible — so 'flattest available' stays distinct from 'no route', which is
the only real error and returns `null`."

## Validate

1. **Reconstruct:** explain in pseudocode the three outcomes and which mechanism
   produces each (`null` vs `steepEdges`).
2. **Explain:** what user-visible bug appears if `BLOCKED` becomes `Infinity`?
   (`cost.ts:5`.)
3. **Apply:** what user-visible bug appears if `BLOCKED` is set to `100`
   instead of `1e9`, on a long flat route with one cheap steep shortcut?
4. **Defend:** a teammate wants `penalty` to throw `NoFlatRouteError` on an
   over-max edge. Walk them through everything that breaks (search gains a
   try/catch, "flattest available" disappears, the honesty flag is moot).

## See also

- `02-penalty-as-the-domain-seam.md` — where `BLOCKED` is returned.
- `01-parametric-search-over-cost-fns.md` — where it's summed without a branch.
- `audit.md` Lens 6 (errors — the cleanest decision), Lens 7 (the card branch).
