# Route-honesty signals

**Industry names:** soft-constraint flagging / "best-effort, labeled"; the
sentinel-value-vs-null distinction; degraded-result surfacing.
**Type:** Project-specific (the `BLOCKED`-finite trick), built on a
language-agnostic idea (fail-open with honest labels).

---

## Zoom out, then zoom in

A router that only ever returns "here's your flat route" or "no route" is lying
by omission — most of the time the truth is "here's the flattest route I could
find, but two blocks are steeper than you wanted." flattr makes that third state
first-class. The honesty travels from a single constant in the cost function all
the way to a yellow card in the UI.

```
  Zoom out — where honesty signals originate and surface

  ┌─ Engine layer (features/routing/) ──────────────────────────┐
  │  cost.ts   →  ★ BLOCKED = 1e9 (FINITE, not Infinity) ★       │ ← origin
  │  astar.ts  →  summarizePath() flags steepEdges              │
  │  summary.ts → routeSummary() → steepCount                   │
  └─────────────────────────────┬───────────────────────────────┘
                                │  Path { steepEdges }, RouteSummary { steepCount }
  ┌─ Mobile UI layer (mobile/src/) ─▼───────────────────────────┐
  │  RouteSummaryCard.tsx → 3 honest states                    │ ← surface
  │  "Flat all the way" / "⚠ Flattest available" / "No route"  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **encode the difference between "bad" and "impossible" in
the type system, then surface it.** The linchpin is one decision — make `BLOCKED`
a large *finite* number instead of `Infinity`. That single choice is what keeps
"the only route is steep" (a path exists, flag it) distinct from "the points are
disconnected" (no path, return null). Get it wrong and the two collapse into the
same `null`, and the router can no longer tell the user the truth.

---

## The structure pass

**Layers:** the signal originates in the **cost function**, is computed in the
**path summarizer**, aggregated in the **summary**, and rendered in the **card**.

**Axis traced — "what does an unsatisfiable preference become?"** Hold it down
the stack:

```
  axis = "what happens when the route can't be flat?"  — trace it down

  ┌─ cost.ts penalty() ─────────┐  → returns BLOCKED (1e9), FINITE
  │  g > max                    │     so the edge is costly, NOT removed
  └───────────┬──────────────────┘
  ┌─ astar.ts summarizePath ────┐  → still finds a path; pushes the
  │                             │     over-max edge id into steepEdges
  └───────────┬──────────────────┘
  ┌─ summary.ts routeSummary ───┐  → steepCount = steepEdges.length
  └───────────┬──────────────────┘
  ┌─ RouteSummaryCard ──────────┐  → "⚠ Flattest available (2 steep blocks)"
  └──────────────────────────────┘     NOT "no route"
```

**The seam — `BLOCKED = 1e9` at `cost.ts:4-5`.** This is *the* load-bearing
boundary in the whole guide. The axis flips here: above it, "too steep" could
have been modeled as `Infinity` (which collapses to "no route"); the choice to
make it finite is what keeps the two states separate everywhere downstream. The
comment on the line names the contract exactly: *"Large but FINITE, so an
only-steep path is still returned and flagged."* One line carries the entire
honesty guarantee.

---

## How it works

### Move 1 — the mental model

You know how HTTP separates `404 Not Found` from `200 OK` with a warning header?
A 404 means "this resource doesn't exist"; a 200-with-caveat means "here it is,
but heads up." flattr needs the same two-channel answer: `null` is the 404 ("no
route exists"), and a path *with a non-empty `steepEdges`* is the 200-with-caveat
("here's your route, but these blocks are steep").

```
  The pattern — two failure channels, kept distinct

   directedAstar(graph, start, goal, userMax)
        │
   ┌────┴───────────────────────────────────────┐
   │  is there ANY path (even over-max edges)?    │
   ├──────────────┬───────────────────────────────┤
   │ no           │ yes                           │
   ▼              ▼
  path = null    path = { …, steepEdges: [...] }
  "No route"     steepEdges empty → "Flat all the way"
  (disconnected) steepEdges full  → "⚠ Flattest available"
```

The trick that makes this work: because over-max edges cost `BLOCKED` (huge but
finite), the search *will* traverse them if there's no flatter alternative —
producing a path, not a `null`. The penalty makes them a last resort, not a wall.

### Move 2 — the step-by-step walkthrough

**The linchpin — `BLOCKED` is finite.** This is the canonical place the honesty
guarantee lives (`features/routing/cost.ts:4-5`, `11-22`):

```typescript
// features/routing/cost.ts:4-5
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;

// :11-22  the penalty curve
export function penalty(g: number, max: number, k1 = DEFAULT_K1, k2 = DEFAULT_K2): number {
  if (g <= 0) return 0;            // downhill/flat: free
  if (g > max) return BLOCKED;     // over max: BLOCKED — but finite, so still traversable
  const half = 0.5 * max;
  if (g <= half) return k1 * g;    // moderate uphill: linear
  return k2 * (g - half) ** 2 + k1 * half;  // steep uphill: quadratic
}
```

Read `:18`: over-max grade returns `BLOCKED`, not `Infinity`. If it were
`Infinity`, A* could never produce a finite path cost through that edge, and the
over-steep route would come back as `null` — indistinguishable from a genuinely
disconnected graph. The test pins this exactly (`cost.test.ts:81-86`): a too-steep
climb costs *more* than `BLOCKED` yet `Number.isFinite(c)` is `true`. Finite cost
⇒ reachable ⇒ a path the user can be honestly warned about.

**The flagging — `summarizePath` records which edges it compromised on.** When
the search builds the path, it tags every over-max edge (`astar.ts:117-128`):

```typescript
// features/routing/astar.ts:117-128 (condensed)
const steepEdges: string[] = [];                 // :117  the honesty payload
for (let i = 0; i < edges.length; i++) {
  const edge = edges[i];
  const from = nodes[i];
  cost += costFn(edge, from, userMax);
  lengthM += edge.lengthM;
  if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
    steepEdges.push(edge.id);                     // :126-127  flag the compromise
  }
}
return { nodes, edges: edgeIds, cost, lengthM, steepEdges };
```

The path doesn't just carry *the route* — it carries *the route plus a list of
where it had to break the user's preference*. `steepEdges` is the receipt of
compromise, and it's part of the `Path` type itself (`types.ts:36`), so it can't
be dropped on the way to the UI. Note `directedGrade` (`:126`) — the flag is
direction-aware: an edge is steep going uphill, free going down.

**The disambiguation, proven by tests.** Two tests pin the two channels apart
(`astar.test.ts:82-96`):

```typescript
// only-steep path: returned AND flagged
it("still returns an only-steep path and flags the steep edge", () => {
  const r = directedAstar(g, "X", "Y", 5);
  expect(r.path).not.toBeNull();               // a path exists
  expect(r.path!.steepEdges).toEqual(["xy"]);  // …and it's honest about being steep
});
// genuinely disconnected: null
it("returns null only when genuinely disconnected, not when merely steep", () => {
  expect(directedAstar(g, "X", "ISO", 5).path).toBeNull();  // ISO has no edges
});
```

These two tests *are* the regression guard for the "no route between those
points" incident (`audit.md` lens 7): they lock in that `null` means
disconnected, never merely-steep.

**The surface — three honest states in the card.** The aggregation collapses
`steepEdges` to a count (`summary.ts:7-20`, `steepCount = path.steepEdges.length`),
and the card renders the three states (`mobile/src/RouteSummaryCard.tsx:20-42`):

```
  Layers-and-hops — honesty crosses from engine to UI

  ┌─ Engine ──────────────┐  Path{steepEdges}  ┌─ summary.ts ─────────┐
  │ summarizePath flags    │ ─────────────────► │ steepCount =         │
  │ astar.ts:126-127       │                    │ steepEdges.length :19│
  └────────────────────────┘                    └──────────┬───────────┘
                                                            │ RouteSummary
  ┌─ Mobile UI: RouteSummaryCard.tsx ──────────────────────▼──────────┐
  │  !found            → "No route between those points."     :21     │
  │  steepCount === 0  → "Flat all the way"                    :32     │
  │  steepCount > 0    → "⚠ Flattest available"               :32     │
  │                      "{n} steep block(s) (>{userMax}%)"   :35-36  │
  │  note prop         → degraded note slot (see 04-…)        :42     │
  └────────────────────────────────────────────────────────────────────┘
```

`clean = summary.steepCount === 0` (`:28`) is the whole decision. Three states,
each honest: no route, perfect route, or compromised-but-labeled route. The card
never shows a route as flat when it isn't.

### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A sentinel cost that is *large-finite* + a per-edge
   flag list + a render that distinguishes `null` / empty-flags / full-flags.
2. **Name each part by what breaks without it.**
   - Make `BLOCKED` = `Infinity` → over-steep routes return `null`, collapsing
     into "no route." The user is told the trip is impossible when it's merely
     hilly. (This is the bug the finite value prevents.)
   - Drop `steepEdges` → the path exists but the UI can't tell flat from
     compromised; it shows everything as "flat," lying.
   - Drop the `null` channel → "no route" becomes indistinguishable from "empty
     route," and the disconnected case is silently wrong.
3. **Skeleton vs hardening.** The kernel is large-finite + flag + three-way
   render. The quadratic-vs-linear penalty curve (`cost.ts:20-21`) is *hardening*
   — it shapes *which* flattish route wins, but honesty holds with any monotone
   penalty.

The interview payoff: naming that `BLOCKED` must be *finite* is the part people
miss. "Just set steep edges to infinity" is the natural instinct and it's exactly
the bug.

### Move 3 — the principle

**Prefer fail-open with honest labeling over fail-closed silence — but preserve
the distinction between "best available is bad" and "nothing exists."** Returning
"the flattest route, clearly flagged" beats returning nothing; returning it
*without* the flag is worse than nothing because it lies. The finite sentinel is
the cheap mechanism that buys both: routes stay reachable, and `null` stays
reserved for true impossibility.

---

## Primary diagram

The full honesty pipeline: one constant decision propagating to three UI states.

```
  Route-honesty signals — origin to surface

  ┌─ Engine layer: features/routing/ ───────────────────────────────────┐
  │  cost.ts:4-5   BLOCKED = 1e9  ← FINITE (the linchpin)               │
  │       │  over-max edge is costly, not removed                       │
  │       ▼                                                             │
  │  astar.ts:126-127  summarizePath → steepEdges.push(over-max id)     │
  │       │                                                             │
  │       ▼                                                             │
  │  summary.ts:19  steepCount = steepEdges.length                      │
  └───────┼─────────────────────────────────────────────────────────────┘
          │  RouteSummary { distanceM, climbM, steepCount }
  ┌─ Mobile UI: RouteSummaryCard.tsx:20-42 ─▼──────────────────────────┐
  │   path === null   → "No route between those points"   (404)        │
  │   steepCount == 0 → "Flat all the way"                 (200 clean)  │
  │   steepCount > 0  → "⚠ Flattest available · N steep"   (200 warned) │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The sentinel-vs-null distinction is an old systems idea: `errno` separates "the
call failed" from "the call succeeded with a special value"; SQL separates `NULL`
("unknown") from `0` ("known to be zero"). Collapsing the two is a classic bug
class — flattr's version would be returning `null` for a hilly-but-reachable
route. The finite-`BLOCKED` trick is the same shape as using `-1` for "not found"
in `indexOf` instead of throwing: a reachable-but-flagged sentinel, not an
exception that destroys the answer.

The adjacent concept is **degrade-and-surface** (`04-degrade-and-surface-seam.md`):
honesty signals report when the *route* is compromised; degrade-and-surface
reports when the *data behind the grades* is compromised. They meet in the card —
the `note` prop slot (`RouteSummaryCard.tsx:42`) is where the degraded-data
warning lands, right next to the steep-edge warning. What to read next:
`study-system-design/04-honest-fallback-routing.md` for the architecture, then
`04-degrade-and-surface-seam.md` for the data side.

---

## Interview defense

**Q: Why is `BLOCKED` `1e9` and not `Infinity`? Isn't a too-steep edge
effectively impassable?**

Because `Infinity` would erase the difference between "too steep" and "no route."
With `Infinity`, any path forced through an over-max edge has infinite cost, so
A* returns `null` — identical to a genuinely disconnected graph. The user gets
"no route" when the honest answer is "here's the flattest one, it has two steep
blocks." `1e9` is large enough to make steep edges a last resort, finite enough
that the path still has a real cost and comes back with `steepEdges` flagged
(`cost.ts:4-5`, proven finite at `cost.test.ts:81-86`).

```
  the failure that finite-BLOCKED prevents

   over-steep-only route
   ├─ BLOCKED = Infinity → cost = ∞ → path = null → "No route"  ✗ lies
   └─ BLOCKED = 1e9      → cost = big → path + steepEdges → "⚠ flattest" ✓
```

Anchor: *finite sentinel keeps "bad" distinct from "impossible."*

**Q: How does the UI know to show a warning vs a clean route?**

One boolean: `clean = summary.steepCount === 0` (`RouteSummaryCard.tsx:28`).
`steepCount` is `path.steepEdges.length`, and `steepEdges` was populated edge-by-edge
during path construction whenever the directed grade exceeded `userMax`
(`astar.ts:126-127`). The flag rides inside the `Path` type, so it can't be
dropped between engine and UI. Three states fall out: `null` → "No route",
count 0 → "Flat all the way", count > 0 → "⚠ Flattest available."

Anchor: *`steepEdges` is the receipt of compromise, carried in the Path type.*

---

## See also

- `04-degrade-and-surface-seam.md` — the data-quality sibling; meets this in the
  card's `note` slot.
- `02-optimality-oracle-probe.md` — proves the path is optimal; honesty signals
  report when even the optimal path is steep.
- `study-system-design` — `04-honest-fallback-routing.md` (the architecture).
- `audit.md` — lens 7 (the "no route" incident this guards) and lens 1.
