# Security — Overview

One page. Where flattr's trust line sits, what crosses it, and what's honestly
absent. Read this, then `audit.md` for the full lens walk.

## The shape of the threat model

flattr is not a server. Hold that thought — it determines everything. There's
no request handler accepting bodies, no database executing queries, no session
cookie to forge, no logged-in user to impersonate. The code is two halves:

- **`pipeline/`** — runs at *build time* (`npm run build:graph`) on your machine,
  or *on-device* inside the app to load map tiles. It turns OSM + elevation into
  a `Graph`.
- **`features/` + `mobile/`** — the *runtime* routing engine and the Expo UI that
  consumes the graph and talks to geocoding.

```
  Two halves, one trust question per half

  ┌─ BUILD-TIME / TILE-LOAD ───────────────────────────────────┐
  │  Overpass ─► parseOsm ─► splitWays ─► sampleElevations      │
  │  Open-Meteo ──────────────────────────► computeGrades       │
  │     trust Q: do I trust the 3rd-party data I just fetched?  │ ← boundary 1
  └────────────────────────────────────────────────────────────┘
                    │ emits graph.json (build) ──────────┐
                    ▼                                     │ boundary 2
  ┌─ RUNTIME (mobile app) ─────────────────────────────────────┐
  │  loadGraph ─► directedAstar ─► routeToGeoJSON ─► <Map/>     │
  │  AddressBar text ─► geocode ─► Nominatim ─► display_name    │ ← boundary 3
  │     trust Q: do I trust the artifact / the geocoder reply?  │
  └────────────────────────────────────────────────────────────┘
```

Every finding in this guide hangs off one of those three boundaries.

## The three live boundaries (ranked)

**Ranked by what an attacker actually reaches.** The verdict-first call:
boundary 2 is the worst because it's the easiest to trip and crashes hardest.

| # | Boundary | Untrusted source | Validation today | Worst case | Severity |
|---|----------|------------------|------------------|-----------|----------|
| 2 | Artifact load | `graph.json` | none (`as unknown as Graph`) | hard crash deep in A* | **High (availability)** |
| 1 | External data | Overpass, Open-Meteo | ±40% grade clamp only | wrong/garbage routes, NaN coords | Medium |
| 3 | Input → 3rd-party URL | typed text + exact GPS | none; React-escaped on render | privacy leak; dormant prompt-injection | Medium (privacy) |

The deep walks live in `01-`, `02-`, `03-`. The full lens-by-lens evidence
(including the absent lenses) lives in `audit.md`.

## What's honestly NOT exercised

Don't pad the audit with vulnerabilities that can't exist here. These lenses
have no surface in flattr today — each with the trigger that would change that:

```
  Absent surfaces — and what activates them

  authn / authz   → no users, no protected resources.
                    TRIGGER: a backend, saved routes, accounts.
  sessions/CSRF   → no cookies, no server-side state.
                    TRIGGER: a login + cookie/session.
  SQL injection   → no database, no query string built anywhere.
                    TRIGGER: persisting routes to a DB.
  XSS (classic)   → React escapes by default; no dangerouslySetInnerHTML,
                    no eval, no innerHTML in the repo.
                    TRIGGER: raw HTML injection of geocoder text.
  server secrets  → keyless free APIs; nothing to leak server-side.
                    GOOGLE_ELEVATION_KEY is build-time env only (run-build.ts:23),
                    never bundled; data/ is gitignored.
  LLM / agent     → no model in the loop yet.
                    TRIGGER: an LLM consuming display_name or route data → 03-.
```

Naming these honestly — with the trigger — is the signal. A "secure because no
attack surface" verdict that can't say *what would create the surface* is
hand-waving. → `audit.md` carries each with `file:line` proof of absence.

## One-line fixes, top three

1. **Validate `graph.json` at load** — a runtime schema check (node refs
   resolve, coords finite, adjacency consistent) at `loadGraph.ts:9` turns a
   deep A* crash into a clean "bad artifact" error. → `02-`.
2. **Clamp/validate coordinates leaving the pipeline** — `parseOsm` and
   `computeGrades` trust lat/lng and elevation blindly past the ±40% grade
   clamp; a NaN or out-of-range coordinate propagates into haversine and A*. → `01-`.
3. **Don't render geocoder `display_name` into any non-escaped sink** — it's
   inert in React today; gate it before it ever reaches an LLM prompt or HTML. → `03-`.
