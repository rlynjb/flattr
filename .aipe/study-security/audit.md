# Security Audit — flattr (Pass 1)

The 8-lens walk. Each lens gets a verdict against real `file:line` evidence, or
`not yet exercised` with the trigger that would activate it. Significant
findings cross-link to the Pass 2 pattern files. No exploit code — weakness,
broken trust assumption, fix.

The through-line: *every input is hostile until proven otherwise; every boundary
either enforces a trust decision or leaks one.*

---

## 1. Trust boundaries and attack surface

**Verdict: three live boundaries, all on the data plane. No control-plane
boundary (auth) exists.** This is the zoom-out for the whole audit.

```
  Where untrusted input crosses into trusted flattr code

  source                     enters at                       trusted after
  ─────────────────────────  ──────────────────────────────  ─────────────
  Overpass OSM JSON          pipeline/overpass.ts:41          parseOsm
  Open-Meteo elevation JSON  pipeline/elevation.ts:111        sampleElevations
  graph.json (artifact)      mobile/src/loadGraph.ts:10       ALL routing
  Nominatim reply            pipeline/geocode.ts:25,52,68      MapScreen state
  typed address / GPS        mobile/AddressBar.tsx → geocode  outbound URL
  AsyncStorage elev cache    mobile/src/elevCache.ts:23       tile grades
```

Each boundary, the trust assumption, whether it holds:

- **Overpass response** (`overpass.ts:41`) — cast `(await res.json()) as
  OverpassResponse` with no schema check. `parseOsm` (`osm.ts:5`) defensively
  skips ways with `<2` resolved coords (`osm.ts:23`) and unknown highway kinds
  (`osm.ts:20`), so it's *partially* hardened — but lat/lng values themselves are
  trusted raw. → deep walk in `01-external-data-trust-boundary.md`.
- **Open-Meteo response** (`elevation.ts:111`) — cast `as { elevation: number[]
  }`; the array length is assumed to match the request and elements assumed
  numeric. A short or non-numeric array silently corrupts grades. → `01-`.
- **`graph.json`** (`loadGraph.ts:10`) — `graph as unknown as Graph`. The
  single most load-bearing trust assumption in the repo, and the least
  enforced. → `02-unvalidated-artifact-load.md`.
- **Nominatim reply** (`geocode.ts:27,52,69`) — `display_name` is
  attacker-influenceable OSM text (anyone can edit OSM). It flows into UI state
  and is rendered. Inert today (React escapes), live the day it reaches an LLM
  or HTML sink. → `03-user-input-to-third-party-url.md`.

**Red flag check — "trusted because it comes from our own frontend":** present
in spirit at `loadGraph.ts:10` — `graph.json` is trusted because *we built it*.
But "we built it" is not "it's well-formed at runtime": the build can drift, the
file can be swapped in a tampered bundle, a partial write can truncate it.

---

## 2. Authentication and authorization

**Verdict: not yet exercised.** No users, no sessions, no protected resources.
`grep` for auth/session/token/login/cookie across `features/`, `pipeline/`,
`mobile/src/` returns nothing. The only "permission" in the codebase is an OS
one: `Location.requestForegroundPermissionsAsync()` (`MapScreen.tsx:95`) — that's
device-consent for GPS, not application authn/authz.

- **Trust assumption:** there is no actor to authenticate; every user of the
  app has identical, total access to identical, public data.
- **TRIGGER that activates this lens:** the moment flattr grows a backend with
  saved routes, accounts, or any per-user state. Then "who are you" (sessions,
  token expiry) and "what can you do" (per-route authz) both become real, and
  the classic gap — *authn present, authz assumed* — becomes a live risk.
- **Buildable target:** if/when accounts land, every saved-route read/write
  needs an ownership check at the data-access layer, not just a logged-in check.

---

## 3. Input validation and injection

**Verdict: no SQL/command/path/XSS sink exists; the real injection surface is
data-shape, not code-injection.** Ranked worst-first.

```
  Injection surface, ranked

  worst  ► artifact shape (graph.json) → crashes A*        → 02-
         ► external data shape (OSM/elev) → garbage routes → 01-
         ► display_name → UI (inert: React escapes)        → 03-
  none     SQL / shell / fs-path / eval / innerHTML
```

- **No SQL injection.** No database, no query string assembled anywhere. `grep`
  for `SELECT`/`query(`/`exec(` across the repo: nothing.
- **No command/path injection.** The only `node:fs` use is
  `run-build.ts:47` writing `data/graph.json` to a *hardcoded* path — no user
  input reaches a filesystem path or a shell.
- **No classic XSS.** No `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` in
  `mobile/src/`. `display_name` renders inside a React `<Text>`
  (`AddressBar.tsx:23-25`), which escapes by default. → `03-`.
- **The real injection-shaped risks are deserialization-of-untrusted-shape:**
  - `loadGraph.ts:10` — no runtime validation of the parsed graph. → `02-`.
  - `elevation.ts:111` — `json.elevation` length/type assumed. → `01-`.
  - `elevCache.ts:23` — `JSON.parse` of AsyncStorage wrapped in try/catch; a
    poisoned value is type-cast `as Record<string, number>` but a non-numeric
    value would propagate as a bogus elevation. Local-only (the device's own
    storage), so severity is low, but it's the same unchecked-deserialization
    pattern.

**Red flag check — "string-built query or prompt with user input":** no SQL
prompt today. The *URL* built from user input (`geocode.ts:14`,
`URLSearchParams`) is correctly encoded — `URLSearchParams` escapes the query, so
there's no URL-injection here. → covered as a privacy (not injection) finding in
`03-`.

---

## 4. Secrets and configuration

**Verdict: clean. No secret in source, history, or client bundle.** flattr's
free-API design means there's almost nothing to leak.

- **Keyless by default.** Overpass, Open-Meteo, Nominatim, and the OpenFreeMap
  tile style (`MapScreen.tsx:21`) all require no key.
- **The one optional key is build-time only.** `GOOGLE_ELEVATION_KEY` is read
  from `process.env` at `run-build.ts:23` and passed to `googleProvider`
  (`elevation.ts:65`). It runs inside `npm run build:graph` on the developer's
  machine; it is **never** imported into `mobile/` and never bundled into the
  app. Confirmed: the only `process.env` read in the whole repo is that one
  line.
- **`data/` is gitignored** (`.gitignore:4`) — the build output (and anything a
  developer drops there) never enters git history.
- **No `.env` / secret files tracked.** `git ls-files | grep -iE
  '\.env|secret|key'` returns nothing.

**Red flag check — secret in source / bundle / logs:** none fires. The
build-time key never crosses into the client half. One note, not a finding:
`run-build.ts:25` logs `"Elevation: Google Elevation API (paid)."` — it logs
*that* a key is used, never the key value. Correct.

---

## 5. Data exposure and privacy

**Verdict: the real exposure is outbound, not inbound — exact GPS + typed text
leave the device to a third party.** This is the one privacy finding worth
ranking up.

- **Exact coordinates sent to Nominatim.** `reverseGeocode(lat, lng)`
  (`geocode.ts:58`, called from `MapScreen.tsx:247`) sends full-precision GPS to
  `nominatim.openstreetmap.org`. Forward geocoding (`geocode.ts:21`) sends the
  user's typed address/place text. Every routing query is a data point handed to
  a third party. → deep walk in `03-`.
- **Coarsening exists for display but not for the request.** `MapScreen.tsx:248`
  truncates the *fallback* label to 5 decimals — but the *request* at
  `geocode.ts:63` sends `String(lat)` / `String(lng)` at full precision. The
  coarsening is cosmetic, not privacy-preserving.
- **No PII in logs/errors.** Error paths set generic UI strings ("From not
  found", `MapScreen.tsx:184`; "Lookup failed — try again",
  `MapScreen.tsx:203`) — no coordinates or query text leak into error messages.
- **No over-fetching surface** — there's no API returning more than a caller is
  entitled to, because there's no API and no per-caller entitlement.

**Red flag check — response returns more than caller is entitled to:** N/A (no
server). The privacy finding is the *outbound* direction: full-precision
location to a third party with no coarsening. Buildable mitigation: round
coordinates to ~3 decimals (~110 m) before the reverse-geocode request, or
proxy through your own endpoint if/when one exists.

---

## 6. Dependencies and supply chain

**Verdict: lean and locked. Two lockfiles present, tiny dependency surface, no
postinstall risk in the repo's own manifests.**

```
  Dependency posture

  manifest             runtime deps   lockfile        notable
  ───────────────────  ─────────────  ──────────────  ─────────────────────
  package.json (root)  0 (dev only)   package-lock ✓  tsx, vitest, typescript
  mobile/package.json  7              package-lock ✓  expo 56, RN 0.85,
                                                       react 19, maplibre-rn 11
```

- **Root engine has zero runtime dependencies** — only `tsx`, `typescript`,
  `vitest`, `@types/node` as devDeps (`package.json:11-16`). The router, heap,
  and geo math are all hand-rolled (per project constraints). A hand-rolled
  binary heap (`pqueue.ts`) is more code to own but zero transitive supply-chain
  surface — a deliberate, defensible trade for this project.
- **Mobile has 7 runtime deps** (`mobile/package.json:5-14`), all
  platform/framework (Expo, React Native, MapLibre, AsyncStorage, slider,
  expo-location). No utility-library sprawl, no obviously abandoned packages.
- **Both halves have a `package-lock.json`** — installs are reproducible; no
  floating-version drift.
- **No postinstall scripts in flattr's own manifests.** (Transitive
  postinstalls inside `node_modules` are unaudited here — that's an `npm audit`
  job, out of scope for a code-level read.)

**Red flag check — no lockfile / known CVEs unpatched:** lockfiles present, so
the first half doesn't fire. The CVE half can't be settled by reading source —
**run `npm audit` in both `/` and `/mobile`** to close this lens. Version note:
`react-native 0.85` + `expo ~56` + `react 19` are recent; staying current is the
right posture and `mobile/AGENTS.md` already enforces reading versioned docs
before touching mobile code.

---

## 7. LLM and agent security

**Verdict: not yet exercised — no model in the loop today. But there's a primed
prompt-injection vector waiting for one.**

- **No LLM/agent code in flattr.** No model client, no tool definitions, no
  prompt assembly anywhere in `features/`, `pipeline/`, or `mobile/src/`.
- **The dormant vector:** `display_name` from Nominatim (`geocode.ts:27`) is
  attacker-editable OSM text. Today it's rendered React-escaped and inert. The
  *day* an LLM feature consumes it — "summarize this route," "describe the
  destination" — that text becomes untrusted model input, and a crafted OSM
  place name becomes a prompt-injection payload reaching the model without a
  gate. → this is exactly the seam `03-` walks.
- **TRIGGER:** any LLM consuming geocoder text, route summaries, or graph data.
- **Buildable target when it lands:** treat `display_name` (and any
  retrieved/third-party text) as untrusted model input — delimit it, never let
  it carry instructions, and gate any model *output* before it reaches a sink
  (don't execute model-emitted code/queries).

**Red flag check — agent tool-set exceeds task / model output into a sink:**
N/A today; named here so it's not forgotten the day it becomes real.

---

## 8. Security red-flags audit (capstone)

Consolidated checklist, marked against this repo. `fires` = real finding here;
`N/A` = no surface; location + one-line fix where it fires.

```
  flag                                   verdict   location / note
  ─────────────────────────────────────  ────────  ──────────────────────────────
  Input trusted "because it's ours"      FIRES     loadGraph.ts:10 — validate
                                                     artifact at load (→ 02-)
  Untrusted shape deserialized unchecked FIRES     elevation.ts:111, elevCache.ts:23
                                                     — check length/type (→ 01-)
  Out-of-range numeric input unclamped   FIRES     osm.ts:8 lat/lng, grade clamp at
                                                     grade.ts:30 only (→ 01-)
  Full-precision PII to third party      FIRES     geocode.ts:63 — coarsen coords
                                                     before request (→ 03-)
  3rd-party text into a future sink      FIRES     geocode.ts:27 — gate before LLM
                                          (dormant) /HTML (→ 03-, 07-)
  Boundary failure swallowed silently    FIRES     MapScreen.tsx:202,
                                          (minor)   useTileGraph.ts:219 — log it
  Secret in source / bundle / log        N/A       keyless; key is build-only
                                                     (run-build.ts:23)
  SQL / command / path injection         N/A       no DB, no shell, hardcoded fs path
  XSS (innerHTML/eval/dangerouslySet…)   N/A       React escapes; none present
  Missing authn / authz / CSRF           N/A       no users, server, or cookies
  No lockfile                            N/A       both package-lock.json present
  Known-CVE deps                         UNKNOWN   run `npm audit` in / and /mobile
```

**The one-paragraph capstone takeaway:** flattr's security story is dominated by
*availability and integrity of data*, not *confidentiality or access control* —
because there's no access to control. Fix the artifact validation
(`loadGraph.ts:10`) and the external-data shape checks (`elevation.ts:111`,
`osm.ts`) and you've closed the two findings that can actually bite a user
today. Everything else is either dormant (LLM, `03-`'s prompt-injection half) or
genuinely absent with a named trigger (auth, SQL, CSRF). The honesty *is* the
audit: a thin attack surface, precisely mapped, beats a thick one vaguely
gestured at.
