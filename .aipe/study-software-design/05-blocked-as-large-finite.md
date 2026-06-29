# BLOCKED as large-finite

> **Sentinel-as-large-finite / defining the special case out of existence**
> — Project-specific application of an APOSD move.

## Zoom out, then zoom in

When an edge is too steep for the rider, what cost do you give it? The
obvious answer — `Infinity` — is wrong, and the reason it's wrong is the
whole insight of this file. flattr uses `BLOCKED = 1e9`: large enough that
the router avoids steep edges whenever any alternative exists, but *finite*
so that when a steep edge is the **only** way through, the route still comes
back — flagged as steep, not silently dropped.

```
  Zoom out — where BLOCKED lives and what it preserves

  ┌─ cost.ts ──────────────────────────────────────────┐
  │  penalty(g, max): if (g > max) return BLOCKED;      │ ← we are here (=1e9)
  └──────────────────────┬──────────────────────────────┘
                         │ a finite, huge number (not Infinity)
  ┌─ search() ───────────▼──────────────────────────────┐
  │  steep edge = very expensive edge, not a dead end    │
  │  still relaxable → still part of a returnable path   │
  └──────────────────────┬──────────────────────────────┘
                         │ Path { steepEdges: [...] }
  ┌─ UI ─────────────────▼──────────────────────────────┐
  │  "steep but it's your only option" (honest)          │
  │  vs  "no route" (genuinely disconnected)             │
  └─────────────────────────────────────────────────────┘
```

Zoom in: this is APOSD's **"define the special case out of existence."** A
naive design needs a branch: "if all edges are too steep, do X." flattr has
no such branch. A too-steep edge is just an expensive edge; the search loop
treats it identically to any other. One constant erases an entire class of
special-case handling — and keeps two genuinely different failures distinct.

## Structure pass

**Layers.** The constant, the loop, the honesty flag:
- *The constant*: `BLOCKED = 1e9` (`cost.ts:5`).
- *The loop*: `search()` relaxes it like any cost.
- *The honesty layer*: `steepEdges` in the returned `Path` (`astar.ts:126`).

**Axis — "what does 'unroutable' mean?"** Two distinct failures that a
careless design collapses into one:

```
  axis = "why is there no good route?"

  ┌─ disconnected graph ──────┐   genuinely no path → search returns null
  │  start/goal not connected │   (open empties, path: null — astar.ts:77)
  └────────────────────────────┘
                  ║  these MUST stay distinct
  ┌─ only-steep path ─────────┐   a path exists, all steep → returns the path
  │  connected but all > max  │   with steepEdges flagged (honest)
  └────────────────────────────┘

  Infinity collapses these into one; 1e9 keeps them apart
```

**Seam.** The boundary is the choice of sentinel value. With `Infinity`, a
too-steep edge can never be relaxed (`tentative < g` is always false against a
finite incumbent, and any path through it has infinite cost), so an
all-steep-but-connected graph returns `null` — *identical* to a disconnected
graph. With `1e9`, the steep path has a huge but finite cost, gets relaxed,
and returns. The two failure modes flip apart exactly at this constant.

## How it works

### Move 1 — the mental model

You know the difference between `null` (no value) and `NaN` or a sentinel like
`-1` (a value that means "special") — and you know that `array.indexOf`
returning `-1` is more useful than throwing, because `-1` is still a number
you can compare and branch on later. `BLOCKED` is that move for cost: instead
of "this edge has no usable cost" (Infinity → unrelaxable), it's "this edge
has an enormous but real cost" — still a number the search can work with.

```
  the pattern — sentinel that stays in the number line

  cost spectrum:
    0 ──── flat ──── moderate ──── steep ──── BLOCKED(1e9) ┊ Infinity
                                              └─ still routable ─┘ └ unrelaxable
    "avoid if you can"  ◄──────────────────────┘
    "but take if you must" ─────────────────────┘
```

In one sentence: **make the forbidden case prohibitively expensive but still
representable, so the system degrades to honesty instead of a dead end.**

### Move 2 — the step-by-step walkthrough

#### One constant, with the rationale in the comment

```ts
// cost.ts:4-5 — the whole pattern in two lines
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

The comment is doing real work — it carries the *why* that the value `1e9`
can't (pattern: comments explain what code can't, `audit.md` Lens 7). A reader
who "cleans up" `BLOCKED` to `Infinity` would break the only-steep case
silently; the comment is the guard rail. **What breaks if it's `Infinity`?**
`penalty` returns `Infinity`, so `gradeCostDirected` returns `Infinity`, so in
the relaxation `tentative = g.get(current) + Infinity` is `Infinity`, which is
never `< (g.get(next) ?? Infinity)` in a useful way — the steep neighbor never
gets a usable cost, and a connected-but-all-steep graph returns `null`,
indistinguishable from disconnected.

#### The search loop has no special case for steepness

```ts
// astar.ts:68-72 — relaxation, no steepness branch anywhere
const tentative = g.get(current)! + costFn(edge, current, userMax);
if (tentative < (g.get(next) ?? Infinity)) {   // 1e9 is finite → comparable
  g.set(next, tentative);
  open.push(next, tentative + heuristicFn(...));
}
```

There is no `if (edge too steep) skip`. The steep edge flows through the exact
same relaxation as a flat one — its cost is just ~1e9 larger, so the router
picks it *only* when every alternative is even more expensive (i.e., there is
no alternative). **What breaks if you added a "skip steep edges" branch
instead?** You'd reintroduce the special case the sentinel eliminated — and
you'd lose the only-steep route entirely, because skipping all its edges
disconnects the graph in the search's eyes.

#### The honesty layer flags what BLOCKED let through

```ts
// astar.ts:124-129 — summarizePath flags steep edges it routed over
cost += costFn(edge, from, userMax);          // includes the ~1e9 if steep
lengthM += edge.lengthM;
if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
  steepEdges.push(edge.id);                   // ← tell the user the truth
}
```

This is the other half of the contract. Because BLOCKED let the steep route
*through*, the system owes the user honesty about it. `steepEdges` collects
every edge that exceeded `userMax`, and the UI shows "this route includes
steep sections" rather than pretending the route is flat. **What breaks
without this flag?** The router would return a steep route as if it were
fine — worse than returning nothing, because it's misleading.

```
  execution trace — connected, all edges steep, userMax=8

  edges: A→B (grade 12%), B→goal (grade 10%)   both > 8 → BLOCKED applies
  ─────────────────────────────────────────────────────────────
  relax A→B:  tentative = 0 + len·(1+1e9) ≈ 1e9·len   FINITE → accepted
  relax B→goal: tentative ≈ 2e9·len                    FINITE → accepted
  pop goal:   reconstruct → Path{ cost≈huge,
                                  steepEdges:[A→B, B→goal] }  ← returned, flagged

  with Infinity: tentative = Infinity → path: null  (looks disconnected ✗)
```

### Move 3 — the principle

The right sentinel keeps the special case inside the normal machinery. By
making "forbidden" a large finite cost rather than infinity, flattr deletes
the branch that would handle "all routes are steep" *and* preserves the
distinction between "steep" and "impossible." The general lesson: **when you
reach for a sentinel, ask whether it should stay inside the value's domain.**
`Infinity` leaves the number line; `1e9` stays on it, and staying on it is
what lets the system degrade gracefully instead of failing.

## Primary diagram

The full move: one finite constant, no special-case branch, an honesty flag,
two failure modes kept distinct.

```
  BLOCKED as large-finite — complete

  ┌─ cost.ts ──────────────────────────────────────────────────┐
  │  penalty: g > max → BLOCKED (1e9, FINITE)                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ huge but comparable cost
  ┌─ search() — NO steepness branch ───────────────────────────┐
  │  relax steep edge exactly like any edge                    │
  │     connected + all steep → finite path FOUND              │
  │     truly disconnected    → open empties → path: null      │
  └───────────────────────────┬─────────────────────────────────┘
              ┌───────────────┴────────────────┐
   ┌─ Path (only-steep) ─────┐       ┌─ null (disconnected) ──┐
   │ cost huge,              │       │ no path at all         │
   │ steepEdges: [...] ◄──── │       └────────────────────────┘
   │ "steep but your only    │
   │  option" (honest)       │
   └─────────────────────────┘
```

## Elaborate

This is APOSD's "define errors / special cases out of existence" plus a
deliberate sentinel choice. The `project context` lists it as a must-not-
change constraint precisely because it's subtle and easy to "simplify"
wrong. It's the cleanest error-handling move in the repo — instead of
try/catch or a skip-branch, a single constant makes the hard case fall
through the normal path.

It depends on pattern `02` (the penalty function that returns it) and is
consumed by pattern `01` (the search loop that relaxes it). It also interacts
with admissibility: because `BLOCKED` is finite and positive, the penalty
stays `≥ 0` and A\*'s heuristic stays a valid lower bound — `Infinity` would
technically also stay `≥ 0`, but it would break relaxation, which is the
practical failure. For the error-handling philosophy, read the matching
`read-aposd` chapter.

## Interview defense

**Q: "Why `1e9` instead of `Infinity`? `Infinity` is the honest 'don't go
here' value, and `1e9` looks like a magic number that could be exceeded by a
long enough route."**

`Infinity` collapses two failures I need to keep apart. If a steep edge costs
`Infinity`, then a graph that's connected but entirely too-steep returns the
same `null` as a graph that's genuinely disconnected — and the product's whole
point is to say "this is steep, but it's your only way" instead of silently
"no route." `1e9` makes steep edges prohibitively expensive (the router takes
them only when there's no alternative) while keeping the cost finite and
comparable, so the path still reconstructs and I flag it via `steepEdges`. On
the magic-number worry: real pedestrian routes are well under a million
meters, and even at extreme lengths the penalty multiplier would have to stack
absurdly to approach 1e9 per edge — the headroom is enormous, and the comment
at `cost.ts:4` documents the intent.

```
  Infinity                       1e9 (BLOCKED)
  ┌────────────────────┐         ┌────────────────────────┐
  │ all-steep → null   │ same    │ all-steep → path+flag   │ distinct
  │ disconnected→ null │ as ✗    │ disconnected → null     │ from each other ✓
  └────────────────────┘         └────────────────────────┘
```

*Anchor: large-finite keeps "steep but routable" distinct from "no route";
Infinity collapses them.*

**Q: "What does this buy you in the search loop's complexity?"**

It deletes the special case. There's no "if every edge is too steep" branch
anywhere — a steep edge is just an expensive edge, relaxed by the same line
as a flat one (`astar.ts:68`). That's the APOSD move: instead of *handling*
the special case, choose a representation where it isn't special. The honesty
flag (`steepEdges`, `astar.ts:126`) is the small price — having let the steep
route through, I owe the user the truth about it.

*Anchor: the sentinel choice removes a special-case branch from the search
loop entirely; steepness becomes "expensive," not "forbidden."*

## See also

- `02-penalty-as-the-domain-seam.md` — where BLOCKED is returned.
- `01-parametric-search-over-cost-fns.md` — the loop that relaxes it.
- `audit.md` Lens 6 (errors/special cases defined out of existence).
- `read-aposd` — "define errors out of existence" chapter.
