# Security audit — the 8-lens walk (Pass 1)

> Every lens, checked against this repo. Each `##` section names what the
> code actually does with `file:line` grounding, or emits `not yet
> exercised` and says what would introduce the surface. Significant
> findings cross-link to a Pass 2 pattern file. The capstone lens
> (`security-red-flags-audit`) is a consolidated checklist.

The through-line: trace the trust axis across every boundary — where does
untrusted input enter, who's allowed past, what's hidden vs exposed, what do
the dependencies let in.

---

## 1. Trust boundaries and attack surface

This is the zoom-out lens. flattr has exactly four boundaries; three carry
real trust decisions and one (a server you operate) does not exist.

**Boundary A — third-party providers → build pipeline.** The pipeline pulls
street geometry from Overpass (`pipeline/overpass.ts:4`,
`https://overpass-api.de/api/interpreter`) and elevation from Open-Meteo
(`pipeline/elevation.ts:106`) or Google Elevation (`:72`). These responses
are parsed and trusted: `parseOsm` (`pipeline/osm.ts:5-25`) reads
`el.lat`/`el.lon`/`el.tags.highway` straight into the graph with no range
check. The trust assumption: *OSM returns well-formed coordinates and
Open-Meteo returns real meters.* If that's wrong, you get a wrong graph, not
a crash — except for `NaN`/`null` elevation, which propagates (see lens 3).
→ deep walk in `01-external-data-trust-boundary.md`.

**Boundary B — bundled artifact → routing engine.** `mobile/src/loadGraph.ts:9-11`
loads `assets/graph.json` and casts it `as unknown as Graph` with no runtime
validation. This is the single highest-consequence boundary in the runtime.
→ deep walk in `02-unvalidated-artifact-load.md`.

**Boundary C — user/GPS → third-party provider.** Typed search text and the
device GPS coordinate cross out to Nominatim
(`pipeline/geocode.ts:21,47,64`). The user controls the input; the question
is whether it's safely encoded (yes) and whether it leaks (it leaves the
device — see lens 5). → deep walk in `03-user-input-to-third-party-url.md`.

**Boundary D — attacker → your server.** `not yet exercised` — there is no
server. The app reads a static bundled artifact and talks directly to public
third-party APIs. Nothing you run accepts an inbound request. **Red flag
checked:** no input is treated as trusted because it "comes from our own
frontend," because there is no backend to receive it.

---

## 2. Authentication and authorization

`not yet exercised`, and honestly so.

There are no accounts, no login, no sessions, no tokens identifying a user,
and no protected resource. `grep` for `auth|session|login|token|jwt|cookie`
across `mobile/src` and `pipeline` returns only the Google *API* key
(machine credential, not a user identity) and the User-Agent header strings.
The app is a single-purpose viewer over a bundled graph plus public APIs.

**What would introduce it:** the spec's "saved routes" or "share a route"
feature (`docs/flattr-spec.md`) would need a backend, which would need
who-are-you (authn) and, the moment one user's routes must stay private from
another's, what-can-you-do (authz). The classic gap to watch for then:
adding authn (a login) but assuming authz (checking logged-in but not that
*this* user owns *this* route). Today neither exists, so neither can be wrong.

---

## 3. Input validation and injection

Two sub-findings: the URL sink (safe) and the data sink (partially gated).

**URL construction is safe.** Every outbound URL built from user or computed
input uses `URLSearchParams` or `encodeURIComponent`, which percent-encode
metacharacters:

- `pipeline/geocode.ts:14` — `new URLSearchParams({ q: query, ... })`. A
  search like `&limit=999` or `Seattle#frag` is encoded into the `q` value,
  not interpreted as extra params. No query-injection into the Nominatim
  request.
- `pipeline/overpass.ts:30` — `"data=" + encodeURIComponent(buildOverpassQuery(bbox))`.
  The bbox is numeric (typed `[number, number, number, number]`), so even
  the Overpass-QL body can't be poisoned with user text.
- `pipeline/elevation.ts:72` — Google locations go through
  `encodeURIComponent`. The Open-Meteo URL (`:106`) interpolates lat/lng
  directly, but those are `number`s from typed points, not strings, so
  there's no string to inject. → `03-user-input-to-third-party-url.md`.

**Data validation is the gap.** The *injection* surface is clean; the
*validation* surface is thin. External elevation and OSM geometry enter the
graph with one clamp (`MAX_GRADE_PCT`, `pipeline/grade.ts:10,30`) and no
NaN/range guard, and the bundled artifact enters with zero checks
(`loadGraph.ts:10`). A `null` elevation from Open-Meteo becomes `NaN` riseM
becomes `NaN` gradePct — which the clamp does *not* catch (`Math.max/min`
with `NaN` returns `NaN`), and `NaN` then poisons the A* cost. **Red flag
checked:** no string-built query or prompt with user input — the only
string-built thing (Overpass QL) takes numbers only. → both data findings
deep-walked in `01-external-data-trust-boundary.md` and
`02-unvalidated-artifact-load.md`.

---

## 4. Secrets and configuration

Clean. The one machine credential is handled correctly.

- **No secret in source.** `pipeline/config.ts` holds a bounding box and a
  walkable-highway map — no keys. `grep -i "api.key|secret|token|password|AIza"`
  over tracked files hits only the `apiKey` *parameter name* in
  `googleProvider(apiKey, ...)` (`pipeline/elevation.ts:65`) and the test's
  literal `"KEY"` placeholder (`pipeline/elevation.test.ts:33`).
- **The Google key is env-only, build-time-only.** `pipeline/run-build.ts:23`
  reads `process.env.GOOGLE_ELEVATION_KEY`. It's used inside the Node build
  process to fetch elevation and is *never* imported into `mobile/`, so it
  cannot reach the client bundle. The default path is keyless Open-Meteo
  (`:32`), so most builds use no secret at all.
- **No secret in git history.** `git log --all -S GOOGLE_ELEVATION_KEY`
  surfaces no literal key value; no `.env` file is tracked
  (`git ls-files | grep -i env` is empty); `mobile/.gitignore` excludes
  `.env*.local`, `*.jks`, `*.p8`, `*.p12`, `*.key`, `*.pem`.
- **The build output is gitignored.** Root `.gitignore` lists `data/`, where
  `run-build.ts:48` writes `graph.json` — so a freshly built graph (which
  could in theory be derived with the paid key) isn't committed from the
  build dir.

**Red flag checked:** no secret in source, in a client bundle, or in logs.
The one log line that mentions the key (`run-build.ts:25`) prints
`"Elevation: Google Elevation API (paid)."` — it announces the *mode*, not
the key value. Good hygiene.

**One note, not a finding:** `mobile/assets/graph.json` (544 KB) *is*
committed and *is* bundled. It's public street + elevation data, not a
secret — but it's worth knowing it ships in the app and is world-readable
once installed.

---

## 5. Data exposure and privacy

This is where the real (modest) exposure lives. Not a breach — a disclosure.

**The GPS coordinate leaves the device.** `MapScreen.tsx:92-94` requests
foreground location and reads `pos.coords.{latitude,longitude}`. When the
user taps the map with a field focused, `handleMapPress`
(`MapScreen.tsx:229`) calls `reverseGeocode(lat, lng)`, which sends the
exact coordinate to `nominatim.openstreetmap.org/reverse`
(`geocode.ts:58-70`). The consequence: **the user's precise location is
disclosed to OSM's Nominatim operators**, governed by their privacy policy,
not yours. TLS protects the coordinate in transit; it does not hide it from
the endpoint.

**Search text leaves the device per keystroke (debounced).** `scheduleSuggest`
(`MapScreen.tsx:70-86`) fires `geocodeSuggest(text, ...)` 400 ms after typing
stops, for any input ≥ 3 chars. Every partial query the user types is sent to
Nominatim. Consequence: **the user's search intent (where they're trying to
go) is visible to a third party.** Reasonable for a free OSM-backed app, but
no in-app disclosure names it beyond the OS-level location permission string
(`app.json:29`, "flattr uses your location to center the map where you are.")
— which describes centering, not the reverse-geocode round-trip.

**Error messages don't over-share.** Route failures surface generic strings
— `"From not found"`, `"Lookup failed — try again"`
(`MapScreen.tsx:175,195`) — never raw exception text or provider response
bodies. Catch blocks swallow detail (`geocode` suggest: `catch {}` at
`:82`). No stack traces reach the UI. **Red flag checked:** no API response
returns more than the caller is entitled to — there is no API of yours to
over-fetch from.

**What would tighten it:** a one-time in-app notice that searches and
location are sent to OpenStreetMap; or proxying geocode through your own
server so the user's coordinate is disclosed to *you* under *your* policy
rather than directly to OSM. The second creates Boundary D and its own auth
question — a deliberate tradeoff, not a free win.

---

## 6. Dependencies and supply chain

Standard React-Native-app posture: large tree, lockfiles present, no audit
automation yet.

- **Both lockfiles exist.** Root `package-lock.json` (76 KB) and
  `mobile/package-lock.json` (235 KB) pin the full transitive graph, so
  installs are reproducible and a transitive package can't silently float to
  a malicious version.
- **The runtime deps are the usual RN stack** (`mobile/package.json:5-13`):
  `expo ~56`, `react-native 0.85.3`, `react 19.2.3`,
  `@maplibre/maplibre-react-native ^11.3.4`, `expo-location ~56.0.18`,
  `@react-native-community/slider 5.2.0`. The mobile lockfile is the larger
  surface — Expo drags in a deep tree (Metro, the native module ecosystem).
- **`postinstall`/script risk** is the standard npm concern; nothing in the
  repo's own `scripts` (`mobile/package.json:18-23`: `start`, `android`,
  `ios`, `web`) runs untrusted code, but transitive packages can ship
  install scripts — that's inherent to the ecosystem, not a flattr choice.
- **No CVE scan in CI.** There's no `npm audit` gate or Dependabot config
  visible. Consequence: **a known-vuln transitive package would not be
  caught automatically** — it'd surface only on a manual `npm audit`.

**Red flag checked:** no missing lockfile; no obviously abandoned or
unpinned direct dep. The buildable target: add `npm audit --audit-level=high`
to a CI step (or enable Dependabot) so the transitive tree is watched.

---

## 7. LLM and agent security

`not yet exercised` — genuinely, completely empty.

There is no model, no prompt, no embedding, no vector store, no tool-calling
agent, no model output flowing into any sink. `grep -ri "openai|anthropic|
llm|prompt|embedding|agent|gpt|claude"` across `pipeline/`, `features/`, and
`mobile/src/` returns nothing. The "intelligence" in flattr is a hand-rolled
A* search over a graph (`features/routing/astar.ts`) and a grade-penalty cost
function (`features/routing/cost.ts`) — deterministic algorithms, not ML.

There is therefore **no prompt-injection surface, no tool-scope decision, no
model-output-as-trusted-code risk, and no exfiltration-through-tool-calls
risk.** Saying otherwise would be inventing a threat. **What would introduce
it:** a natural-language "route me somewhere flat and scenic" feature backed
by an LLM, or an agent that calls the routing engine as a tool — at which
point retrieved OSM place names (untrusted external text, lens 1) flowing
into a prompt would become the first prompt-injection vector.

---

## 8. Security red-flags audit (capstone checklist)

Consolidated, marked against this repo. `fires` = a real concern here;
`N/A` = the surface doesn't exist; location + severity + one-line direction.

```
  flag                                  status   where / why                                   sev   direction
  ────────────────────────────────────  ───────  ───────────────────────────────────────────  ────  ────────────────────────────
  input trusted "from our frontend"      N/A      no backend receives frontend input            —     —
  string-built SQL/shell/path with input N/A      no DB, no shell, no fs-of-user-input          —     —
  string-built URL with user input       OK       URLSearchParams/encodeURIComponent everywhere —     keep using it (geocode.ts,
                                                   (geocode.ts:14, overpass.ts:30, elev.ts:72)        overpass.ts, elevation.ts)
  unvalidated external/artifact data      FIRES    loadGraph.ts:10 `as unknown as Graph`,        HIGH  validate at the boundary
    into a trusted sink                            no runtime schema check; NaN elevation              (zod/manual) — see 02-
                                                   ungated by MAX_GRADE_PCT clamp (grade.ts:30)        and 01-
  endpoint checks authn but not authz     N/A      no auth layer at all                          —     —
  secret in source                        OK       none; key is env-only (run-build.ts:23)       —     keep it out of mobile/
  secret in client bundle                 OK       Google key never imported into mobile/        —     —
  secret in git history / logs            OK       no literal key in history; log prints mode    —     —
  secret in committed .env                OK       no .env tracked; .gitignore covers it         —     —
  verbose error leaks internals to UI     OK       generic strings only (MapScreen.tsx:175,195)  —     —
  PII / location leaves device            FIRES    GPS + search → Nominatim (geocode.ts:58)      MED   add in-app disclosure or
    to a third party without disclosure                                                                proxy; privacy not breach
  missing lockfile                        OK       both package-lock.json present                —     —
  no dependency CVE scan in CI            FIRES    no npm audit / Dependabot gate                LOW   add npm audit to CI
  model output into a trusted sink        N/A      no LLM/agent anywhere                          —     —
  prompt injection via retrieved content  N/A      no LLM/agent anywhere                          —     —
```

**The three that fire**, ranked: (1) unvalidated artifact/external data into
the engine — availability + correctness, HIGH; (2) location/search disclosure
to Nominatim — privacy, MED; (3) no CVE scan — supply-chain hygiene, LOW.
Everything else is either clean or `N/A` because the surface genuinely does
not exist in this repo.
