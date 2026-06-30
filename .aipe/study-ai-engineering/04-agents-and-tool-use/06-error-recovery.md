# Error recovery — flattr's deterministic error-shape discipline

**Industry name(s):** error recovery (agent) vs deterministic error shaping.
**Type:** Industry standard.

## Zoom out — no agent to recover, but flattr has real, disciplined error shaping

Agent error recovery is about catching the many ways an LLM loop fails —
a tool errors, the model loops on one tool, it emits an invalid call, it
blows the iteration budget — and feeding each failure back so the loop can
adapt. flattr has no loop to recover. But it *does* practice the deeper
discipline underneath agent recovery: **distinct, deterministic error
shapes**. A geocode failure throws; a genuinely impossible route returns
`null`; an only-steep route returns a *path with flags* instead of
failing. Three different failures, three different shapes — on purpose.

```
  Zoom out — flattr's deliberate error shapes

  ┌─ pipeline (geocode) ────────────────────────────────────┐
  │  !res.ok ──► throw Error  (hard failure)     geocode.ts:24│
  │  no rows  ──► return null (soft "not found") geocode.ts:26│
  └────────────────────────────┬─────────────────────────────┘
  ┌─ engine (routing) ─────────▼─────────────────────────────┐
  │  no path        ──► path: null  ("no route at all")  astar│
  │  only-steep path──► path + steepEdges flagged (BLOCKED    │
  │                     stays FINITE so it's still returned)  cost.ts:5│
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** geocode (input) → A* (routing) → summary/UI.
- **Axis — how is failure represented at each layer?** geocode: throw
  (transport error) vs `null` (no match). routing: `path: null` (no route)
  vs a returned path with `steepEdges` flagged (route exists but violates
  the grade preference). Trace "what shape does failure take" and each
  layer has a *distinct, intentional* answer — that's the discipline.
- **Seam:** `cost.ts:5` (`BLOCKED = 1e9`, finite). This is the
  load-bearing seam: keeping `BLOCKED` *finite* is what lets "no flat
  route" return a flagged path instead of collapsing into "no route." A
  single design choice separates two user-facing outcomes.

## How it works

### Move 1 — the mental model

You know good error handling distinguishes *kinds* of failure — a 404 is
not a 500 is not an empty result, and each gets handled differently.
Agent recovery is that idea inside an LLM loop, with extra failure modes
(infinite loops, budget exhaustion). flattr has no loop, but it nails the
core move: every failure mode gets a *distinct shape* so the caller can
respond correctly. The same instinct, in deterministic code.

```
  Pattern — distinct error shapes per failure mode

  geocode:  network bad ─► THROW        (caller must catch)
            no match    ─► null         (caller shows "not found")
  routing:  unreachable ─► path: null   ("no route")
            only steep  ─► path + flags  ("flattest available, ⚠")
            ▲ BLOCKED finite (cost.ts:5) makes this case possible
```

### Move 2 — the walkthrough

**Geocode shapes two failures differently.** `geocode.ts:24–26`:

```ts
if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);  // transport: THROW
const rows = (await res.json()) as NominatimRow[];
if (!rows.length) return null;                                   // no match: NULL
```

A transport failure (`!res.ok`) throws — the caller *must* handle it, it's
exceptional. An empty result returns `null` — a normal "nothing matched,"
handled inline. Two failure modes, two shapes, so the caller never
confuses "the network broke" with "no such place."

**Routing shapes "no route" vs "no flat route" differently — via finite
BLOCKED.** `cost.ts:5`:

```ts
/** Large but FINITE, so an only-steep path is still returned and flagged. */
export const BLOCKED = 1e9;
```

This is the cleverest piece. If `BLOCKED` were `Infinity`, an over-max
edge would be untraversable and an only-steep route would come back as
`path: null` — indistinguishable from "no route exists." By keeping it
*finite but huge*, A* will still traverse a steep edge as a last resort,
return the path, and flag it in `steepEdges` (`Path.steepEdges`). So the
UI can say "this is the flattest available, ⚠ N steep blocks" instead of
"no route." Two genuinely different user situations, separated by one
constant's value.

```
  Layers-and-hops — finite BLOCKED separates two outcomes

  ┌─ engine ──┐ over-max edge   ┌─ cost.ts ──────────────┐
  │astar.ts   │ ───────────────►│ penalty → BLOCKED (1e9) │ cost.ts:5
  │           │                 │ FINITE → still traversable│
  └───────────┘                 └──────────┬───────────────┘
        hop: path WITH steepEdges flagged   ▼
  ┌─ UI ──────┐ ◄───────────────────────────┘
  │SummaryCard│ "flattest available, ⚠" — NOT "no route"
  └───────────┘   (Infinity here would collapse this to path:null)
```

**The boundary condition.** The discipline only holds if these shapes stay
distinct. If `BLOCKED` ever became `Infinity`, you'd lose the "no flat
route" vs "no route" distinction; if geocode returned `null` on transport
errors instead of throwing, callers would silently treat outages as "no
match." Each shape is load-bearing — the error model *is* the contract.

### Move 3 — the principle

The heart of good error handling — agent or not — is that different
failures must be *distinguishable*, so the caller can respond
appropriately. Agents add recovery *loops* on top (retry, reprompt, force
a different tool, hard-stop on budget); flattr's deterministic code gets
the foundation right without a loop: throw vs null vs flagged-path, and a
finite `BLOCKED` that turns "constraint unsatisfiable" into "best-effort +
honest flag." The principle: shape your errors so each failure mode is a
different, intentional value — recovery logic is only as good as the
distinctions it can see.

## Primary diagram

```
  flattr's error-shape contract (deterministic recovery foundation)

  ┌─ geocode (pipeline/) ────────────────────────────────────┐
  │ !res.ok → THROW (transport)   ·   no rows → null (no match)│ geocode.ts:24-26
  └────────────────────────────┬─────────────────────────────┘
  ┌─ routing (features/) ──────▼─────────────────────────────┐
  │ no path → path: null ("no route")                         │
  │ only steep → path + steepEdges flagged ("flattest, ⚠")    │
  │ ★ BLOCKED = 1e9 FINITE (cost.ts:5) makes the split possible│
  └────────────────────────────┬─────────────────────────────┘
  ┌─ UI ───────────────────────▼─────────────────────────────┐
  │ RouteSummaryCard renders the right message per shape      │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Agent error recovery is a real production concern — agents fail in more
ways than chains (loops, budget blowouts, invalid calls), and without
explicit recovery they burn tokens silently. flattr can't exercise that,
but it demonstrates the discipline that recovery *depends on*: making
failure modes distinguishable by shape. The finite-`BLOCKED` trick is a
small, sharp example of error-shape design — one constant's value
determines whether the user sees "no route" or "best-effort, here's the
catch." That instinct transfers directly to designing what an agent's tool
returns on failure.

## Project exercises

### B-ERR.1 — pin the error-shape contract with tests

- **Exercise ID:** B-ERR.1
- **What to build:** tests asserting the three distinct shapes — geocode
  throws on `!res.ok`, returns `null` on no match; routing returns
  `path: null` when unreachable and a flagged path (non-empty
  `steepEdges`) when only a steep route exists — and a test that fails if
  `BLOCKED` becomes non-finite.
- **Why it earns its place:** it makes the (real) error-shape discipline a
  guarded contract instead of an implicit convention.
- **Files to touch:** `pipeline/geocode.test.ts`;
  `features/routing/cost.test.ts` (assert `BLOCKED` finite);
  `features/routing/astar.test.ts` (null vs flagged-path cases).
- **Done when:** changing any error shape (e.g. `Infinity` BLOCKED) breaks
  a test.
- **Estimated effort:** two to three hours.

## Interview defense

**Q: How does flattr handle errors — does it need agent-style recovery?**
Answer: no loop to recover, but it has disciplined error *shaping*.
Geocode throws on transport failure (`geocode.ts:24`) but returns `null`
on no match (`:26`) — two distinct shapes. Routing returns `path: null`
for a genuinely unreachable goal, but for an only-steep route it returns a
path with `steepEdges` flagged. The load-bearing trick is `BLOCKED = 1e9`
*finite* (`cost.ts:5`): keep it finite and A* still returns the steep
path to flag, so "no flat route" stays distinct from "no route." Change it
to `Infinity` and those two collapse. The point: recovery is only as good
as the failure distinctions you encode — flattr encodes them precisely.

```
  throw vs null vs flagged-path; finite BLOCKED splits "no flat" from "no route"
```

Anchor: *"flattr's recovery discipline is deterministic error shapes — a
finite BLOCKED lets it return the flattest-available route flagged,
instead of failing as 'no route'."*

## See also

- [01-agents-vs-chains.md](01-agents-vs-chains.md) — the chain whose errors these shape.
- [04-tool-routing.md](04-tool-routing.md) — `BLOCKED` finite is also an A*-admissibility constraint.
- [../06-production-serving/03-prompt-injection.md](../06-production-serving/03-prompt-injection.md) — geocode's untrusted output is a separate failure surface.
