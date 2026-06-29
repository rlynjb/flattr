# 00 — Overview: the trust axis in flattr

One page. Where untrusted data enters, what trusts it, what breaks if it's
hostile, and the ranked list of what to fix first.

## Zoom out — the whole system on the trust axis

flattr has no users-other-than-you, no server, no stored secrets. So the
classic security questions (*who's logged in? who's allowed? whose data is
this?*) mostly don't apply. The one question that **does** apply, everywhere:
*is this data trustworthy, and what happens when it isn't?*

```
  Trust axis traced across flattr's layers

  ┌─ UI layer (mobile/, React Native) ──────────────────────────┐
  │  TextInput → typed text       ← user-controlled, trusted as  │
  │  map tap → GPS coords           "from our own UI" (it is)    │
  │  renders display_name labels  ← THIRD-PARTY text, escaped    │
  └─────────────────────────┬────────────────────────────────────┘
            user input ─────┤  leaves device → 3rd-party URL
  ┌─ Network boundary ──────▼────────────────────────────────────┐
  │  Nominatim · Overpass · Open-Meteo — keyless free APIs        │
  │  responses re-enter as JSON, minimally validated              │
  └─────────────────────────┬────────────────────────────────────┘
   external data ───────────┤  feeds the pipeline
  ┌─ Pipeline layer (pipeline/) ────────────────────────────────┐
  │  parseOsm → splitWays → sampleElevations → computeGrades      │
  │  ONE guard: ±40% grade clamp (grade.ts:30). No schema check. │
  └─────────────────────────┬────────────────────────────────────┘
   artifact handoff ────────┤  graph.json written / bundled
  ┌─ Routing layer (features/routing/) ─────────────────────────┐
  │  loadGraph() casts graph.json `as Graph` — NO validation     │
  │  A* trusts every field exists and is the right type          │
  └──────────────────────────────────────────────────────────────┘
```

Notice the axis-answer **never flips to "untrusted → rejected."** It flips to
"untrusted → lightly cleaned → trusted." That's the whole finding. There's no
boundary in flattr that *refuses* malformed input; there are boundaries that
*clamp one field* and boundaries that *cast and hope*.

## The verdict, ranked

The teacher's call before the list: **this is an availability and
route-integrity story, not a confidentiality or access-control one.** Nothing
here leaks data or lets an attacker do something as someone else, because there
is no "someone else" and no secret. Rank the exposures by what actually breaks:

```
  Worst → least, by real consequence

  1. graph.json cast `as Graph`            ── crash deep in A*
     (loadGraph.ts:10)                        on any drift/corruption
     → availability. Highest. See 02.

  2. External OSM/elevation, one clamp     ── wrong/unsafe route
     (grade.ts:30, no other validation)       (bad geometry → bad grade)
     → route integrity. See 01.

  3. User input → Nominatim + label back   ── privacy (coords leave device);
     (geocode.ts, MapScreen.tsx)              injection vector IF labels ever
     → privacy + future-LLM seam. See 03.    reach an LLM unframed.

  4-8. authn / authz / session / CSRF /    ── NOT YET EXERCISED.
     SQLi / secrets-in-bundle                  No surface exists. Triggers
     → none today. See audit.md.               named in the audit.
```

## What's genuinely fine here (state it plainly)

- **No secrets to manage.** Overpass, Open-Meteo, and Nominatim are keyless
  free APIs. The only key in the codebase, `GOOGLE_ELEVATION_KEY`, is read from
  `process.env` at *build time only* (`pipeline/run-build.ts:23`), never
  bundled into the app, and the build output dir `data/` is git-ignored
  (`.gitignore`). There is no secret to leak. This is the right posture — don't
  invent a secrets-management story the project doesn't need.
- **Lockfiles present** at both `package-lock.json` and
  `mobile/package-lock.json` — supply chain is pinned.
- **React escapes by default**, so the third-party `display_name` rendered in
  `AddressBar.tsx:23` is not a live XSS today. The risk is *deferred*, not
  present — see `03`.

## How to use this guide

Open `audit.md` for the lens-by-lens walk. Open the three numbered files for
the deep walk on each real boundary. Each pattern file is full
`format.md` shape: zoom out → structure pass → how it works (with the real
file:line) → primary diagram → interview defense.
