# Security overview — the whole trust map in one frame

> One-page orientation. The four trust boundaries, what crosses each, and
> the findings ranked by consequence. Open `audit.md` for the lens-by-lens
> walk; open the `01`–`03` files for the deep dives.

## Zoom out — where trust lives in this system

flattr is two programs that share code: a **build-time pipeline** (Node,
runs on your laptop) and a **runtime app** (Expo/React Native, runs on a
phone). The same `pipeline/` modules run in both places — the on-device
tile loader (`useTileGraph.ts`) calls `fetchOverpass` and `buildGraph` live
on the phone, not just at build time. Trust crosses a boundary at every
arrow that leaves the device or enters the engine.

```
  flattr — the trust map (★ = a boundary an attacker can reach)

  ┌─ Third-party providers (NOT trusted — you don't control them) ──────┐
  │  Overpass/OSM    Open-Meteo    Nominatim    OpenFreeMap tiles       │
  └────┬──────────────┬──────────────┬───────────────┬─────────────────┘
   ★ way geometry  ★ elevation    ★ geocode rows   ★ map style/tiles
       │  build & runtime           │  runtime only
  ┌─ Build pipeline (laptop) ───────┼─────────────────────────────────┐
  │  fetchOverpass → parseOsm → split → sampleElevations → computeGrades│
  │                                  │   ★ MAX_GRADE_PCT clamp (the one  │
  │                                  │     sanitizer on external data)   │
  │                          writes data/graph.json (gitignored)         │
  └──────────────────────────────────────────────┬────────────────────┘
                       copy artifact into the app │
  ┌─ Runtime app (phone) ──────────────────────────▼───────────────────┐
  │  loadGraph()  ── as unknown as Graph ──►  routing engine            │
  │     ★ NO runtime validation of the bundled artifact                 │
  │  user types address ──► geocode() ──► ★ leaves device to Nominatim  │
  │  expo-location GPS    ──► reverseGeocode() ──► ★ coordinate leaves   │
  └─────────────────────────────────────────────────────────────────────┘

  NOT PRESENT: auth, accounts, sessions, your own server, a database,
               an LLM/agent layer. Those boundaries don't exist here.
```

## Zoom in — four boundaries, that's the whole surface

Everything an attacker could touch sits on one of four boundaries. Three
are real; the fourth (a server you operate) does not exist, which is itself
the most important security fact about this repo.

```
  Boundary                What crosses it          Trust today
  ──────────────────────  ───────────────────────  ────────────────────
  1. provider → pipeline  OSM ways, DEM elevation   trusted; one clamp
  2. artifact → engine    graph.json (~544 KB)      asserted, not checked
  3. user/GPS → provider  search text, coordinate   encoded; leaves device
  4. attacker → server    (nothing — no server)     not yet exercised
```

## Findings, ranked by consequence (worst first)

This is the verdict-first list. Each ties to a boundary above and to the
lens in `audit.md` that walks it.

**1 — Unvalidated artifact load is the highest-consequence trust gap.**
`mobile/src/loadGraph.ts:9-11` does `return graph as unknown as Graph`. The
cast tells the TypeScript compiler "trust me, this is a Graph" and then
*nothing checks it at runtime*. If `graph.json` ships malformed — a missing
node an edge points to, a `null` where a number belongs, an adjacency entry
referencing a deleted edge — the first reader (`nearestNode`, `directedAstar`)
dereferences `undefined` and the app white-screens with no recoverable
error. Consequence is **availability, not breach**: the artifact is bundled
from your own build, so an attacker can't swap it without already owning the
release. But a single bad build ships a broken app to every user. Deep dive:
`02-unvalidated-artifact-load.md`. Lens: input-validation.

**2 — External map/elevation data drives routing with one clamp as the only
gate.** The build pipeline trusts Overpass geometry and Open-Meteo elevation
wholesale. The *only* sanitizer is `MAX_GRADE_PCT = 40` in
`pipeline/grade.ts:10,30`, which clamps grade so a coarse-DEM spike can't
emit a wall-steep edge. There's no bound on coordinates, no check that an
edge's nodes exist, no NaN guard on elevation. Consequence: **garbage
elevation produces a wrong-but-plausible route**, never a crash at build
time — but a `NaN` elevation would propagate `NaN` grade into the A* cost
and silently break the heuristic's admissibility. Deep dive:
`01-external-data-trust-boundary.md`. Lens: trust-boundaries + input-validation.

**3 — GPS coordinate and search text leave the device to a third party.**
`reverseGeocode(lat, lng)` in `pipeline/geocode.ts:58-70` sends the user's
exact tapped/GPS coordinate to `nominatim.openstreetmap.org`; `geocode`/
`geocodeSuggest` send every typed character (debounced) to the same host.
Consequence: **the user's location and search intent are visible to OSM's
operators and anyone on the network path** (TLS protects transit, not the
endpoint). No consent screen names this beyond the OS location prompt. This
is a privacy-disclosure finding, not a vulnerability. Lens: data-exposure.

**4 — Dependency surface is the Expo/RN/MapLibre tree; both lockfiles
present, no committed secrets.** `mobile/package-lock.json` and root
`package-lock.json` both exist (pinned transitive graph). No `.env` tracked,
no key in source or git history; the Google Elevation key is read from
`process.env.GOOGLE_ELEVATION_KEY` (`pipeline/run-build.ts:23`) at build
time only and never enters the bundle. Consequence: **supply-chain risk is
the standard RN-app risk** — large transitive tree, no automated audit in
CI yet. Lens: dependencies + secrets.

## What is `not yet exercised` (and why)

- **Authentication / authorization** — no users, no login, no protected
  resource. There is nothing to authenticate *to*. Introducing a saved-
  routes backend would create this surface.
- **SQL / command / path injection** — no database, no shell calls, no
  filesystem reads of user input. The only sinks are URLs (handled by
  `URLSearchParams`) and the in-memory graph.
- **CSRF / session fixation / cookie theft** — no sessions, no cookies, no
  server-side state.
- **LLM / agent security** — there is no model, no prompt, no tool-calling
  agent anywhere in the repo. This lens is genuinely empty.

Each of these is walked honestly in `audit.md` with the buildable target
that would introduce the surface.
