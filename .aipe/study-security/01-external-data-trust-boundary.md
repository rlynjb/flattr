# External-data trust boundary

**Industry name:** trust boundary / data-source trust (Industry standard).
Also "the build pipeline trusts its inputs." Project-specific instance: OSM
geometry + DEM elevation flowing into a routing graph through one clamp.

---

## Zoom out, then zoom in

Okay — here's the whole thing. flattr never invents map data. Every street
and every elevation comes from a service it doesn't own, gets parsed into a
graph, and that graph decides which way to send a person walking. The
security question isn't "can someone hack the server" (there's no server) —
it's "what happens when the data those services return is wrong, and where
does the code decide to trust it anyway?"

```
  Zoom out — where the trust boundary sits

  ┌─ Provider layer (UNTRUSTED — you don't control it) ─────────────┐
  │  Overpass/OSM (way geometry)     Open-Meteo (elevation meters)  │
  └───────────────┬──────────────────────────┬─────────────────────┘
        way nodes  │              elevation[] │   ← trust boundary
  ┌─ Build pipeline (trusted code) ───────────▼─────────────────────┐
  │  parseOsm → splitWays → sampleElevations → computeGrades         │
  │                                            ★ MAX_GRADE_PCT clamp │ ← we are here
  │                                              (the ONE sanitizer) │
  └───────────────────────────────┬─────────────────────────────────┘
                       graph.edges │  gradePct drives cost
  ┌─ Routing engine (trusts the graph fully) ──▼─────────────────────┐
  │  cost.ts penalty() → A* picks the route                          │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in: a **trust boundary** is the line where data you don't control
enters code you do. The discipline is "every input is hostile until proven
otherwise." flattr proves *one* thing about its external data — that grade
stays within physical bounds — and trusts everything else. This file walks
where that single proof lives, what it catches, and the one input shape it
silently lets through.

---

## Structure pass — the trust axis across the pipeline

Trace one question down the pipeline: **what does each stage trust about the
data it receives?** The answer flips exactly once, and that flip is the
whole lesson.

```
  One question down the stack: "is this data trusted as-is?"

  ┌──────────────────────────────────────────────┐
  │ parseOsm (osm.ts)        coords trusted as-is │  → TRUSTS (no range check)
  └──────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ sampleElevations         meters trusted   │  → TRUSTS (no NaN guard)
      └──────────────────────────────────────────┘
          ┌──────────────────────────────────────┐
          │ computeGrades            CLAMPS grade │  → CHECKS (the one seam)
          └──────────────────────────────────────┘
              ┌──────────────────────────────────┐
              │ cost.penalty()      grade trusted │  → TRUSTS (assumes clamped)
              └──────────────────────────────────┘

  the answer is "trusted" everywhere except computeGrades — that's the seam
```

- **Layers:** provider → parse → elevation → grade → cost.
- **Axis:** trust ("is this value validated before I act on it?").
- **Seam:** `computeGrades`. It's the *only* place the answer flips from
  "trust" to "check." Everything upstream of it trusts coordinates; the cost
  function downstream trusts that grade is already sane. So the clamp at this
  one seam is load-bearing for the entire engine's correctness — and its blind
  spot (NaN) is load-bearing for the engine's failure.

---

## How it works

### Move 1 — the mental model

You already know the shape from any `fetch().then(res => res.json())`: you
get back data you didn't author, and the question is what you check before
you use it. A trust boundary is exactly that, drawn explicitly — a line with
"untrusted" on one side and "trusted" on the other, and a gate on the line.

```
  The pattern — a gate on the trust line

   UNTRUSTED side                  │ gate │      TRUSTED side
   ────────────────                ────────      ──────────────
   external response  ──value──►  [ validate ] ──►  used as fact
                                       │
                                  rejects / clamps
                                  what's out of bounds
```

The skeleton of "trust boundary" is three parts: a **source** (untrusted), a
**gate** (validates/clamps/rejects), and a **sink** (acts on the value as
true). Drop the gate and the sink acts on hostile data directly.

### Move 2 — the walkthrough

**The source: OSM ways and DEM elevation.** `parseOsm` bridges from the
`fetch` you know — it takes the Overpass JSON and pulls `el.lat`, `el.lon`,
and `el.tags.highway` into the graph. What concretely happens: nothing is
range-checked. A coordinate of `(999, 999)` would sail straight in. The only
filter is "is this a walkable highway type?" — a *feature* filter, not a
*safety* filter. Where it breaks: if Overpass returned a way referencing a
node id it never sent, the coord lookup misses and that point is silently
dropped — graceful, but it means the pipeline trusts Overpass to be internally
consistent.

```
  Source stage — what gets trusted

  Overpass JSON ──► parseOsm ──► RawWay { coords: [{lat,lng}, ...] }
                       │
                       └─ filters by highway type (feature gate)
                          does NOT bound lat/lng (no safety gate)
```

**The blind input: elevation.** `sampleElevations` asks the provider for one
number per node and writes it onto the node as `elevationM`. Bridge from a
`.map()` that assumes every element is a number: that's exactly the
assumption here. What happens if Open-Meteo returns `null` for a point (it
can, for ocean or out-of-coverage cells)? `null` flows in as the elevation,
and now a node carries a non-number where the cost math expects meters.

**The gate: `computeGrades` and the clamp.** This is the seam. For each edge
it computes `riseM = toElevation − fromElevation`, divides by length to get
raw grade percent, and then clamps:

```
  Gate stage — the one sanitizer (pseudocode)

  for each edge:
    riseM   = elevation[toNode] − elevation[fromNode]   // delta in meters
    raw     = lengthM > 0 ? (riseM / lengthM) * 100 : 0  // grade percent
    gradePct = clamp(raw, −MAX_GRADE_PCT, +MAX_GRADE_PCT) // ← the gate
    absGradePct = abs(gradePct)
```

Why the clamp exists and what it catches: the free 90 m DEM is coarse, so a
short edge straddling an elevation step can compute a physically impossible
grade (a "wall"). The clamp says "anything past 40 % is coarse-DEM noise, not
real terrain" and pins it. Concrete consequence: a noisy 200 % grade becomes
40 %, so A* sees a steep-but-finite edge instead of a nonsense one, and the
route stays sane.

**The blind spot the gate misses.** Here's the part everyone trips on:
`clamp` is `Math.max(−40, Math.min(40, raw))`. If `raw` is `NaN` — which it
is the moment elevation was `null`, because `null − number` is `NaN` — then
`Math.min(40, NaN)` is `NaN` and `Math.max(−40, NaN)` is `NaN`. **The clamp
does not catch `NaN`.** A NaN grade flows to the sink.

```
  Where the gate leaks — NaN walks through the clamp

  elevation = null                       (Open-Meteo out-of-coverage)
       │
  riseM = null − 12   ─────────────────► NaN
       │
  raw  = NaN / lengthM * 100 ──────────► NaN
       │
  clamp: Math.max(−40, Math.min(40,NaN)) ─► NaN   ← passes through!
       │
  gradePct = NaN ──► cost.penalty(NaN, max) ──► NaN cost
```

**The sink: the cost function.** `penalty(g, max)` in `cost.ts` assumes `g`
is a real number in `[−40, 40]`. Feed it `NaN` and every comparison
(`g <= 0`, `g > max`) is `false`, so it falls to the quadratic branch and
returns `NaN`. The edge cost becomes `lengthM * (1 + NaN) = NaN`. Concrete
consequence: A*'s priority queue starts comparing `NaN` distances, the
admissible-heuristic invariant the whole router depends on is void, and the
route is either wrong or "no route" with no error explaining why.

### Move 3 — the principle

A trust boundary is only as strong as the *shape* of input its gate
anticipates. The `MAX_GRADE_PCT` clamp is a real, deliberate gate — it
defends against the failure mode the author saw (coarse-DEM grade spikes).
But it validates the *magnitude* of a number while assuming the value *is* a
number. The general lesson: validate the type/finiteness at the boundary
*before* you validate the range, because every range check silently passes
`NaN`. "Clamp the value" and "confirm it's a value" are two different gates.

---

## Primary diagram

The full picture: untrusted providers on top, the one gate in the middle,
the engine that trusts the gate's output on the bottom — with the NaN leak
drawn as the gap.

```
  External-data trust boundary — full frame

  ┌─ UNTRUSTED: provider layer ─────────────────────────────────────┐
  │  Overpass ways          Open-Meteo elevation (can be null)       │
  └──────┬───────────────────────────────┬──────────────────────────┘
         │ coords (unbounded)             │ meters (or null)
  ═══════╪═══════════════ TRUST BOUNDARY ═╪══════════════════════════
  ┌─ TRUSTED: build pipeline ─────────────▼──────────────────────────┐
  │  parseOsm ──► splitWays ──► sampleElevations ──► computeGrades    │
  │  (no range    (no check)     (no NaN guard)       │               │
  │   check)                                          ▼               │
  │                                  clamp(raw, −40, +40)  ← THE GATE │
  │                                  catches: DEM spikes  ✓           │
  │                                  misses:  NaN         ✗ leaks ──┐ │
  └──────────────────────────────────────────────────────────────┼─┘
                                          gradePct (maybe NaN)     │
  ┌─ ENGINE: trusts grade is sane ─────────────────────────────────▼┐
  │  cost.penalty(gradePct, userMax) ──► edge cost ──► A* route      │
  │  consequence of NaN: cost = NaN → heuristic void → wrong/no route│
  └───────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** This boundary is crossed twice: at build time
(`pipeline/run-build.ts` fetches the Capitol Hill bbox once, writes
`graph.json`) and **at runtime on the phone** — `mobile/src/useTileGraph.ts:108-112`
calls `fetchOverpass` and `buildGraph` live as the user pans, so the same
trust boundary is crossed on-device every time a new tile loads. The runtime
path even has a deliberate degradation: `bestEffortElevation`
(`useTileGraph.ts:18-28`) catches an elevation failure and returns `0` for
every point so the streets still render. That's a trust *decision*: "coverage
over fidelity." It also means a throttled Open-Meteo silently yields a
flat-graph route.

```
  pipeline/grade.ts  (lines 24–33) — the gate

  const lengthM = geometryLength(e.geometry);              ← edge length, meters
  const riseM = nodes[e.toNode].elevationM                 ← elevation delta…
              − nodes[e.fromNode].elevationM;              ←   null here → NaN
  const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;   ← grade %; NaN if rise NaN
  const gradePct = Math.max(-MAX_GRADE_PCT,                ← THE CLAMP
                     Math.min(MAX_GRADE_PCT, raw));        ←   Math.min(40,NaN)=NaN
  return { ...e, lengthM, riseM, gradePct,                 ← NaN passes through
           absGradePct: Math.abs(gradePct) };              ←   Math.abs(NaN)=NaN
       │
       └─ MAX_GRADE_PCT (line 10) = 40. This catches coarse-DEM grade
          spikes (load-bearing for route sanity) but NOT non-finite
          elevation — Math.max/Math.min propagate NaN unchanged. Without
          the clamp, a DEM step emits a wall-steep edge; with it, NaN still
          leaks to the cost function.
```

```
  pipeline/osm.ts  (lines 12–22) — the unguarded source

  if (el.type !== "way") continue;
  const hw = el.tags?.highway;
  if (!hw || !(hw in WALKABLE)) continue;     ← FEATURE gate (walkable?), not safety
  for (const nodeId of el.nodes) {
    const c = coordsById.get(nodeId);
    if (c) coords.push(c);                     ← drops dangling refs (graceful)
  }
  if (coords.length < 2) continue;             ← needs a segment
       │
       └─ lat/lng are never range-checked. The pipeline trusts Overpass to
          return real coordinates. A garbage coordinate produces a garbage
          edge, not a crash — until it reaches haversine/grade math.
```

```
  features/routing/cost.ts  (lines 16–22) — the trusting sink

  export function penalty(g, max, k1, k2) {
    if (g <= 0) return 0;            ← NaN <= 0 is false
    if (g > max) return BLOCKED;     ← NaN > max is false → falls through
    const half = 0.5 * max;
    if (g <= half) return k1 * g;    ← NaN <= half is false → falls through
    return k2 * (g - half) ** 2 + k1 * half;  ← returns NaN for NaN g
  }
       │
       └─ penalty() assumes g ∈ [−40,40]. It has no NaN branch because the
          author trusts computeGrades to deliver a clamped number. The two
          modules form the contract; the contract has a NaN-shaped hole.
```

**The fix, named:** add a finiteness guard at the gate, not the sink —
`const safeRise = Number.isFinite(riseM) ? riseM : 0;` in `computeGrades`
before dividing, or reject the build if elevation contains non-finite values.
Validating finiteness *before* clamping closes the leak the range-clamp can't.

---

## Elaborate

The "validate at the boundary" discipline comes from the same place as input
sanitization in web apps: the moment data crosses from a system you don't
control into one you do, you either prove a property about it or you inherit
its bugs as yours. The twist here is that the *injection* surface is clean
(no SQL, no shell — the data feeds an in-memory graph, not a query), so the
risk isn't code execution; it's **silent correctness corruption**. That's the
more common real-world trust-boundary failure: not an exploit, but garbage
flowing in and producing confidently-wrong output.

The `bestEffortElevation` wrapper (`useTileGraph.ts:18`) is worth dwelling on
as a *deliberate* trust tradeoff. It chooses availability over fidelity — a
classic CAP-flavored call. Connect it to `.aipe/study-system-design/`'s
treatment of degradation, and to `.aipe/study-networking/` for why the 429
backoff exists in the first place. What to read next: the artifact-load
boundary (`02-unvalidated-artifact-load.md`), which is the *same* trust gap
with even less of a gate.

---

## Interview defense

**Q: Walk me through where untrusted data enters this system and how it's
validated.** It enters at the build pipeline from Overpass and Open-Meteo
— neither of which I control. The one validation gate is `MAX_GRADE_PCT` in
`grade.ts`, which clamps grade to ±40 % to kill coarse-DEM noise spikes.
Everything else — coordinates, elevation finiteness — is trusted. The honest
gap: the clamp validates magnitude but assumes the value is a finite number,
so a `null` elevation becomes `NaN` and walks straight through `Math.max/min`
into the cost function.

```
  null elevation ─► NaN rise ─► NaN grade ─► clamp passes it ─► NaN cost
                                              (Math.min(40,NaN)=NaN)
```

*Anchor:* "the clamp checks range, not finiteness — that's the leak."

**Q: There's no auth, no DB. So is there any real security concern?** Yes —
just not breach-shaped. The concern is a trust boundary that corrupts
correctness and availability. External data drives routing through one clamp;
a malformed bundled artifact crashes the app. The skeleton part people forget
here is that **a trust boundary needs a gate even when there's no attacker** —
the "attacker" is just bad upstream data.

```
  source (untrusted) ─► [ GATE ] ─► sink (trusts it)
                          ▲
                  missing/weak gate = corruption, not breach
```

*Anchor:* "no server doesn't mean no trust boundary — the providers are the
boundary."

---

## Validate

**Reconstruct.** From memory, draw the three-part trust-boundary skeleton
(source / gate / sink) and place `parseOsm`, `computeGrades`'s clamp, and
`cost.penalty` on it. Name `pipeline/grade.ts:30` as the gate line.

**Explain.** Why does `MAX_GRADE_PCT = 40` (`grade.ts:10`) catch a coarse-DEM
spike but not a `null` elevation? (Because `Math.max/Math.min` propagate
`NaN`; the clamp bounds magnitude, not finiteness.)

**Apply to a scenario.** Open-Meteo returns `null` for a coastal node. Trace
the value from `sampleElevations` (`elevation.ts:32`) through
`computeGrades` (`grade.ts:27`) to `penalty` (`cost.ts:16`). At which line
does it become `NaN`, and at which line does the clamp fail to stop it?

**Defend the decision.** The author put the one gate at `computeGrades`
rather than at `sampleElevations`. Argue for moving the finiteness check
upstream to `sampleElevations` (`elevation.ts:32`) vs adding it inline at
`grade.ts:27`. Which keeps the cost contract cleanest?

---

## See also

- `02-unvalidated-artifact-load.md` — the same trust gap at the
  artifact→engine boundary, with no gate at all.
- `03-user-input-to-third-party-url.md` — the user-side of the provider
  boundary (search text out, not data in).
- `audit.md` lens 1 (trust-boundaries) and lens 3 (input-validation).
- `.aipe/study-networking/` — the 429 backoff and retry behavior on these
  same outbound calls.
- `.aipe/study-data-modeling/` — the `Node`/`Edge`/`Graph` schema this data
  is shaped into.
