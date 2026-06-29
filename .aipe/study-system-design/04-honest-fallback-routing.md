# Honest Fallback Routing

**Industry names:** graceful degradation / soft constraints / fail-open with
flagging. **Type:** Project-specific (encoding "best available, honestly
labeled" into the cost model and UI).

---

## Zoom out, then zoom in

flattr's whole pitch is "flat, not fast." So the obvious implementation is: make
edges steeper than `userMax` impassable, and route around them. The trap: in a
hilly city there often *is* no flat route. A hard constraint would return "no
route" — and the user can't tell whether that means "everything's too steep" or
"these two points genuinely aren't connected." Those are completely different
situations and the app must not conflate them.

```
  Zoom out — where honest fallback lives

  ┌─ ROUTER (features/routing) ──────────────────────────────────────────┐
  │  cost.ts: penalty(grade, userMax)                                     │
  │     downhill→0  moderate→linear  steep→quadratic  over-max→★BLOCKED★  │ ← here
  │                                                  (1e9, FINITE)        │
  │            │                                                          │
  │            ▼  directedAstar still returns a path                     │
  │  astar.ts: summarizePath flags steepEdges (over userMax)             │
  └───────────────┬────────────────────────────────────────────────────── ┘
                  │ steepCount
                  ▼
  ┌─ UI (mobile) ────────────────────────────────────────────────────────┐
  │  RouteSummaryCard: "Flat all the way" | "⚠ Flattest available (N)"    │
  └────────────────────────────────────────────────────────────────────── ┘
```

Zoom in: the concept is **a soft constraint that always returns the best
available answer and tells the truth about its quality.** The question it
answers: *how do you keep "no flat route" distinct from "no route" while still
giving the user something?*

## Structure pass

**Layers.** The honesty threads through three layers: the *cost model*
(`cost.ts`) decides how much a steep edge hurts, the *search* (`astar.ts`)
returns the path and flags the steep edges it had to use, and the *UI*
(`RouteSummaryCard`) reports quality.

**Axis — `guarantees` (hard vs soft constraint).** Trace what `userMax`
*promises* across the layers:

```
  "is userMax a hard wall or a soft preference?" — traced down the layers

  ┌──────────────────────────────────────┐
  │ cost.ts penalty()                     │  → SOFT: over-max = 1e9, not ∞
  └──────────────────────────────────────┘     (huge cost, still finite)
        │  so the search can still traverse it
        ▼
  ┌──────────────────────────────────────┐
  │ astar.ts search + summarizePath       │  → returns a path EVEN IF all steep
  └──────────────────────────────────────┘     + collects steepEdges
        │
        ▼
  ┌──────────────────────────────────────┐
  │ RouteSummaryCard                      │  → labels honesty (steepCount)
  └──────────────────────────────────────┘

  userMax is a PREFERENCE the whole way down, never a wall — that's the design
```

**Seam.** The `BLOCKED = 1e9` constant (`cost.ts:5`) is the seam between
"steep" and "impassable." Choosing finite-vs-infinity here is the single
decision that keeps "no flat route" separate from "no route." That one line
carries the whole contract.

## How it works

### Move 1 — the mental model

You know the difference between a form field that's *invalid* (red border, but
the value's still there) and one that's *blocked* (won't accept input at all).
flattr treats steep grades like the first: discouraged, heavily penalized, but
not forbidden. A truly disconnected graph is the second — genuinely no path.

The strategy in one sentence: **penalize hard but stay finite, so the search
always finds the cheapest path that exists, then flag which parts violated the
preference.**

```
  The pattern — soft penalty curve, finite ceiling

   cost
    │                                    ┌─ over max: +BLOCKED (1e9, FINITE)
    │                              ┌─────┘   path still returned, flagged
    │                       ┌──────┘ steep: quadratic
    │              ┌────────┘ moderate: linear
    │   ───────────┘ downhill / flat: 0 (free)
    └──────────────┴────────┴──────┴────────► directed grade
    0            0.5·max    max

   the ceiling is a step UP, not a wall — A* avoids it but can climb it
```

### Move 2 — the walkthrough

**Step 1 — the penalty curve makes steep expensive, downhill free.** The cost
is directional: going downhill costs nothing extra, moderate uphill is linear,
steep is quadratic, over-max jumps to `BLOCKED`:

```ts
// features/routing/cost.ts:16-22 (penalty)
if (g <= 0) return 0;                         // 17: downhill/flat → free
if (g > max) return BLOCKED;                  // 18: over userMax → 1e9 (finite!)
const half = 0.5 * max;
if (g <= half) return k1 * g;                 // 20: moderate → linear
return k2 * (g - half) ** 2 + k1 * half;      // 21: steep → quadratic
```

Line 18 is the crux. `BLOCKED` is `1e9` (`cost.ts:5`), **not** `Infinity`. The
comment says it outright: *"Large but FINITE, so an only-steep path is still
returned and flagged."* A path made entirely of over-max edges costs ~N×1e9 —
astronomically expensive, so A* avoids it whenever any alternative exists, but
it's a real number, so the path is still found.

The penalty uses the *signed directed* grade (`cost.ts:32-33`,
`directedGrade(edge, fromNodeId)`), so the same physical hill is free downhill
and penalized uphill — `gradePct` negated by travel direction
(`graph.ts:17-19`).

**Step 2 — the search returns the cheapest existing path, no special-casing.**
A* doesn't filter BLOCKED edges; it just relaxes every edge with its cost
(`astar.ts:64-75`). Because BLOCKED is finite, an over-max edge has a finite
`g`-value and can be on the final path. The only way A* returns null is a
genuinely disconnected graph — which is exactly the distinction we wanted.

```
  Layers-and-hops — the honesty signal crossing from router to UI

  ┌─ Router (features/routing) ──────────────────────────────────────────┐
  │  directedAstar → search → reconstruct (astar.ts:86-103)              │
  │            │ hop 1: summarizePath collects steepEdges                │
  │            ▼                                                          │
  │  Path { ..., steepEdges: [ids over userMax] }   astar.ts:126-127     │
  └───────────────┬────────────────────────────────────────────────────── ┘
                  │ hop 2: routeSummary → { steepCount }  summary.ts
                  ▼
  ┌─ UI (mobile) ────────────────────────────────────────────────────────┐
  │  RouteSummaryCard: steepCount === 0 ? "Flat" : "⚠ Flattest available" │
  │  (RouteSummaryCard.tsx:28-36)                                         │
  └────────────────────────────────────────────────────────────────────── ┘
```

**Step 3 — flag the violations during reconstruction.** As A* rebuilds the
path, it records which edges exceeded `userMax` — that's the honesty payload:

```ts
// features/routing/astar.ts:120-129 (summarizePath, the flagging loop)
cost += costFn(edge, from, userMax);
lengthM += edge.lengthM;
if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
  steepEdges.push(edge.id);             // 127: this edge violated the preference
}
```

Note `Number.isFinite(userMax)` — the "Any" preset effectively turns flagging
off. `steepEdges` flows into `routeSummary` (`summary.ts`) as `steepCount`.

**Step 4 — the UI tells the truth.** The card reads `steepCount` and labels the
route's quality plainly:

```ts
// mobile/src/RouteSummaryCard.tsx:28-36
const clean = summary.steepCount === 0;
// renders "Flat all the way" when clean,
// else "⚠ Flattest available" + the count of steep blocks over userMax
```

There's a *second* honesty channel for a different failure: when elevation data
is missing (`05-elevation-provider-fallback.md`), the card shows "Grades
approximate — elevation unavailable, retrying" (`MapScreen.tsx:375-376`). So the
UI distinguishes three states: flat route, flattest-available route, and
grades-not-yet-known.

#### Move 2 variant — what breaks if you remove it

The kernel is one decision plus its propagation:

1. **`BLOCKED` is finite** (`cost.ts:5,18`). Make it `Infinity` and an
   only-steep route becomes unreachable — A* returns null, the UI says "no
   route," and the user can't tell that from a genuinely disconnected pair.
   *Breaks: the steep-vs-disconnected distinction — the entire point.*
2. **`steepEdges` flagging** (`astar.ts:126-127`). Remove it and the route is
   returned but the UI can't tell if it's clean. *Breaks: honest labeling — the
   user trusts a flat-looking route that's actually all hills.*
3. **The UI read of `steepCount`** (`RouteSummaryCard.tsx:28`). Remove it and
   the honesty payload exists but never reaches the user.

Optional hardening: the piecewise linear/quadratic shape (`cost.ts:20-21`) tunes
*how much* steepness hurts, but the finite ceiling is the load-bearing part.

### Move 3 — the principle

The principle is **prefer fail-open with honest labeling over fail-closed
silence.** When a constraint can't always be satisfied, returning "the best
available, clearly labeled as imperfect" beats returning nothing — provided you
preserve the distinction between "best available is bad" and "nothing exists."
flattr encodes that distinction in a single constant choice (finite vs infinite)
and carries the quality signal all the way to the UI. The same instinct shows up
in search ranking (return results, flag low confidence), form validation (accept
with warnings), and LLM systems (answer, but surface uncertainty).

## Primary diagram

```
  Honest fallback routing — the full picture

  ┌─ cost.ts: the soft constraint ───────────────────────────────────────┐
  │  penalty(signed grade, userMax):                                      │
  │    g≤0 → 0 | g≤½max → linear | g≤max → quadratic | g>max → 1e9 FINITE │
  │  BLOCKED = 1e9 (cost.ts:5) ← finite keeps only-steep paths reachable  │
  └───────────────────────────────┬────────────────────────────────────── ┘
                                   │ directedAstar (astar.ts:156-163)
                                   ▼
  ┌─ astar.ts: search + flag ────────────────────────────────────────────┐
  │  returns cheapest EXISTING path (null only if disconnected)          │
  │  summarizePath collects steepEdges where directedGrade > userMax      │
  └───────────────────────────────┬────────────────────────────────────── ┘
                                   │ routeSummary → steepCount
                                   ▼
  ┌─ UI: three honest states ────────────────────────────────────────────┐
  │  steepCount 0   → "Flat all the way"                                  │
  │  steepCount >0  → "⚠ Flattest available (N steep blocks)"             │
  │  grades missing → "Grades approximate — retrying" (MapScreen:375)     │
  │  no path at all → genuinely disconnected (distinct from above)        │
  └────────────────────────────────────────────────────────────────────── ┘
```

## Elaborate

This is graceful degradation done at the algorithm layer rather than the infra
layer. Most "graceful degradation" talk is about services (fall back to a cache,
serve stale). Here it's about a *search constraint*: the cost function is
designed so the constraint can never make a reachable destination unreachable.
The finite-BLOCKED trick is a known move in pathfinding — soft constraints via
large penalties rather than edge removal — but it's easy to get wrong by reaching
for `Infinity` because it "feels" like "impassable." The whole spec calls this
out (`context.md` must-not-change: "`BLOCKED` is large-finite, not Infinity").

The directional cost (free downhill, penalized uphill) is what makes flattr's
routes feel right — a loop that climbs gently and descends steeply is genuinely
more comfortable than its reverse, and the signed grade captures that
(`cost.ts:32-33`). Read `03-tile-merge-stitch.md` for why degraded tiles are
still merged into the *routing* graph (connectivity beats fidelity) and
`05-elevation-provider-fallback.md` for the "grades approximate" channel.

## Interview defense

**Q: How do you distinguish "no flat route" from "no route at all"?**
By making the over-max penalty large but *finite*. `BLOCKED = 1e9`
(`cost.ts:5`), not `Infinity`, so an over-max edge is heavily penalized but
still traversable. A* returns null *only* when the graph is genuinely
disconnected; an all-steep route comes back with every steep edge flagged in
`steepEdges` (`astar.ts:126-127`) and the UI says "flattest available."

```
  BLOCKED = Infinity  →  only-steep route = "no route"  (WRONG: conflates)
  BLOCKED = 1e9       →  only-steep route = returned + flagged  (correct)
                         null = truly disconnected (distinct)
```
Anchor: *finite ceiling keeps "best available" and "nothing exists" separate.*

**Q: Why directional cost?**
Comfort is asymmetric — descending a hill is fine, climbing it isn't. The cost
uses the *signed* directed grade (`cost.ts:32-33`, `directedGrade`), so the same
edge is free downhill and penalized uphill (`graph.ts:17-19`). A symmetric
penalty would treat a gentle-up/steep-down loop the same as its painful reverse.

**Q: The load-bearing part people forget?**
That `BLOCKED` is finite. It's a one-line constant (`cost.ts:5`) and the
instinct is to use `Infinity` for "impassable." Getting it finite is what
preserves the entire steep-vs-disconnected distinction the product depends on.

## See also

- `03-tile-merge-stitch.md` — degraded tiles merged for routing, not display
- `05-elevation-provider-fallback.md` — the "grades approximate" honesty channel
- `audit.md` §6 (failure handling)
- neighboring: **study-dsa-foundations** (A*, admissible heuristic, cost models)
