# 05 — BLOCKED as a large finite number

**Industry names:** sentinel-as-large-finite / soft constraint / define-the-error-away.
**Type label:** Project-specific (the technique is general; the choice is flattr's).

An over-grade edge costs a billion, not infinity. That one decision keeps
"no *flat* route" distinct from "no route at all" — and erases a whole
branch of special-case code.

---

## Zoom out, then zoom in

This is a single constant (`cost.ts:5`) with outsized leverage. It sits
inside the penalty kernel (`02`) but it deserves its own file because the
*finiteness* is a deliberate, load-bearing, easy-to-get-wrong choice.

```
  Zoom out — where BLOCKED lives and what it protects

  ┌─ ROUTING CORE ───────────────────────────────────────────────┐
  │  penalty()  cost.ts:16  →  returns ★ BLOCKED = 1e9 ★ when g>max│
  │                              cost.ts:5  ← we are here          │
  │     ▼                                                          │
  │  search()  → still returns a PATH (expensive) for steep-only   │
  │  search()  → returns NULL only when truly disconnected         │
  └───────────────────────────────────────────────────────────────┘
  ┌─ UI consequence ─────────────────────────────────────────────┐
  │  "steep route, flagged"  ≠  "no route exists"                 │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a soft constraint encoded as a large finite
cost** — the opposite of a hard `Infinity` or a thrown exception. You've
done this whenever you ranked a bad-but-allowed option as "very expensive"
instead of filtering it out, so it still appears when it's the *only*
option. Here the bad option is "a hill steeper than you wanted," and
flattr keeps it on the table, just last.

---

## Structure pass

**Layers.** The constant (`BLOCKED`) → the penalty that returns it → the
search that sums it → the two distinguishable outcomes (steep path vs no
path). One number, propagating up to a user-visible distinction.

**Axis held constant — "can this route still be returned?"**

```
  "is a steep-only path returnable?" — Infinity vs large-finite

  ┌─ Infinity design ────┐          ┌─ large-finite design ────────┐
  │ steep edge = ∞        │          │ steep edge = 1e9             │
  │ ∞ + anything = ∞      │          │ 1e9 + length = still finite  │
  │ → path cost = ∞       │          │ → path has a real total cost │
  │ → indistinguishable   │  flips   │ → comparable, RANKED last    │
  │   from "no route"     │ ═══════► │ → returned + flagged steep   │
  └──────────────────────┘          └──────────────────────────────┘
```

**Seam.** `BLOCKED (finite) │ Infinity (the path not taken)`. The axis
"can a steep-only route still come back" flips between the two designs.
Finite is what lets the search *rank and return* a steep route instead of
treating it as nonexistent.

---

## How it works

### Move 1 — the mental model

The shape: a wall you can climb if you absolutely must, priced so high
you only take it when there's no alternative — versus a wall you can't
climb at all. Infinity is the impassable wall (it collapses into "no
route"); a billion is the climbable-but-awful wall (it stays a route).

```
  Pattern — finite wall vs infinite wall

  cost
   │   1e9 ┤■■■■■  ← finite wall: steep-only path totals ~1e9·n,
   │       │        a real number → search returns + flags it
   │       │
   │   ∞   ┤▓▓▓▓▓  ← infinite wall: path totals ∞ → equals
   │       │        "no path" → search returns NULL, user can't tell
   └───────┴─────── grade
              g > max
```

### Move 2 — the walkthrough

**The constant, and the comment that is the whole rationale.**
`cost.ts:4-5`:

```ts
// features/routing/cost.ts:4-5
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

The doc-comment carries what the value can't: *finite is the point.* This
is the kind of comment audit lens 7 praises — it explains the decision,
not the syntax.

**Where it's returned.** `cost.ts:18`, inside `penalty`: `if (g > max)
return BLOCKED`. So an over-grade edge contributes `length * (1 + 1e9)`
to the path cost — huge, but a number.

**Why finite changes the search outcome.** Trace two scenarios through
`search` (`astar.ts:22`):

```
  Execution trace — steep-only path, two designs

  graph: start ─steep(g>max)─ goal     (the ONLY connection)

  design = BLOCKED (1e9):
    relax edge: tentative = 0 + length·(1+1e9)  = ~1e9·length  (finite)
    push goal at ~1e9
    pop goal → reconstruct → return PATH (cost ~1e9, steepEdges=[that edge])
    ► user sees: "here's a route, but it's steeper than you wanted"

  design = Infinity:
    relax edge: tentative = 0 + length·(1+∞)  = ∞
    push goal at ∞  (or never improve over Infinity sentinel)
    ► path cost ∞ — indistinguishable from a disconnected graph
    ► user sees: "no route" — WRONG, a route exists
```

**The honesty flag rides alongside.** `summarizePath` (`astar.ts:126`)
records *which* edges exceeded `userMax` into `steepEdges` — separately
from the cost. So the returned `Path` carries both "here's the route" and
"these segments are over your limit." The finite cost gets the route
returned; the `steepEdges` list makes it honest. **Boundary condition:**
`null` is reserved for genuine disconnection — `search` returns `null`
only when the frontier empties without reaching the goal (`astar.ts:77`).
The two failure modes stay distinct *because* steep edges never make the
cost non-finite.

**Why not `Infinity` — and the one risk of `1e9`.** `Infinity` would
fold "steep" into "disconnected," losing the distinction the product
needs (spec §14.4). The cost of the finite choice: if a path stacked
enough blocked edges that the total approached `Number.MAX_SAFE_INTEGER`
(~9e15), precision could erode. At `1e9` per blocked edge you'd need
millions of blocked edges in one path to get there — impossible for a
real route — so `1e9` has comfortable headroom. That's why the *magnitude*
is chosen, not arbitrary: big enough to dominate any real distance,
small enough to never overflow.

### Move 3 — the principle

When a constraint is "strongly discouraged" rather than "physically
impossible," encode it as a large finite cost, not infinity and not a
filter. The optimizer then treats it as the last resort it is — avoided
when alternatives exist, surfaced (and flagged) when it's all there is.
Reserve infinity / exceptions / null for the genuinely impossible, so
"bad option" and "no option" stay distinguishable to the user. The whole
move is *defining the error away*: there's no "no flat route" special
case in the search because a steep route is just an expensive route.

---

## Primary diagram

```
  BLOCKED as large-finite — full recap

  cost.ts:5   BLOCKED = 1e9  (finite, /** still returned and flagged */)
        │
  cost.ts:18  penalty: g > max → return BLOCKED
        │
  astar.ts:68 tentative = g + length·(1 + BLOCKED)   ← stays FINITE
        │
        ├──► steep-only path:  cost ~1e9·n  → RETURNED, steepEdges flagged
        └──► disconnected:     frontier empties → return NULL (astar.ts:77)

  outcome:  "steep route (honest)"  ≠  "no route"   ← the distinction 1e9 buys
```

---

## Elaborate

"Large finite instead of infinite" is a staple of optimization and
constraint solving — soft constraints in CP/SAT solvers, penalty methods
in numerical optimization, "lexicographic" objectives where you scale one
term to dominate another. The shared idea: keep the math finite so the
solution stays *comparable and returnable*, and let magnitude express
priority. flattr's twist is pairing the finite cost with an explicit
`steepEdges` list so the route can be both returned and honestly labeled.
The failure to avoid is the classic one: using `Infinity` or `null` for a
merely-bad option and thereby collapsing it into "impossible." Read `02`
for the penalty curve this caps, `04` for why the cost must also stay
non-negative.

---

## Project exercises

### EX-05-A — Make the distinction a test

- **What to build:** two tests on a tiny fixture — one where the only
  path is steep (assert a path *is* returned with non-empty `steepEdges`),
  one where start/goal are disconnected (assert `path === null`).
- **Why it earns its place:** locks in the exact behavior `1e9` buys; a
  future refactor to `Infinity` would fail these.
- **Files to touch:** `features/routing/astar.test.ts`,
  `features/routing/fixtures.ts`.
- **Done when:** both tests pass and a comment names the distinction.
- **Estimated effort:** 40 min.

### EX-05-B — Find the overflow ceiling

- **What to build:** a note (or test) computing how many stacked `BLOCKED`
  edges it takes to approach `Number.MAX_SAFE_INTEGER`, documenting the
  headroom that justifies `1e9`.
- **Why it earns its place:** turns "1e9 feels big enough" into a number,
  the kind of justification an interviewer probes for.
- **Files to touch:** a comment in `cost.ts` or a test.
- **Done when:** the headroom is stated explicitly.
- **Estimated effort:** 20 min.

---

## Interview defense

**Q: Why is `BLOCKED` a billion and not `Infinity`?**

Because `Infinity` would make "the only route is steeper than you wanted"
indistinguishable from "there's no route at all" — both come back as an
infinite-cost / null result. With a large *finite* cost, a steep-only
path still has a real total cost, so the search returns it (ranked last)
and flags the steep segments in `steepEdges`. `null` stays reserved for
genuine disconnection. One constant keeps two very different user
messages distinct.

```
  Infinity:  steep-only path = ∞ = "no route"   ✗ (user misled)
  1e9:       steep-only path = ~1e9·n (finite)  ✓ returned + flagged
             disconnected = null                ✓ still distinct
```

**Q: Why `1e9` specifically — isn't that arbitrary?** It needs to
dominate any real distance (so a single blocked edge outweighs detouring
miles) while leaving headroom under `Number.MAX_SAFE_INTEGER` (~9e15) so
summed path costs never lose precision. At `1e9` per blocked edge you'd
need millions in one path to risk overflow — impossible for a real route.
Big enough to win, small enough to stay exact.

**Anchor:** "`BLOCKED = 1e9`, finite on purpose — so 'steep route,
flagged' stays distinct from 'no route' (`null`). It defines the
no-flat-route special case out of the search."

---

## See also

- `02-penalty-as-the-domain-seam.md` — the penalty curve `BLOCKED` caps.
- `04-lazy-deletion-priority-queue.md` — why costs also stay non-negative.
- `audit.md` lens 6 (define-the-error-away), lens 7 (the rationale comment).
