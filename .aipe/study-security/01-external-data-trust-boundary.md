# 01 — External-data trust boundary

**Industry name(s):** *untrusted input boundary* / *external data validation at
the trust boundary* (a specific case of the "validate at the edge" rule).
**Type label:** Industry standard.

---

## Zoom out, then zoom in

Okay — pull up the whole pipeline first. flattr never makes up street data. It
asks two third parties: Overpass for OSM way geometry, Open-Meteo for elevation.
Their answers flow through four transforms and become the graph A* routes over.
Here's where that boundary sits:

```
  Zoom out — the external-data boundary in the build/runtime pipeline

  ┌─ Provider layer (third parties, untrusted) ─────────────────┐
  │  Overpass (OSM ways) ──┐        ┌── Open-Meteo (elevation)   │
  └────────────────────────┼────────┼───────────────────────────┘
              raw JSON over │ HTTP   │ raw JSON over HTTP
  ┌─ Pipeline layer ───────▼────────▼───────────────────────────┐
  │  parseOsm → splitWays → sampleElevations → computeGrades     │
  │                                              ★ ±40% clamp ★   │ ← we are here
  │                                                (grade.ts:30)  │
  └────────────────────────┬────────────────────────────────────┘
                  built     │ Graph
  ┌─ Routing layer ────────▼────────────────────────────────────┐
  │  A* trusts every node has finite lat/lng/elevationM          │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The concept is simple and the codebase mostly *skips* it: when
data crosses from a system you don't control into one you do, you validate it
**at the crossing** — before any downstream code assumes it's well-formed. The
question this boundary answers: *can a hostile or corrupt third-party response
make the router crash or produce an unsafe route?* In flattr, the answer is "it
could, except for one clamp." That clamp is the entire defense, and it only
guards one field.

---

## The structure pass

**Layers** (outer → inner): provider (Overpass/Open-Meteo) → pipeline transforms
(`parseOsm` → `splitWays` → `sampleElevations` → `computeGrades`) → routing
(`directedAstar`).

**The one axis: trust.** Trace "is this value trusted, and was it checked?"
down the layers:

```
  Trust traced through the pipeline

  ┌──────────────────────────────────────┐
  │ provider: raw OSM/elevation JSON      │  → UNTRUSTED (third party)
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ parseOsm: filters to walkable     │  → STILL UNTRUSTED, just narrowed
      │   ways, resolves node coords      │     (drops malformed-shape ways,
      │   (osm.ts:5)                      │      but trusts coord values)
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ computeGrades: ±40% clamp     │  → ONE field bounded (gradePct)
          │   (grade.ts:30)               │     lat/lng/elev still trusted raw
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ A*: reads node.lat etc.   │  → FULLY TRUSTED
              └──────────────────────────┘
```

**The seam that's load-bearing:** the provider→pipeline crossing. That's where
trust *should* flip from untrusted to validated. In flattr it flips from
"untrusted" to "lightly narrowed and one-field-clamped" — the contract is
weaker than the boundary needs.

A second seam worth naming: this exact boundary runs at **two lifecycle
points**. Build-time (`pipeline/run-build.ts` → `data/graph.json`) and
**runtime on-device** (`mobile/src/useTileGraph.ts:186` calls `fetchOverpass`
live as you pan/route). Same code, two trust contexts — the runtime one is more
exposed because it fires on every user gesture, not once at build.

---

## How it works

### Move 1 — the mental model

You already do this every time you write a `fetch().then(res => res.json())`
and then *check the shape* before using it — `if (!data.user) return`. That
check is a trust boundary. The pattern here is the same shape: untrusted source
on one side, a validation gate, trusted code on the other. flattr has the
source and the trusted code but a very thin gate.

```
  The pattern: validate at the crossing

   untrusted          ┌─────────────┐         trusted
   source     ─────►  │  validate   │  ─────► consumer
   (3rd party)        │  at the     │         (A* router)
                      │  boundary   │
                      └─────────────┘
                      reject / clamp / coerce
                      BEFORE downstream trusts it

   flattr today:  the gate clamps ONE field (gradePct),
                  passes lat/lng/elevation through raw
```

The kernel of the pattern is: *the consumer never sees a value the gate didn't
vouch for.* flattr violates that for every field except `gradePct`.

### Move 2 — the walkthrough

**Step 1 — the data enters, minimally shape-checked.** `parseOsm`
(`pipeline/osm.ts:5`) is the first touch. It does real defensive work on
*shape*: it indexes node coords, skips ways whose `highway` tag isn't walkable
(`osm.ts:20`), and drops ways with fewer than 2 resolved coords (`osm.ts:22`).

```
  parseOsm — narrows shape, trusts values

  ┌─ Provider ──┐  elements[]   ┌─ parseOsm (osm.ts:5) ──────────┐
  │ Overpass    │ ────────────► │ • map node id → {lat,lng}      │
  │ JSON        │               │ • keep ways with highway∈WALKABLE│
  └─────────────┘               │ • drop ways with <2 coords     │
                                │ • PASS lat/lng THROUGH AS-IS    │ ← values
                                └────────────────────────────────┘   untrusted
```

What it does **not** do: check that `el.lat`/`el.lon` are finite numbers in a
valid range. A coordinate of `NaN`, `null`, or `1e300` from a corrupt response
flows straight through. The consequence is concrete: a `NaN` lat reaches
`haversine` in `grade.ts:13`, `geometryLength` returns `NaN`, and the grade math
silently produces `NaN`. That's the route-integrity failure — not a crash, a
*wrong route* with no signal.

**Step 2 — the one real guard: the grade clamp.** This is the load-bearing
control. `computeGrades` (`pipeline/grade.ts:24`) derives the grade from
elevation delta over length, then bounds it:

```ts
// pipeline/grade.ts:27-31
const riseM = nodes[e.toNode].elevationM - nodes[e.fromNode].elevationM;
const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;        // could be huge
const gradePct = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, raw)); // clamp
return { ...e, lengthM, riseM, gradePct, absGradePct: Math.abs(gradePct) };
```

Line by line: `raw` is the externally-derived grade — if a coarse-DEM elevation
step puts a 30m rise on a 2m edge, `raw` is `1500%`. The clamp at `:30` bounds
it to `±40`. The comment frames this as DEM-noise cleanup (`grade.ts:5-9`), and
it is — but it's *also* the only place external data is bounded before A* trusts
it. Strip this line and a single bad elevation pair gives the cost function a
multi-thousand-percent grade, which the penalty math turns into garbage costs
and A* into nonsense routing.

Note the `lengthM > 0` ternary at `:28` — that's a second tiny guard, against
divide-by-zero on a zero-length edge. Two micro-validations; that's the lot.

**Step 3 — the runtime version is the exposed one.** The same pipeline runs
on-device. `useTileGraph.ts:186-197` fetches Overpass live and builds a graph
per viewport/corridor:

```
  Runtime external-data boundary (useTileGraph.ts)

  ┌─ UI ──────────┐ pan/route  ┌─ Network boundary ──────┐
  │ MapScreen tap │ ─────────► │ fetchOverpass(bbox)     │ untrusted JSON
  └───────────────┘            │ openMeteoProvider(...)  │
                               └───────────┬─────────────┘
                                  buildGraph│ (same pipeline)
                               ┌───────────▼─────────────┐
                               │ bestEffortElevation:    │ on throttle →
                               │   catch → return 0s     │ flat (0m) fallback
                               │   (useTileGraph.ts:20)  │ degraded=true
                               └─────────────────────────┘
```

The runtime path adds one *availability* hardening the build path lacks:
`bestEffortElevation` (`useTileGraph.ts:20`) catches a throttled/failed
elevation call and substitutes flat `0m` elevation rather than failing the whole
build — flagging `degraded` so the UI knows the grades are bogus
(`MapScreen.tsx:377`, "Grades approximate"). That's a deliberate
availability-over-fidelity tradeoff, correctly surfaced to the user. It does
*not* add value-validation; a corrupt-but-200 Overpass response still flows
through unchecked.

### Move 2 variant — the load-bearing skeleton

The irreducible kernel of an external-data boundary:

1. **The crossing point** — one named place where untrusted becomes trusted.
   *Breaks if missing:* validation scatters and some path skips it. flattr's
   crossing is `parseOsm` + `computeGrades`; it's identifiable, which is good.
2. **The value check** — every field the consumer trusts is verified finite /
   in-range / present. *Breaks if missing:* a `NaN`/`null`/out-of-range value
   reaches code that assumes it can't. **This is the part flattr mostly omits**
   — only `gradePct` is bounded.
3. **The reject/coerce decision** — bad data is dropped, clamped, or defaulted,
   never silently trusted. *Breaks if missing:* garbage-in becomes
   garbage-routed with no signal.

**Skeleton vs hardening:** the value check (2) is skeleton. The retry/backoff in
`overpass.ts:42` and `elevation.ts:114`, and the flat-fallback in
`useTileGraph.ts:20`, are *availability* hardening — they keep the app running
under a flaky provider, but they don't make the *data* trustworthy.

### Move 3 — the principle

Validate at the boundary, once, where untrusted becomes trusted — and validate
*every field the consumer trusts*, not just the one that's obviously noisy. A
clamp on `gradePct` proves the team knows the data can be garbage; the gap is
that the same suspicion wasn't extended to `lat`, `lng`, and `elevationM`. The
fix is cheap (a finite/range check in `parseOsm` or a guard in `buildGraph`) and
it converts a silent wrong-route into a caught bad-input.

---

## Primary diagram

The whole boundary, both lifecycles, in one frame.

```
  External-data trust boundary — full recap

  ╔═ UNTRUSTED: third-party providers ══════════════════════════╗
  ║  Overpass (OSM ways)            Open-Meteo (elevation)       ║
  ╚════════╤════════════════════════════════╤═══════════════════╝
   build:  │ run-build.ts            runtime:│ useTileGraph.ts:186
           ▼                                 ▼
  ┌─ PIPELINE (the boundary) ───────────────────────────────────┐
  │  parseOsm (osm.ts:5)   ── shape-narrow, VALUES UNCHECKED     │
  │  splitWays             ── geometric subdivision              │
  │  sampleElevations      ── flat-fallback on throttle (rt only)│
  │  computeGrades (grade.ts:24) ── ★ ±40% clamp = ONLY value    │
  │                                   guard ★ + lengthM>0 ternary │
  └────────────────────────────┬────────────────────────────────┘
                       Graph    │  (NaN/out-of-range CAN pass)
  ╔═ TRUSTED: routing ═════════▼════════════════════════════════╗
  ║  directedAstar — assumes finite lat/lng/elev on every node   ║
  ╚══════════════════════════════════════════════════════════════╝
```

---

## Elaborate

This is the oldest rule in input security: *all input is evil until validated*
(Michael Howard's phrasing). It predates the web — it's why C string functions
that don't bound length are CVE factories. The modern restatement is "parse,
don't validate" (Alexis King): instead of checking a value and passing the
*unchanged untyped* value onward, transform it into a type that *can't represent
the bad state*. flattr's `Graph` type (`features/routing/types.ts`) declares
`lat: number` — but a TypeScript type is a compile-time fiction; `as Graph`
(see `02`) asserts it at runtime without checking. The "parse, don't validate"
move is to run the external data through a real parser (a schema) that *produces*
the typed value, so by the time A* holds a `Node`, the numbers are provably
finite. That's the same fix `02` recommends for the artifact — the two findings
share a root cause: TypeScript types trusted as runtime guarantees.

What to read next: `02` (the artifact version of this same gap), and the
`study-networking` sibling for the fetch posture (retries/timeouts) that sits
*around* this boundary.

---

## Interview defense

**Q: flattr trusts third-party OSM and elevation data. Is that a
vulnerability?** It's a *route-integrity* weakness, not a breach. There's no
attacker-controlled channel into Overpass for a typical user, so the realistic
threat is a *corrupt or malformed* response, not a crafted exploit. The one real
guard is the `±40%` grade clamp at `grade.ts:30`, which bounds the most
volatile derived field. The gap is that `lat`, `lng`, and `elevationM` flow
through `parseOsm` unchecked — a `NaN` coordinate produces a silent wrong route.
The fix is a finite/range check at the crossing.

```
  the sketch I'd draw

  3rd party ──► [parseOsm: shape only] ──► [grade clamp: 1 field]
                                                  │
                  NaN lat slips past ─────────────┘──► silent bad route
                  fix: finite/range check at the crossing
```

**Anchor:** *"The grade clamp at grade.ts:30 is the only value-validation at the
boundary; everything else is shape-narrowing. The fix is to validate the fields
A* actually trusts."*

**Q: The same pipeline runs at runtime on-device. Does that change the risk?**
Yes — it raises the *availability* stakes, because the boundary now fires on
every pan and route, not once at build. That's why the runtime path adds
`bestEffortElevation` (`useTileGraph.ts:20`) — a throttled elevation call
degrades to flat grades instead of crashing the app, with the UI flagging
"grades approximate." That's the right availability tradeoff. It doesn't add
value-validation, so the integrity gap persists at runtime too.

**Q: Where's the load-bearing part people forget?** The *value* check, distinct
from the *shape* check. `parseOsm` does shape (drop malformed ways) well, which
lulls you into thinking input is validated. It isn't — the field values are
still raw. Naming that split (shape ≠ value) is the signal you've actually
thought about the boundary.

---

## See also

- `02-unvalidated-artifact-load.md` — the same trust gap, at the artifact load
  instead of the network fetch. Shares the "TypeScript types ≠ runtime
  guarantees" root cause.
- `03-user-input-to-third-party-url.md` — the *outbound* side of the same
  providers (what leaves the device toward them).
- `audit.md` lens 1, 3 — the boundary map and the injection analysis.
- Siblings: `study-networking` (fetch posture around this boundary),
  `study-data-modeling` (the `Graph` schema this should validate against).
