# External Data Trust Boundary

**Industry name(s):** untrusted third-party data ingestion; "the network is
hostile"; input validation at the source boundary. **Type:** Industry standard.

flattr's entire graph is built from data it doesn't own — OSM geometry from
Overpass, elevation from Open-Meteo. This is the boundary where that foreign
data first touches flattr code, and the only validation it gets is a single
±40% grade clamp.

---

## Zoom out — where this lives

This boundary sits at the *top* of the pipeline, build-time or on-device
tile-load. Everything downstream — split, grade, adjacency, routing — trusts
whatever shape these two APIs returned.

```
  Zoom out — the ingestion boundary at the top of the pipeline

  ┌─ PROVIDER (untrusted) ─────────────────────────────────────┐
  │  overpass-api.de            api.open-meteo.com             │
  │  OSM ways + nodes (JSON)    elevation[] (JSON)             │
  └───────────┬──────────────────────────┬─────────────────────┘
       hop 1  │ res.json()        hop 2  │ res.json()
   ┌──────────▼──────────────────────────▼─────────────────────┐
   │ ★ pipeline/ — THE INGESTION BOUNDARY ★   ← we are here     │
   │  overpass.ts:41   parseOsm     elevation.ts:111            │
   │  cast as           (osm.ts)    cast as { elevation:[] }    │
   │  OverpassResponse                                          │
   │       │ skeleton nodes/edges        │ per-node elevation   │
   │       ▼                              ▼                      │
   │  splitWays ──► sampleElevations ──► computeGrades          │
   │                                     (grade.ts:30: ±40% clamp)│
   └────────────────────────────────────────────────────────────┘
                          │ emits Graph → graph.json (→ 02-)
```

The ★ band is the boundary. Once data is past it, every later stage treats it as
ground truth — `computeGrades` divides by `lengthM`, A* runs haversine on
coordinates, the heatmap colors by `gradePct`. Garbage in here is garbage all the
way down.

## Zoom in — the concept

The pattern is **boundary validation at the ingestion seam**: untrusted data
arrives, and *before* it propagates you check its shape and clamp its values. The
question: *which fields does flattr actually validate, and which does it trust
raw?* The answer is uneven — `parseOsm` defends against *missing* data, the grade
clamp defends against *one* out-of-range value, but coordinates and elevation
magnitudes are trusted as-is. → the downstream consequence is `02-`.

---

## The structure pass

**Layers:** (outer) the HTTP response → (middle) the type-cast +
`parseOsm`/`sample` → (inner) `computeGrades` and everything that reads
coordinates.

**Axis traced — `trust`: "is this field validated before it propagates?"**

```
  Trust traced field-by-field across the ingestion boundary

  field                          validated?              where
  ─────────────────────────────  ──────────────────────  ─────────────────
  OSM way.highway kind           YES (whitelist)         osm.ts:20 (WALKABLE)
  OSM way coords count           YES (≥2 required)       osm.ts:23
  OSM node lat/lng VALUES        NO (trusted raw)        osm.ts:8
  Open-Meteo array length        NO (assumed = request)  elevation.ts:111
  Open-Meteo element type        NO (assumed numeric)    elevation.ts:120
  computed gradePct              YES (±40% clamp)         grade.ts:30
  computed lengthM / riseM       NO (derived, unclamped) grade.ts:26-27
```

**The seams:** two of them. `overpass.ts:41` and `elevation.ts:111` are where
bytes become typed objects. The axis-answer is *mostly "NO"* on both sides —
which is exactly why this is a boundary worth studying. The grade clamp at
`grade.ts:30` is the one place the answer flips to "YES," and it only guards a
single derived field.

---

## How it works

### Move 1 — the mental model

You know the loading/success/error triad of a `fetch()`. This is the often-skipped
fourth state: **success-but-wrong**. The request returned 200, `res.json()`
parsed fine, the types compiled — and the data is still garbage (a coordinate
that's `null`, an elevation array one element short, a grade computed over a
sub-DEM baseline that spikes to 800%). Validation is the gate between "the call
succeeded" and "the data is usable."

```
  The pattern: four states, and the one flattr half-handles

   request ──► loading ──► success ──► [ is the SHAPE valid? ]
                   │                          │         │
                   └──► error ◄───────────────┘ NO      │ YES
                        (handled: retry/throw)          ▼
                                                  propagate downstream
                                                  (trusted from here on)

   flattr handles error well (retries). The "is the shape valid?"
   gate is the one that's mostly missing.
```

The kernel: **the seam where a successful response is checked for shape and range
before it's trusted** — and in flattr that gate is partial.

### Move 2 — the walkthrough

**The Overpass cast.** Raw OSM enters here:

```ts
// pipeline/overpass.ts:41
if (res.ok) return (await res.json()) as OverpassResponse;
```

The `as OverpassResponse` is an unchecked promise — same family as `02-`'s graph
cast, one stage upstream. There's *good* defensive work right after, in
`parseOsm`:

```ts
// pipeline/osm.ts
if (!hw || !(hw in WALKABLE)) continue;   // :20 — whitelist highway kinds
...
if (coords.length < 2) continue;          // :23 — drop ways too short to be a segment
```

That whitelist (`config.ts:16`, `WALKABLE`) is real input validation: unknown
highway types are dropped, not trusted. And the coords-count guard prevents
zero-length geometry. **But** the lat/lng *values* themselves
(`osm.ts:8`, `coordsById.set(el.id, { lat: el.lat, lng: el.lon })`) are taken
raw — no check that they're finite, in range, or numeric.

**The Open-Meteo cast.** Elevation enters here:

```ts
// pipeline/elevation.ts:111
json = (await res.json()) as { elevation: number[] };
...
for (const e of json.elevation) out.push(e);   // :120
```

Two unchecked assumptions: that `json.elevation` exists and is an array, and that
its length equals the batch length. The provider batches 100 points per request
(`elevation.ts:85`); the code pushes whatever comes back in order. If the API
returns 99 elevations for 100 points (or `null` for an out-of-coverage point),
the elevations *shift* and every node past the gap gets the wrong neighbor's
elevation — silently. No exception, just wrong grades.

**The one real clamp.** `computeGrades` is where the single value-range check
lives:

```ts
// pipeline/grade.ts
const raw = lengthM > 0 ? (riseM / lengthM) * 100 : 0;   // :28
const gradePct = Math.max(-MAX_GRADE_PCT, Math.min(MAX_GRADE_PCT, raw));  // :30
```

`MAX_GRADE_PCT = 40` (`grade.ts:10`). This is a deliberate, well-reasoned defense:
the comment (`grade.ts:5-9`) explains it clamps coarse-DEM noise — a short edge
straddling an elevation step can compute an absurd grade, so anything past ±40%
is treated as artifact, not terrain. **It's the right call.** But notice its
scope: it clamps the *output* `gradePct`. It does nothing for a `riseM` derived
from a *wrong* (shifted) elevation, and nothing for a NaN coordinate that makes
`lengthM` itself NaN — `lengthM > 0` is `false` for NaN, so `raw` becomes `0`,
hiding the corruption as a flat edge.

```
  Layers-and-hops — a length-100 request, a length-99 reply

  ┌─ Open-Meteo ─┐  hop 1: GET ?latitude=...(100 pts)  ┌─ provider ─┐
  │  request     │ ─────────────────────────────────►  │            │
  │              │  hop 2: { elevation: [...99...] } ◄─ │  (1 point  │
  └──────────────┘                                      │   no cover)│
         │                                              └────────────┘
         ▼  elevation.ts:120 pushes 99 in order
  ┌─ trusted ────────────────────────────────────────────────────┐
  │  node[0..k] correct → node[k+1..99] each gets node[i-1]'s elev│
  │  → computeGrades: wrong riseM → wrong gradePct (within clamp) │
  │  → routes prefer/avoid the wrong streets, silently            │
  └────────────────────────────────────────────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

A complete ingestion-boundary check has three parts; flattr has one and a half:

1. **Shape check** — the response has the expected fields/containers. *Missing →
   the cast at `overpass.ts:41` / `elevation.ts:111` lets a wrong shape through;
   it crashes or corrupts downstream.* (flattr: ✗ for values, partial for OSM
   structure via `parseOsm`.)
2. **Cardinality check** — array lengths match (elevation count == node count).
   *Missing → the silent shift above.* (flattr: ✗.)
3. **Range/clamp check** — values are finite and in domain. *Missing → NaN
   coordinates poison haversine; absurd grades mislead routing.* (flattr: ✓ for
   `gradePct` via the ±40% clamp, ✗ for coordinates and elevation.)

**Skeleton vs hardening:** parts 1–2 are the kernel that keeps corruption from
*propagating*. Part 3's grade clamp is the one piece flattr nailed — and the
template for what the others should look like. The retry/backoff logic in
`overpass.ts:42` and `elevation.ts:114` is *transport* hardening (handles 429/5xx),
not *content* validation — important to separate: retries make the call *succeed
more often*, they do nothing for *success-but-wrong*.

### Move 3 — the principle

A 200 response is a statement about the *transport*, not the *content*. The rule:
**validate the shape and the range of third-party data at the seam where it
enters, because every stage downstream will trust it completely.** flattr proves
the positive case once — the ±40% grade clamp is exactly this discipline applied
to one field — and the fix is to extend that same instinct to coordinates and
elevation cardinality.

---

## Primary diagram

The boundary, both casts, the one clamp, and the two unguarded value paths in
one frame.

```
  External data trust boundary — full picture

  ┌─ PROVIDER (untrusted) ─────────────────────────────────────┐
  │  Overpass: ways+nodes          Open-Meteo: elevation[]      │
  └─────────┬──────────────────────────────┬───────────────────┘
     trust  │ overpass.ts:41        trust   │ elevation.ts:111
     line ..│.. as OverpassResponse  line ..│.. as {elevation:number[]}
            ▼                                ▼
  ┌─ pipeline (trusted after the seam) ────────────────────────┐
  │  parseOsm: ✓ kind whitelist (osm.ts:20)                    │
  │            ✓ coords≥2     (osm.ts:23)                       │
  │            ✗ lat/lng VALUES raw (osm.ts:8)                  │
  │  sample:   ✗ array length unchecked (elevation.ts:120)     │
  │            ▼                                                 │
  │  computeGrades:  riseM/lengthM → ✓ ±40% CLAMP (grade.ts:30) │
  │                  ✗ NaN length → raw=0 (hides corruption)    │
  └───────────────────────────┬────────────────────────────────┘
                              │ → Graph → graph.json → 02-
   fixes: add shape+cardinality checks at both casts; clamp/validate
          coordinates the way gradePct is already clamped.
```

---

## Elaborate

This is the CWE-20 (improper input validation) family applied to *third-party
API responses* rather than user input — a class that's easy to under-weight
because the data "comes from a reputable API." But Overpass and Open-Meteo are
public infrastructure under load; partial responses, coverage gaps (Open-Meteo
returns no elevation for some ocean/edge tiles), and transient malformed payloads
are normal, not adversarial. The grade clamp's *comment* (`grade.ts:5-9`) shows
the author already thinks this way about one failure mode (coarse-DEM noise) — the
finding is that the same rigor didn't reach the cardinality and coordinate
checks. The on-device path makes it sharper: `useTileGraph.ts:191` runs this exact
ingestion live as the user pans, with a `bestEffortElevation` wrapper
(`useTileGraph.ts:20`) that already degrades gracefully to flat-0 on *throw* — but
a *silent* wrong-length array doesn't throw, so it slips past that net. Read next:
`02-` (where this corruption lands), and `study-networking` for the retry/timeout
transport layer that's correctly separated from content validation.

---

## Interview defense

**Q: "What validation does flattr do on the OSM and elevation data?"**

Uneven, and worth ranking. `parseOsm` whitelists highway kinds and drops
too-short ways — real structural validation. The grade computation clamps to ±40%
to kill coarse-DEM noise — real range validation, and the right call. But the
coordinate *values* and the elevation array *length* are trusted raw.

```
  ✓ kind whitelist  ✓ coords≥2  ✓ ±40% grade clamp
  ✗ lat/lng finite  ✗ elevation array length == node count
```

*Anchor:* "It validates shape on OSM and range on grade, but not cardinality on
elevation."

**Q: "What's the worst that a malformed-but-200 response does?"**

A length-99 elevation reply for 100 points shifts every downstream node's
elevation by one, producing wrong grades that pass the clamp — so the app routes
over the wrong streets silently. No crash, no error, just wrong answers. That's
worse than a crash because nobody notices.

*Anchor:* "Success-but-wrong is the state flattr doesn't gate."

**Q: "Why is the grade clamp the right model to copy?"**

It's content validation at the seam — it assumes the source can lie (coarse DEM)
and bounds the value before it propagates. Extending that same instinct to
coordinate finiteness and elevation cardinality closes the boundary.

*Anchor:* "The clamp is the one place flattr does this right — make the rest look
like it."

---

## See also

- `02-unvalidated-artifact-load.md` — where this corruption lands at runtime.
- `03-user-input-to-third-party-url.md` — the boundary in the *outbound*
  direction.
- `audit.md` — lens 1 (trust boundaries), lens 3 (input validation).
- `study-networking` — the retry/backoff transport layer (separate from this).
