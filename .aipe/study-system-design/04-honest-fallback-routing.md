# Honest fallback routing

**Industry names:** graceful degradation / sentinel-vs-infinity / fail-honest UX /
distinguishable failure modes. **Type:** Industry standard (with a project-specific
sentinel choice).

---

## Zoom out, then zoom in

flattr promises "flat, not fast." But sometimes there *is* no flat route, and
sometimes there's no route at all, and sometimes the grades it's showing you are
guesses because the elevation API was down. A lazy system collapses all three into
"error." flattr keeps them distinct, end to end — the cost function, the path
summary, and the UI card each preserve the difference.

```
  Zoom out — honesty threads through cost → summary → UI

  ┌─ Engine ────────────────────────────────────────────────────┐
  │  cost.ts: BLOCKED = 1e9 (large-FINITE, not Infinity)         │ ← we are here
  │      ▼                                                       │
  │  astar.ts summarizePath: flag steepEdges (don't drop them)   │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼
  ┌─ UI ────────────────────────────────────────────────────────┐
  │  RouteSummaryCard: "Flat all the way" | "⚠ Flattest          │
  │     available (N steep)" | "No route" | "Grades approximate" │
  └─────────────────────────────────────────────────────────────┘
```

You've used a sentinel value instead of a null to keep a result *in band* — return
`-1` for "not found" so the caller can still do arithmetic. Same trick, load-bearing
here: `BLOCKED` is a huge *finite* number, not `Infinity`, so an only-steep path
still has a comparable cost and still gets returned. The question it answers: *when
the ideal route doesn't exist, does the system lie, error out, or tell the truth?*

---

## The structure pass

**Layers:** cost function → search/summary → UI card.

**Axis = guarantees (what does each layer promise about route quality?).**

```
  One question down the layers: "what is being promised about the route?"

  ┌───────────────────────────────────┐
  │ cost.ts penalty()                 │  → "steep is expensive, not impossible"
  └───────────────────────────────────┘     (BLOCKED finite)
      ┌─────────────────────────────────┐
      │ summarizePath / routeSummary    │  → "here's the path AND which blocks are steep"
      └─────────────────────────────────┘     (steepEdges, climbM, steepCount)
          ┌─────────────────────────────┐
          │ RouteSummaryCard            │  → "flat / flattest-but-steep / none /
          └─────────────────────────────┘      approximate" — the truth, labeled
```

**Seam = `BLOCKED = 1e9` (`cost.ts:5`).** The single most load-bearing line in the
product's reliability story. Trace the *guarantees* axis across it: if `BLOCKED`
were `Infinity`, a steep-only path would be uncomparable and the search would return
`null` — indistinguishable from a genuinely disconnected graph. Because it's finite,
the path comes back, flagged. The constraint is even pinned in the project rules:
*"BLOCKED is large-finite, not Infinity — so 'no flat route' (steep flagged) stays
distinct from 'no route' (disconnected)."*

---

## How it works

#### Move 1 — the mental model

The shape is a banded penalty with a finite ceiling, plus a flag that rides along
the path. Downhill is free, moderate uphill is linear, steep is quadratic,
over-the-max is `BLOCKED` (huge but finite). The search minimizes total cost, so it
*avoids* steep edges but will still traverse one if there's no alternative — and
marks it.

```
  Pattern — banded penalty, finite ceiling, flagged path

  directed grade g vs userMax:

  cost
   │                                   ┌─ BLOCKED (1e9, FINITE)
   │                              _____│   g > max → flagged steep
   │                         ____/      quadratic band
   │              ______ k1·g           (0.5max .. max)
   │   __________/        linear band (0 .. 0.5max)
   │  0  (downhill/flat → free)
   └──────────────────────────────────────► g
      g≤0      0.5·max        max

  finite ceiling ⇒ an only-steep path still has a comparable cost ⇒ still returned
```

#### Move 2 — the walkthrough

**`BLOCKED` is finite on purpose.** The whole pattern hinges on this:

```ts
// features/routing/cost.ts:5 — large but FINITE
export const BLOCKED = 1e9;   // so an only-steep path is still returned and flagged
// :16 — the banded penalty
export function penalty(g, max, k1, k2) {
  if (g <= 0) return 0;                       // downhill/flat: free
  if (g > max) return BLOCKED;                // over max: huge but comparable
  const half = 0.5 * max;
  if (g <= half) return k1 * g;               // moderate: linear
  return k2 * (g - half) ** 2 + k1 * half;    // steep: quadratic
}
```
What breaks if `BLOCKED = Infinity`: adding `Infinity` to a path cost makes it
uncomparable; A*'s `tentative < g.get(next)` relaxation can't order steep paths, so
the only-steep route never gets reconstructed and the search returns `null` —
identical to a disconnected graph. The user can't tell "your route is steep" from
"there is no route." The finite sentinel keeps the two distinct.

**The path carries which edges are steep — it doesn't drop them.**
`summarizePath` flags any edge whose *directed* grade exceeds `userMax`, but keeps
it in the route:

```ts
// features/routing/astar.ts:110 — flag, don't drop
if (Number.isFinite(userMax) && directedGrade(edge, from) > userMax) {
  steepEdges.push(edge.id);                   // mark it, route still includes it
}
// summary.ts:11 — surface the honest totals
return { distanceM: path.lengthM, climbM, steepCount: path.steepEdges.length };
```
Directed grade matters here: the same edge is uphill one way, downhill the other
(`graph.ts:17`), so reversing From/To genuinely changes which blocks are steep —
the summary reflects the actual direction of travel.

**The UI renders three honest states + a quality note.** The card is a pure function
of `(found, summary)`:

```
  State machine — RouteSummaryCard (mobile/src/RouteSummaryCard.tsx)

  found=false ───────────────────────────► "No route between those points." (red)
  found=true, steepCount=0 ──────────────► "Flat all the way" (green)
  found=true, steepCount>0 ──────────────► "⚠ Flattest available · N steep blocks" (amber)
       │
       └─ + note "Grades approximate — elevation unavailable, retrying"
                 when corridorDegraded  (MapScreen.tsx:376)
```
Grounded: `RouteSummaryCard.tsx:18` (no route), `:32` (clean vs flattest),
`:35` (steep count). The fourth signal — *grade quality* — comes from the degraded
flag threaded up from `useTileGraph` (`MapScreen.tsx:376`), so even a *returned*
route admits when its grades are guesses (→ `05-elevation-provider-fallback.md`).

The hop, drawn:

```
  Layers-and-hops — honesty from engine to pixel

  ┌─ cost.ts ───────┐ hop1: BLOCKED finite   ┌─ astar.ts ──────────┐
  │ penalty()       │ ─────────────────────► │ search returns path │
  └─────────────────┘                        │ + steepEdges flagged│
                                             └──────────┬──────────┘
                              hop2: routeSummary(steepCount, climbM)
                                                        ▼
  ┌─ MapScreen ─────┐ hop3: found + summary  ┌─ RouteSummaryCard ──┐
  │ corridorDegraded│ ─────────────────────► │ 3 states + quality  │
  │ → note prop     │                        │ note                │
  └─────────────────┘                        └─────────────────────┘
```

#### Move 3 — the principle

Distinguishable failure modes are a feature, not a nicety. The instinct to collapse
"no good answer" into one error throws away the exact information the user needs:
*how* it failed determines what they do next (reroute vs widen the grade slider vs
wait for elevation). A finite sentinel instead of `Infinity`, a flag that rides the
result instead of being discarded, and a UI that names each state — that's how you
keep the distinction alive from the algorithm all the way to the pixel.

---

## Primary diagram

```
  Honest fallback routing — full pattern

  ┌─ cost.ts ───────────────────────────────────────────────────┐
  │  penalty: free / linear / quadratic / BLOCKED(1e9, FINITE)   │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼
  ┌─ astar.ts search + summarizePath ───────────────────────────┐
  │  minimize cost (avoids steep) · return path even if steep    │
  │  steepEdges = directedGrade > userMax  (flag, don't drop)    │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼
  ┌─ summary.ts ────────────────────────────────────────────────┐
  │  distanceM · climbM (uphill only) · steepCount               │
  └───────────────┬─────────────────────────────────────────────┘
                  ▼
  ┌─ RouteSummaryCard ──────────────────────────────────────────┐
  │  green "Flat all the way" | amber "⚠ Flattest available · N" │
  │  | red "No route"  + note "Grades approximate" if degraded   │
  └─────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The finite-sentinel trick is the same one you've used returning `-1` from a search
instead of throwing, or a max-int weight in a graph instead of a missing edge — it
keeps the result *in the same type* so downstream math still works. The deeper idea
is graceful degradation: a system under partial failure should narrow the user's
options honestly rather than fail closed. flattr threads four distinct truths —
flat, steep, disconnected, approximate-grades — from `cost.ts` to the card.

The "approximate grades" branch is owned by `05-elevation-provider-fallback.md`;
the directed-grade math is `graph.ts:17` / `study-data-modeling`. The A* relaxation
that the finite ceiling protects is `06-parametric-search-engine.md`.

---

## Interview defense

**Q: Why is `BLOCKED` `1e9` and not `Infinity`?**
So an only-steep path stays comparable and gets returned, flagged — distinct from a
disconnected graph that returns `null`. With `Infinity`, A*'s relaxation can't order
steep paths and you'd return `null` for "steep" too, collapsing "no flat route" into
"no route." The user couldn't tell them apart.

```
  Infinity:  steep path → null  ┐
  no path  → null               ┘ same → user can't distinguish
  1e9:       steep path → returned+flagged  ≠  no path → null  → distinguishable
```
Anchor: finite sentinel keeps "bad" and "impossible" distinct. This is the single
most load-bearing line in the reliability story (`cost.ts:5`).

**Q: How does the UI avoid lying when elevation was unavailable?**
The degraded flag rides up from `useTileGraph` and the card shows "Grades
approximate — elevation unavailable, retrying" (`MapScreen.tsx:376`) even on a
returned route. So a route can be *shown* and *labeled as provisional*
simultaneously.
Anchor: a returned answer can still admit it's a guess.

**Q: Why store steep edges instead of just a boolean "has steep"?**
The exact `steepEdges` ids let the route line color those segments and the summary
count them; reversing direction recomputes them via directed grade. A boolean would
lose which blocks and break on reversal.
Anchor: keep the granular flag; directed grade makes it direction-aware.

---

## See also

- `05-elevation-provider-fallback.md` — the "approximate grades" degraded branch.
- `06-parametric-search-engine.md` — the A* the finite ceiling protects.
- `03-tile-merge-stitch.md` — routing-includes-degraded vs display-excludes-degraded.
- `audit.md` lens 6 — failure-handling-and-reliability.
</content>
