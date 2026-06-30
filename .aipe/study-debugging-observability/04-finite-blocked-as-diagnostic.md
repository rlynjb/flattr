# Finite BLOCKED as a diagnostic

**Industry names:** sentinel value · distinguishable failure states ·
soft-vs-hard constraint encoding. **Type:** Project-specific (the choice);
Language-agnostic (the idea).

## Zoom out, then zoom in

Two different "failures" can come out of the router, and a user needs them told
apart: *"there's no flat way there"* (but a steep way exists) versus *"there's no
way there at all"* (the points aren't connected). One number-encoding choice
keeps those distinct.

```
  Zoom out — where the distinction is encoded

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  RouteSummaryCard: "⚠ Flattest available" vs "No route…"    │ ← user reads it
  └─────────────────────────────┬───────────────────────────────┘
                                │  path vs null
  ┌─ Routing engine ────────────▼───────────────────────────────┐
  │  search() returns a PATH (steep flagged) or null            │
  └─────────────────────────────┬───────────────────────────────┘
                                │  cost from costFn
  ┌─ Cost layer (cost.ts) ──────▼───────────────────────────────┐
  │  BLOCKED = 1e9   ★ large-FINITE, not Infinity ★             │ ← the choice
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **sentinel chosen to keep two failure states
distinguishable.** A too-steep edge costs `BLOCKED = 1e9` — huge, so the router
avoids it if anything better exists, but *finite*, so if it's the only way the
router still returns that path and flags the steep segments. Only a genuinely
*disconnected* graph yields `null`. Make `BLOCKED = Infinity` instead and the two
states collapse: "only-steep" becomes indistinguishable from "no route," and you
can't tell the user the truth.

## Structure pass

**Layers.** Cost (the sentinel) → engine (path-or-null) → UI (three messages).

**Axis — trace "what does this layer say when there's no good route?":**

```
  One axis: how is "no good route" represented? — down the stack

  cost.ts   →  a NUMBER (1e9) — large but addable, comparable
  engine    →  a PATH with steepEdges flagged   OR   null
  UI        →  "⚠ Flattest available"           OR   "No route…"

  the representation stays FINITE until the very top, where it
  splits into two honest messages
```

**Seam.** The seam is the `penalty()` return at `cost.ts:18` — the single line
`if (g > max) return BLOCKED`. The axis flips there between "soft constraint"
(steep is *expensive*, finite) and what it would be if `BLOCKED` were `Infinity`
("steep is *impossible*, no route"). That one constant decides whether the system
can distinguish its two failure modes. It's the smallest, highest-leverage
diagnostic decision in the codebase.

## How it works

### Move 1 — the mental model

Think of `Infinity` and a large finite number in a min-cost search. `Infinity`
poisons the path — any route through it is infinitely bad, indistinguishable from
no route. A large finite number makes the route *very* bad but still *rankable* —
the search will pick it only if everything else is worse or absent.

```
  Pattern — two failure states kept apart by one constant

   search for cheapest path
            │
   ┌────────┴─────────┐
   │ is there a path  │── no ──► null ──────► "No route between those points"
   │ at all?          │                       (DISCONNECTED — hard failure)
   └────────┬─────────┘
            │ yes
   ┌────────▼─────────┐
   │ does it cross a  │── yes ─► path + steepEdges ─► "⚠ Flattest available"
   │ too-steep edge?  │         (cost includes 1e9)   (SOFT failure, honest)
   └────────┬─────────┘
            │ no
            ▼
        path, steepEdges=[] ──────────────► "Flat all the way"
```

The strategy in one sentence: **encode the soft constraint as an expensive-but-
finite cost so the search can still traverse it, reserving the unrepresentable
(`null`) for the hard constraint.**

### Move 2 — the walkthrough

**The constant and its comment.** One line carries the whole design.

```ts
// features/routing/cost.ts:5
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

The comment is the spec. `1e9` is large enough that any non-steep alternative
wins (real edge costs are meters — hundreds, maybe thousands), but it's an
ordinary number: it adds, compares, and accumulates. A path of three too-steep
edges costs `~3e9` — still finite, still rankable against another all-steep path
with fewer steep edges.

**The penalty function returns it on the soft-constraint branch.**

```ts
// features/routing/cost.ts:16-22
export function penalty(g: number, max: number, k1 = 0.4, k2 = 1.0): number {
  if (g <= 0) return 0;                 // downhill/flat — free
  if (g > max) return BLOCKED;          // ← over userMax: expensive, not impossible
  const half = 0.5 * max;
  if (g <= half) return k1 * g;         // moderate — linear
  return k2 * (g - half) ** 2 + k1 * half;  // steep-but-allowed — quadratic
}
```

`g > max` is the user's comfort ceiling. Crossing it returns `BLOCKED`, not
`Infinity` — so an edge over the ceiling is *penalized*, not *forbidden*. The
search routes around it if it can, through it if it must.

**The engine never special-cases BLOCKED — finiteness does the work for free.**
Look back at `search()` (`astar.ts:69`): the relaxation is a plain
`tentative < (g.get(next) ?? Infinity)` comparison. Because `BLOCKED` is finite,
a too-steep edge participates in that comparison normally — it just loses to
anything cheaper. `null` comes out only when the heap empties without reaching
the goal (`astar.ts:77`), which happens *only* when the graph is genuinely
disconnected. The two failure states are produced by completely different
mechanisms: steep = an expensive path found; disconnected = no path found. The
finiteness of `BLOCKED` is what keeps those mechanisms separate.

**Honesty is carried, not inferred.** When the search returns an only-steep path,
`summarizePath` flags exactly which edges blew the ceiling:

```ts
// features/routing/astar.ts:126-128
if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
  steepEdges.push(edge.id);          // ← the honesty payload
}
```

So the path carries its own indictment: `steepEdges` is the list of segments the
user should know about. That's the diagnostic data the UI reads.

**The UI reads the distinction as three states.**

```tsx
// mobile/src/RouteSummaryCard.tsx:18-32 (abridged)
if (!found) return <Text>No route between those points.</Text>;   // null → DISCONNECTED
const clean = summary.steepCount === 0;
return <Text>{clean ? "Flat all the way" : "⚠ Flattest available"}</Text>;
//                     steepEdges=[] → clean    steepEdges≠[] → SOFT failure, honest
```

```
  Layers-and-hops — one constant decides three messages

  ┌─ cost.ts ───┐ BLOCKED=1e9    ┌─ search() ────────────┐
  │ penalty()   │ (finite)       │ path? steepEdges?      │
  └─────────────┘ ─────────────► │ or null                │
                                 └──────────┬─────────────┘
                              path+steep │  path+clean │  null
                                         ▼             ▼         ▼
                          "⚠ Flattest available"  "Flat all  "No route
                          (honest soft failure)    the way"   between…"
```

### Move 2 variant — the load-bearing skeleton

The kernel: **a sentinel large enough to lose to any real alternative, finite
enough to remain in the cost algebra, with `null` reserved for the truly
unrepresentable.** Three parts.

- Make the sentinel **`Infinity`** and the soft failure collapses into the hard
  failure — "only-steep" becomes "no route," the user is told something false,
  and `steepEdges` never gets a chance to be computed because no path returns.
  This is the part the spec explicitly protects (§14.4, must-not-change
  constraint): *"BLOCKED is large-finite, not Infinity."*
- Make the sentinel **too small** (say `1e3`, comparable to real path lengths)
  and the search might prefer a long flat detour's *real* cost over a short
  steep edge's penalty in the wrong cases — the sentinel must dominate genuine
  costs to mean "avoid unless forced."
- Drop the **`null`-for-disconnected** reservation (e.g. return an empty path)
  and you lose the hard-failure signal entirely. `null` has to mean exactly one
  thing: no path exists.

Optional hardening: the `steepEdges` payload (`astar.ts:126`) — you could detect
soft failure just from `cost > BLOCKED`, but flagging *which* edges is better
diagnostics. The skeleton is the finite sentinel + the `null` reservation;
edge-level flagging is the honesty upgrade on top.

### Move 3 — the principle

**Choose your sentinel so failure states stay distinguishable.** The instinct is
to use `Infinity` for "forbidden" — it reads as "impossible." But `Infinity`
*erases information*: it makes every forbidden-but-traversable state look
identical to a genuinely-impossible one. A large finite sentinel keeps the soft
constraint *inside* the cost algebra, where the search can still reason about it,
and reserves the truly unrepresentable result (`null`) for the one state that
genuinely has no answer. The generalizable rule: when two failures need different
responses, encode them so they *can't* collapse into each other — the encoding is
the diagnostic.

## Primary diagram

The full picture — one constant, two production mechanisms, three honest messages.

```
  Finite BLOCKED — the full distinction

  ┌─ cost.ts:5 ────────────────────────────────────────────────┐
  │  BLOCKED = 1e9   (large-finite, NOT Infinity)              │
  │  penalty: g > max → BLOCKED   (soft ceiling, traversable)  │
  └────────────────────────────┬───────────────────────────────┘
                               │ finite → stays in the cost algebra
  ┌─ search() (astar.ts) ──────▼───────────────────────────────┐
  │  path found?                                               │
  │    yes + steepEdges=[]  → "Flat all the way"               │
  │    yes + steepEdges≠[]  → "⚠ Flattest available" (+ flags) │  ← SOFT
  │    no  (heap emptied)   → null                             │  ← HARD
  └────────────────────────────┬───────────────────────────────┘
                               ▼
  ┌─ RouteSummaryCard.tsx ─────────────────────────────────────┐
  │  null → "No route between those points."  (disconnected)   │
  └────────────────────────────────────────────────────────────┘

  guarded by astar.test.ts:91 — null ONLY when genuinely disconnected
```

## Elaborate

This is the sentinel-value pattern with a diagnostic twist: the *choice* of
sentinel determines what your system can tell its users about its own failures.
Using a large finite number instead of `Infinity` to mean "soft-forbidden" is a
known trick in constraint-based routing — it turns a hard constraint into a heavy
soft one, so the solver degrades gracefully (return the least-bad path) instead
of failing hard. flattr makes it a *product* feature: the difference between "no
flat way" and "no way" is exactly the difference between a yellow warning card and
a red error card.

The regression guard is `astar.test.ts:91` — "returns null only when genuinely
disconnected, not when merely steep" — which is the executable version of the
must-not-change constraint. This connects to `03-`: both are "stay honest about
failure" mechanisms. `03-` keeps grade *provenance* honest (degraded vs real);
this keeps grade *feasibility* honest (steep vs disconnected). The disconnected
case is also where the "no route between those points" bug lived — see `audit.md`
lens 7 — fixed by corridor loading so disconnection is real, not an artifact of
viewport-only tiling.

## Interview defense

**Q: A user asks for a flat route up a hill with no flat option. What does your
router return, and how does that differ from two truly disconnected points?**

It returns the steep path with the offending edges flagged — because `BLOCKED` is
`1e9`, a large finite number, the steep edge stays in the cost algebra and the
search still traverses it when it's the only option (`cost.ts:5`). Disconnected
points return `null`, because the heap empties without reaching the goal. Two
different mechanisms, two different UI states: "⚠ Flattest available" vs "No
route between those points."

```
  steep-only → path + steepEdges → yellow card  (BLOCKED finite)
  disconnected → null            → red card     (heap emptied)
```

Anchor: *finite `BLOCKED` keeps "no flat way" and "no way" as two distinguishable
states. `Infinity` would collapse them into one lie.*

**Q: Why not just use `Infinity` for a too-steep edge?**

Because `Infinity` erases the distinction I just described. With `Infinity`, an
only-steep route costs `Infinity` — identical to no route — so the search returns
`null` and I'd tell the user "no route" when a steep one exists. Large-finite
keeps the steep path returnable *and* flaggable. It's a must-not-change constraint
in the spec for exactly this reason, guarded by a test (`astar.test.ts:91`).

Anchor: *`Infinity` is unrepresentable and poisons the path; `1e9` is bad-but-
rankable. The whole product distinction rides on that one constant.*

## See also

- `03-degrade-and-surface.md` — the other "stay honest about failure"
  mechanism (provenance, not feasibility).
- `02-optimality-oracle.md` — the correctness guard alongside this honesty guard.
- `audit.md` lens 6 (debugging boundaries) and lens 7 (the "no route" incident).
- Neighbor guide `study-dsa-foundations` (BFS-for-reachability, the diagnostic
  probe behind the "no route" fix).
