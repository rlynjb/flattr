# The route honesty signal

> **Industry names:** sentinel value / graceful-degradation signal /
> domain-level observability / health signal. **Type:**
> Project-specific (the `BLOCKED`-finite trick is flattr's; the
> three-state health card is a general pattern).

---

## Zoom out, then zoom in

You've rendered a `fetch()` with three states: loading, data, error.
The user always knows where they stand. The route honesty signal is the
same three-state discipline, but the states encode *domain truth* about
route quality: "flat all the way," "flattest available but it has steep
blocks," and "no route at all." It's observability of the product's core
promise — "optimized for flat, not fast" — surfaced to the person who
cares most: the user.

Here's the chain that produces it.

```
  Zoom out — where the honesty signal lives

  ┌─ Cost layer ────────────────────────────────────────────────┐
  │  features/routing/cost.ts                                    │
  │    BLOCKED = 1e9  (large but FINITE)  ★ THE TRICK ★          │
  └────────────────────────────┬─────────────────────────────────┘
                               │ feeds the search
  ┌─ Search layer ─────────────▼─────────────────────────────────┐
  │  features/routing/astar.ts                                   │
  │    path.steepEdges = edges over userMax  (honesty flags)     │
  │    path = null  ONLY when truly disconnected                 │
  └────────────────────────────┬─────────────────────────────────┘
                               │ Path | null
  ┌─ Summary layer ────────────▼─────────────────────────────────┐
  │  features/routing/summary.ts → {distanceM, climbM, steepCount}│
  └────────────────────────────┬─────────────────────────────────┘
                               │ RouteSummary
  ┌─ UI layer (Expo) ──────────▼─────────────────────────────────┐
  │  mobile/src/RouteSummaryCard.tsx                             │
  │    clean / ⚠ flattest / "No route"  ← THE SIGNAL THE USER SEES│ ← here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **sentinel value that preserves a
distinction.** The naïve way to say "this edge is too steep to use" is
to give it infinite cost — then the search can't traverse it, and a
too-steep-only route comes back as "no route." But that *collapses two
different truths*: "the only route is steep" and "there's genuinely no
path" both become `null`. flattr refuses to collapse them: `BLOCKED` is
`1e9`, large enough to avoid steep edges when any alternative exists, but
*finite* so a steep-only route is still found and flagged. The whole
honesty signal hangs off that one design choice.

---

## Structure pass

Four layers, one axis, one critical seam.

**Layers:** cost → search → summary → UI (the diagram above).

**Axis — "what does 'too steep' mean to this layer?"** Trace it up:

```
  One axis: "what does 'too steep' mean here?" — traced UP the stack

  ┌─ UI ──────────────────────────────────────────┐
  │ "⚠ Flattest available, 2 steep blocks"        │ → a WARNING (usable)
  └────────────────────────────────────────────────┘
      ┌─ summary ───────────────────────────────────┐
      │ steepCount = 2                              │ → a COUNT
      └──────────────────────────────────────────────┘
          ┌─ search ────────────────────────────────┐
          │ steepEdges = ["e7","e9"]; path NOT null │ → FLAGGED, kept
          └──────────────────────────────────────────┘
              ┌─ cost ──────────────────────────────┐
              │ penalty → BLOCKED (1e9, FINITE)     │ → EXPENSIVE, not ∞
              └──────────────────────────────────────┘

  "too steep" means EXPENSIVE at the bottom and a WARNING at the top —
  never "impossible." that meaning is preserved up every layer.
```

**The seam:** the choice of `1e9` over `Infinity` in `cost.ts:5`. That
single line is where "too steep ≠ impossible" is decided. Below it, the
search treats steep edges as merely costly and will use one if it must;
above it, every layer can distinguish "steep" from "no route." Flip that
one constant to `Infinity` and the axis-answer at every higher layer
silently changes from "warning" to "no route" — the honesty collapses.
That's a load-bearing seam in one number.

---

## How it works

### Move 1 — the mental model

The shape is a **sentinel that ranks below "real" but above
"impossible."** You've used `-1` for "not found" in an index lookup
instead of throwing — same family: a reserved value that means something
specific without breaking the type. Here the reserved value is a *huge
finite cost* that means "avoid unless there's no choice."

```
  Pattern — the three-tier cost ladder

  cost of using an edge:
    flat / downhill ──────────── 0 penalty      ← always fine
    moderate uphill ──────────── linear penalty  ← mildly avoided
    steep uphill (under max) ──── quadratic       ← strongly avoided
    over userMax ─────────────── BLOCKED (1e9)   ← avoided unless ONLY option
    ────────────────────────────────────────────
    truly no edge ────────────── (no path) null  ← genuinely impossible

  the gap between 1e9 and ∞ is the entire honesty signal:
  finite → "I'll use it and TELL you"; ∞ → "I pretend it's not there"
```

The continuous penalty curve (0 → linear → quadratic → BLOCKED) means
the search smoothly prefers flatter routes, and only hits the sentinel
when an edge genuinely exceeds the user's limit. The sentinel is the top
rung of a ladder, not a wall.

### Move 2 — the step-by-step walkthrough

#### The finite sentinel — `BLOCKED = 1e9`

The naïve approach is `Infinity` for over-limit edges. The cost: a
steep-only route comes back identical to a disconnected one. flattr uses
a large *finite* number instead.

```
  Comparison — Infinity vs finite sentinel

  route exists but every option is steep:

  with cost = ∞:          with cost = 1e9:
    every path = ∞           best path = (sum of 1e9s) < ∞
    search finds no min      search finds a min → returns it
    → path = null            → path returned, steepEdges flagged
    → "No route"  (LIE)      → "⚠ Flattest available"  (TRUE)
```

The boundary: `1e9` must be large enough that the search prefers *any*
non-steep alternative (so a single flat detour always beats a steep
shortcut), but finite so summing a few of them stays below `Infinity`
and a min still exists. Pick it too small and steep edges leak into
clean routes; pick `Infinity` and you lose the distinction entirely.

#### Flagging, not hiding — `steepEdges`

The search doesn't just cost steep edges highly; it *records* which ones
it was forced to use. As it builds the path, any edge whose directed
grade exceeds `userMax` gets pushed onto `steepEdges`.

```
  Pattern — flag-as-you-build

  for each edge in the chosen path:
      add edge to path
      if directedGrade(edge) > userMax:   ← only when userMax is finite
          steepEdges.push(edge.id)        ← the honesty record

  result: the path you'd draw anyway, PLUS a list of "I'm not proud
  of these" edges — the evidence behind the ⚠ warning
```

Critical detail: the flag uses the **directed** grade (signed by travel
direction), not absolute steepness. Going *down* a 12% block is fine;
going *up* it is not. So `steepEdges` reflects the actual climb the user
faces, not the block's geometry. Strip the directed check and you'd warn
about descents — false positives that erode trust in the warning.

#### Totalling for the human — `routeSummary`

The UI doesn't want edge IDs; it wants three numbers. `routeSummary`
walks the path and produces distance, climb, and steep-count.

```
  Layers-and-hops — path to summary to card

  ┌─ Path (engine) ─┐  hop 1: routeSummary(graph, path)  ┌─ summary ──┐
  │ nodes, edges,   │ ─────────────────────────────────► │ sum length │
  │ steepEdges      │                                     │ sum UPHILL │
  └─────────────────┘                                     │ count steep│
                                                          └─────┬───────┘
                              hop 2: {distanceM, climbM, steepCount}
                                                                ▼
                                                ┌─ RouteSummaryCard ──┐
                                                │ pick 1 of 3 states  │
                                                └─────────────────────┘
```

`climbM` sums only *positive directed rise* — the actual uphill meters
in the travel direction; a descent contributes nothing. So "+120 m
climb" is the real work the user does, the metric they actually feel.

#### Three states, never two — `RouteSummaryCard`

The card maps the engine's truth onto three mutually exclusive visual
states. The order of the checks is the logic.

```
  State machine — the card's three states

         routed.found == false ──────────► ┌─ RED ─────────────┐
                                            │ "No route between │
                                            │  those points."   │
                                            └───────────────────┘
         found && steepCount == 0 ────────► ┌─ GREEN ───────────┐
                                            │ "Flat all the way"│
                                            └───────────────────┘
         found && steepCount > 0 ─────────► ┌─ YELLOW ──────────┐
                                            │ "⚠ Flattest avail"│
                                            │  N steep blocks   │
                                            └───────────────────┘
```

The boundary that makes this honest: GREEN requires `steepCount === 0`
*exactly*. The card never says "flat" when even one block is steep — it
downgrades to yellow and names the count. That's the product promise
("optimized for flat") being held accountable by its own UI.

### Move 2 variant — the load-bearing skeleton

The honesty signal's kernel, by what-breaks-if-removed:

1. **A finite over-limit sentinel** (`BLOCKED = 1e9`). *Remove the
   finiteness — use `Infinity` — and steep-only routes report as "no
   route." The single most load-bearing line.*
2. **A per-edge flag recorded on the path** (`steepEdges`). *Remove it
   and the search still avoids steep edges, but can no longer tell you
   it had to use one — the warning has no data.*
3. **A directed (not absolute) steepness check.** *Use absolute grade
   and you flag descents — false warnings that train users to ignore
   the ⚠.*
4. **A UI that distinguishes three states, with GREEN gated on
   zero-steep.** *Collapse to two states (route / no-route) and the
   "flattest-but-imperfect" truth vanishes from the screen.*

Optional hardening: the continuous penalty curve (smooth preference
between flat alternatives), the `climbM` "uphill only" refinement. The
four parts above are what make it *honest*; the curve makes it *good*.

### Move 3 — the principle

When a system has to degrade, encode the degradation as a *distinct,
finite signal* rather than collapsing it into the failure case. "No
route" and "imperfect route" are different truths; a sentinel that ranks
below real options but above impossible keeps them separate all the way
to the user. The cheapest dishonesty in a routing system is calling a
hard route "no route" — flattr spends one design decision (`1e9` over
`∞`) to never do that.

---

## Primary diagram

The full honesty signal, sentinel to screen.

```
  Route honesty signal — complete chain

  ┌─ Cost layer: features/routing/cost.ts ─────────────────────────┐
  │  BLOCKED = 1e9                            ← FINITE sentinel     │
  │  penalty(g, max): g≤0→0 | g≤max→curve | g>max→BLOCKED          │
  └────────────────────────────┬───────────────────────────────────┘
                               │ cost per edge
  ┌─ Search layer: features/routing/astar.ts (summarizePath) ──────▼┐
  │  for edge in path:                                             │
  │    cost += costFn(edge); lengthM += edge.lengthM               │
  │    if finite(userMax) && directedGrade(edge) > userMax:        │
  │        steepEdges.push(edge.id)           ← HONESTY FLAGS       │
  │  → Path{nodes,edges,cost,lengthM,steepEdges}  (null iff DISC.) │
  └────────────────────────────┬───────────────────────────────────┘
                               │ Path | null
  ┌─ Summary layer: features/routing/summary.ts ───────────────────▼┐
  │  climbM = Σ positive directed rise   (uphill only)             │
  │  → {distanceM: lengthM, climbM, steepCount: steepEdges.length} │
  └────────────────────────────┬───────────────────────────────────┘
                               │ RouteSummary
  ┌─ UI layer: mobile/src/RouteSummaryCard.tsx ────────────────────▼┐
  │  !found            → RED   "No route between those points."    │
  │  steepCount === 0  → GREEN "Flat all the way" · km · +climb m  │
  │  steepCount > 0    → YELLOW"⚠ Flattest available" · N steep    │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

This signal fires on **every routed trip** in the app — it's not a
debug-only surface, it's the primary product output. Three concrete
triggers:

- **A clean flat route exists** → GREEN card, "Flat all the way." The
  user trusts the route is fully under their grade limit.
- **The destination is up a hill no flat road avoids** → YELLOW,
  "⚠ Flattest available, 2 steep blocks." The product is honest: this is
  the best it can do, here's exactly how much steepness you're signing up
  for. This is the case that justifies the whole `BLOCKED`-finite design.
- **The points are in disconnected graph components** (e.g. across an
  un-bridged gap) → RED, "No route." Genuinely impossible, said plainly.

The same `steepEdges` data also drives route *coloring* on the map
(`routeToGeoJSON`, referenced from `MapScreen.tsx:150`), so the steep
blocks are visible on the line, not just counted on the card.

### Code, line by line

**The finite sentinel** — `features/routing/cost.ts:5, 16-22`:

```
  features/routing/cost.ts  (lines 5, 16-22)

  export const BLOCKED = 1e9;          ← 5  large but FINITE ★

  export function penalty(g, max, k1, k2) {
    if (g <= 0) return 0;              ← 18  downhill/flat: no penalty
    if (g > max) return BLOCKED;       ← 19  OVER LIMIT → sentinel (not ∞)
    const half = 0.5 * max;            ← 20
    if (g <= half) return k1 * g;      ← 21  moderate: linear
    return k2*(g-half)**2 + k1*half;   ← 22  steep: quadratic, continuous
  }
       │
       └─ line 5 is THE load-bearing decision. with Infinity, a route
          made only of g>max edges sums to Infinity → no minimum exists →
          search returns null → "No route" for a route that EXISTS.
          1e9 keeps the minimum finite → the route is found and flagged.
```

**The honesty flag, directed** — `features/routing/astar.ts:120-130`:

```
  features/routing/astar.ts  (summarizePath, lines 120-130)

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const from = nodes[i];
    cost += costFn(edge, from, userMax);          ← 123 cost (uses BLOCKED)
    lengthM += edge.lengthM;                      ← 124 real distance
    if (Number.isFinite(userMax) &&
        directedGrade(edge, from) > userMax) {    ← 126 DIRECTED check
      steepEdges.push(edge.id);                   ← 127 record the flag
    }
  }
  return { nodes, edges, cost, lengthM, steepEdges };← 130
       │
       └─ line 126 uses directedGrade (signed by travel direction): a
          12% block traversed DOWNHILL is not flagged. and the
          Number.isFinite(userMax) guard means distance-mode searches
          (userMax = Infinity, from dijkstra/astar) flag nothing — steep
          only means something when the user set a limit.
```

**Climb = uphill only** — `features/routing/summary.ts:11-20`:

```
  features/routing/summary.ts  (lines 11-20)

  export function routeSummary(graph, path, _userMax) {
    let climbM = 0;
    for (let i = 0; i < path.edges.length; i++) {
      const edge = edgeById(graph, path.edges[i]);
      const fromNode = path.nodes[i];
      const directedRise = fromNode === edge.fromNode  ← 16 orient the rise
        ? edge.riseM : -edge.riseM;                    ←    to travel dir
      if (directedRise > 0) climbM += directedRise;    ← 18 UPHILL ONLY
    }
    return { distanceM: path.lengthM, climbM,
             steepCount: path.steepEdges.length };     ← 19 steepCount
  }
       │
       └─ line 16 flips riseM's sign when traversing the edge backward
          (riseM is stored from->to). line 18 counts only positive rise —
          so "+120 m climb" is the meters you actually go UP, the metric
          the user feels. descents are free, not negative climb.
```

**The three-state card** — `mobile/src/RouteSummaryCard.tsx:15-41`:

```
  mobile/src/RouteSummaryCard.tsx  (lines 15-41)

  if (!found || !summary) {
    if (found) return null;          ← 16  no endpoints yet → show nothing
    return <View ...styles.bad>       ← 18  RED state…
      <Text>No route between those points.</Text>  ← 19
    </View>;
  }
  const clean = summary.steepCount === 0;          ← 26  GREEN gate ★
  return (
    <View ...{clean ? styles.ok : styles.warn}>     ← 29  green vs yellow
      <Text>{clean ? "Flat all the way"
                   : "⚠ Flattest available"}</Text>← 30
      {!clean && <Text>{summary.steepCount} steep   ← 31-35 the count,
        block(s) (>{userMax}%)</Text>}                       only if dirty
      <Text>{km} km · +{climb} m climb</Text>       ← 37-38
    </View>
  );
       │
       └─ line 16's `if (found) return null` is the fourth state:
          "no endpoints picked yet" renders nothing (not an error).
          line 26 gates GREEN on steepCount===0 EXACTLY — one steep
          block downgrades to yellow. the card refuses to say "flat"
          when it isn't. THAT is the honesty.
```

### How the oracle guards it

`02-optimality-oracle.md`'s tests pin this signal too:
`astar.test.ts:82-89` asserts a steep-only graph still returns a path
*and* flags the steep edge (`steepEdges == ["xy"]`), and `:91-96`
asserts `null` comes back *only* when genuinely disconnected. Those two
tests are the regression guard on the `BLOCKED`-finite decision — break
the sentinel and they go red.

---

## Elaborate

`BLOCKED = 1e9` is a **sentinel value**, the same family as `-1` for
"not found," `NaN` for "no measurement," or HTTP `0` for "network never
reached." The art is choosing a value that's *unambiguous within the
domain* — here, larger than any sum of real edge costs you'd
legitimately traverse, but small enough that summing a handful stays
finite. That's why it's `1e9` and not, say, `Number.MAX_SAFE_INTEGER`:
you want headroom to *add* several without overflowing into `Infinity`,
which would resurrect the exact bug you were avoiding.

The deeper idea is **graceful degradation as an observable signal**. A
lot of systems degrade silently — they fall back and say nothing (see
`04-degrade-and-surface.md` for flattr's *silent* degradation, the
elevation fallback, which is the anti-pattern this file's signal avoids).
The honesty card is the opposite: degradation (a steep block) is
surfaced as a first-class, named state, not hidden. The product's whole
trust proposition depends on it — a flat-routing app that quietly routed
you up a hill and called it flat would be worse than useless.

What to read next: `02-optimality-oracle.md` (the tests that pin the
sentinel), and `04-degrade-and-surface.md` for the contrasting case where
flattr degrades *without* a signal (and the audit flags it, RF-1).

---

## Interview defense

**Q: Why `BLOCKED = 1e9` instead of `Infinity`? Infinity is the obvious
"don't go here."**

Because `Infinity` collapses two different truths into one. A route made
only of too-steep edges would sum to `Infinity`, the search finds no
minimum, returns `null`, and the UI says "no route" — for a route that
physically exists. A large *finite* sentinel keeps a minimum, so the
steep-only route is found and flagged as "flattest available." The gap
between `1e9` and `∞` is the entire honesty signal.

```
  ∞  → steep-only route = no minimum = null = "no route"  (LIE)
  1e9 → steep-only route = finite minimum = found+flagged  (TRUE)
```

Anchor: *the difference between "no route" and "best-effort route" is
the difference between Infinity and a large finite number.*

**Q: Why flag steepness with the *directed* grade, not the block's
actual steepness?**

Because the user only climbs in one direction. A 12% block is brutal
uphill and free downhill — flagging it on the descent would be a false
warning, and false warnings train people to ignore the real ones. The
flag uses `directedGrade` (signed by travel direction), and `climbM`
counts only positive directed rise.

```
  same 12% block:   ──uphill──►  flagged ⚠
                    ◄─downhill─   not flagged (free)
```

Anchor: *honesty means flagging the climb the user actually faces, not
the geometry of the block.*

**Q: Where's the single line this whole feature lives or dies on?**

`cost.ts:5`, `BLOCKED = 1e9`. Change it to `Infinity` and every layer
above silently reinterprets "steep route" as "no route" — the card goes
red instead of yellow, and the product lies. It's one constant carrying
the entire distinction, which is why `astar.test.ts:82-96` guards it
explicitly.

Anchor: *one constant (`1e9` not `∞`) is the seam where "too steep ≠
impossible" is decided.*

---

## Validate

**Reconstruct.** Draw the three-tier cost ladder (flat → moderate →
steep → BLOCKED → null) and the card's three states. Mark which single
value (`file:line`) keeps the BLOCKED rung distinct from the null rung.

**Explain.** Why does `astar.ts:126` gate the steep flag on
`Number.isFinite(userMax)`? What happens to `steepEdges` when a plain
`dijkstra` (userMax = Infinity) runs, and why is that correct?

**Apply to a scenario.** A user routes to a hilltop park; the only
approach is a 9% road and their `userMax` is 6%. Walk the value through
all four layers: what does `penalty` return for that edge (`cost.ts:19`),
is `path` null, what's in `steepEdges`, and which card state shows?

**Defend the decision.** Argue why `climbM` (`summary.ts:18`) sums only
*positive directed rise* instead of net elevation change
(end − start). Give the concrete user-facing consequence of each choice
on an out-and-back route.

---

## See also

- `02-optimality-oracle.md` — the tests pinning the `BLOCKED`-finite
  distinction ("null only when disconnected, not when steep").
- `04-degrade-and-surface.md` — the contrasting case: degradation that
  is *not* signalled (the elevation fallback, RF-1).
- `01-search-instrumentation-counters.md` — `cost` and `steepCount` as
  the domain metrics riding alongside the search metrics.
- `00-overview.md` — the evidence map; this is the #3 ranked surface.
- `audit.md` — lens 1 (observability map), lens 6 (state snapshots),
  RF-1 (silent false-clean when elevation degrades).
