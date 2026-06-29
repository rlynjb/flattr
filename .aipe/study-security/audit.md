# audit.md — the 8-lens security audit (Pass 1)

Every lens, walked against the real repo. Where flattr does something, it's
named with `file:line`. Where it doesn't, the lens is marked **not yet
exercised** with the *trigger* — the change that makes the lens start to matter.
No invented vulnerabilities; no softened real ones.

The through-line, held constant across all 8: *what can an attacker reach, and
what happens when they do?* In flattr there is no auth and no other user, so
"attacker" mostly means **a hostile or corrupt third-party response, a drifted
artifact, or a malicious address string** — not a logged-in adversary.

---

## 1. trust-boundaries-and-attack-surface

**What the repo does.** Three boundaries where data crosses from untrusted into
trusted code. This is the audit's zoom-out; each gets a Pass-2 file.

```
  The three crossings

  ① external data   Overpass (OSM ways) + Open-Meteo (elevation)
                    → pipeline/overpass.ts, pipeline/elevation.ts
                    enters at BUILD time (run-build.ts) AND
                    RUNTIME (useTileGraph.ts on-device tile fetch)
                    → see 01-external-data-trust-boundary.md

  ② artifact load   mobile/assets/graph.json → loadGraph.ts:10
                    cast `as unknown as Graph`, no runtime check
                    → see 02-unvalidated-artifact-load.md

  ③ user → 3rd party  typed text + exact GPS → Nominatim (geocode.ts)
                    display_name back into the UI (AddressBar.tsx:23)
                    → see 03-user-input-to-third-party-url.md
```

**The trust assumption.** Every boundary assumes the other side returns
well-formed, well-typed, sane data. None *enforces* it. The one exception that
proves the rule: the `±40%` grade clamp at `grade.ts:30` is the only place in
the whole pipeline that says "this external value might be garbage, bound it."

**The red flag this lens looks for** — "input treated as trusted because it
comes from our own frontend" — **does fire, mildly.** GPS coords and typed text
*are* from your own UI, so trusting them is fine. But the OSM/Open-Meteo
responses are *not* yours, and the pipeline trusts them almost as much. That's
boundary ①.

→ Deep walk: `01`, `02`, `03`.

---

## 2. authentication-and-authorization

**Not yet exercised.** There is no login, no session, no token, no user
account, no per-resource check anywhere in the repo. `grep` for `auth`,
`session`, `token`, `login` returns only `@react-native-async-storage` (a
local KV cache for elevation, `mobile/src/elevCache.ts`) — not identity.

This is **correct for what flattr is**: a single-user, read-only,
local-compute app. There's nothing to authenticate to and nothing to authorize.

**Trigger — when this lens starts to matter:**
- The moment flattr adds *saved routes per user*, *a shared backend*, or *any
  account*. Then the classic gap appears: authn present, authz assumed. The
  buildable target is per-resource ownership checks (`route.userId === session.userId`)
  on every read and write, not just a logged-in gate.
- A weaker trigger: if the on-device elevation cache (`elevCache.ts`) ever
  syncs to a shared store, "who can read whose cached coords" becomes an authz
  question.

---

## 3. input-validation-and-injection

**What the repo does — and the surfaces that don't exist.**

- **SQL injection: N/A.** No database, no query layer anywhere. Nothing to
  inject into.
- **Command injection: N/A.** No `child_process`, no shell-out. The build
  script writes a file with `node:fs` (`run-build.ts`) but never executes
  external input.
- **Path traversal: N/A in app, low in build.** `run-build.ts` writes a
  hard-coded path `data/graph.json`; no user-controlled path component.
- **SSRF: borderline, contained.** The app *does* construct third-party URLs
  from data (`geocode.ts` builds Nominatim URLs from typed text;
  `elevation.ts:106` builds Open-Meteo URLs from coords). But the endpoints are
  **hard-coded constants** (`ENDPOINT`, `DEFAULT_ENDPOINT`,
  `https://api.open-meteo.com/...`), and only the *query string* is
  user-influenced, properly encoded via `URLSearchParams` / `encodeURIComponent`
  (`overpass.ts:30`, `elevation.ts:72`). An attacker can't redirect the fetch to
  an internal host. → see `03` for the residual privacy concern.
- **XSS: deferred, not live.** The one place attacker-influenced text renders is
  the Nominatim `display_name` shown at `AddressBar.tsx:23-24` inside a React
  `<Text>`. React escapes by default, so it's inert today. It becomes live the
  instant that string is fed to a `dangerouslySetInnerHTML`, a WebView, or
  (the real future risk) **an LLM prompt**. → see `03`.
- **Prompt injection: not yet exercised** — no LLM in the repo. But the seam is
  pre-loaded: `display_name` is attacker-influenceable text that, the day a
  "describe this route" LLM feature lands, becomes a prompt-injection vector.
  Flagged in `03` and the AI-engineering cross-link.

**The one real validation in the codebase:** `grade.ts:30` clamps `gradePct` to
`±MAX_GRADE_PCT (40)`. It's framed as DEM-noise cleanup, but it *is* an
input-validation control — it bounds an externally-derived value so a garbage
elevation delta can't produce a 9000% grade that breaks downstream math. → `01`.

**Red flag — "string-built query or prompt with user input":** fires weakly.
The query strings *are* string-built but correctly encoded. No prompt exists
yet. Watch the prompt seam.

---

## 4. secrets-and-configuration

**What the repo does — and why "nothing to manage" is the honest answer.**

- The three live data sources are **keyless free APIs**: Overpass
  (`overpass-api.de`), Open-Meteo (`api.open-meteo.com`), Nominatim
  (`nominatim.openstreetmap.org`). No key, no token, nothing to leak.
- The **only** secret the codebase references is `GOOGLE_ELEVATION_KEY`, read
  from `process.env` at `pipeline/run-build.ts:23` and passed to
  `googleProvider(key)` (`elevation.ts:65`). This is **build-time only** — it
  never enters the mobile bundle. The runtime path (`useTileGraph.ts:191`)
  hard-wires `openMeteoProvider` (keyless), so even if you set the Google key,
  the *app* never carries it.
- The build output (`data/graph.json`) is **git-ignored** (`.gitignore`), so a
  graph derived with a paid key doesn't drag the key — or anything sensitive —
  into history. (Side note: the *bundled* `mobile/assets/graph.json` is checked
  in, but it's public street geometry, not a secret.)

**No secret in source, no secret in the client bundle, no secret in logs.**
This is the right posture for the project; don't add a vault for keys that don't
exist.

**Trigger:** the moment a *paid* or *rate-limited-by-key* API is called from the
*device* (e.g. moving Google elevation to runtime, or adding an LLM API). Then
the key must live behind a thin proxy you control — never in the app bundle,
where any user can extract it. The buildable target: a keyless edge function
that holds the secret and the device calls *that*.

---

## 5. data-exposure-and-privacy

**What the repo does.** The exposure here is **location privacy**, not data
over-fetching (there's no API of your own to over-fetch from).

- **Exact GPS leaves the device.** `MapScreen.tsx:97` reads the precise
  position (`Location.getCurrentPositionAsync`) and `handleUseCurrentLocation`
  (`:220`) stores it as the route start. On routing, `geocode()` /
  `reverseGeocode()` send coordinates and typed addresses to Nominatim
  (`geocode.ts:63`). So **a third party (OSM) sees where the user is and where
  they're going**, tied to the device's IP, on every query. → `03`.
- **No PII in logs.** The build logs node/edge counts (`run-build.ts`), not user
  data. The app has no server logs at all.
- **Error messages are terse and non-leaky.** `geocode.ts:24` throws
  `Geocode failed: ${status}` (a status code, no internals); the UI collapses
  failures to `"Lookup failed — try again"` (`MapScreen.tsx:203`). No stack
  traces or internal paths reach the user.

**Red flag — "response returns more than the caller is entitled to":** does not
fire (no API of your own). The honest privacy finding is the GPS-to-third-party
leak, which is inherent to using a hosted geocoder. The mitigation is the
`searchViewbox` bias (`MapScreen.tsx:51`) which *narrows* what's sent, plus the
keyless nature meaning OSM can't tie queries to an account.

**Trigger:** any analytics SDK, crash reporter, or your-own backend. Each
becomes a new place coords or addresses could be logged. The buildable target:
coarsen coords before they leave the device (round to ~100m) unless precision is
required.

---

## 6. dependencies-and-supply-chain

**What the repo does.**

- **Lockfiles present, both projects.** `package-lock.json` (root) and
  `mobile/package-lock.json` pin the full tree. No unpinned floating installs.
- **Root deps are dev-only and tiny:** `tsx`, `typescript`, `vitest`,
  `@types/node` (`package.json`). The engine has **zero runtime production
  dependencies** — it's pure TypeScript over the standard library. That's a
  near-minimal supply-chain surface.
- **Mobile deps are the real surface:** Expo `~56`, React Native `0.85`,
  React `19.2`, `@maplibre/maplibre-react-native`, `expo-location`,
  `async-storage`, `community/slider` (`mobile/package.json`). These are
  large, transitive-heavy native modules — the bulk of the attack surface lives
  in *their* trees, not flattr's code.
- **No `postinstall` scripts in the repo's own package.json files.** (Transitive
  packages may have their own; that's the unmanaged part.)

**Red flag — "no lockfile, or known CVEs unpatched":** the lockfile red flag
does **not** fire. The CVE posture is **not audited here** — running
`npm audit` in both trees is the buildable next step; this audit confirms the
*hygiene* (lockfiles, pinned versions, no first-party runtime deps) but does not
claim the transitive tree is CVE-free.

**Trigger:** every `npm install` of a new mobile dependency widens this. The
standing target: `npm audit` in CI for both `package-lock.json` files, and treat
a new transitive `postinstall` as a review event.

---

## 7. llm-and-agent-security

**Not yet exercised.** There is no LLM, no agent, no tool-calling, no model
output anywhere in the repo. `grep` for `openai`, `anthropic`, `claude`,
`prompt`, `llm`, `agent`, `tool` returns nothing in source.

This is honest: flattr is a deterministic router. There is no prompt to inject
into, no tool whose scope could exceed its task, no model output flowing into a
sink.

**But the seam is pre-loaded — flag it now.** The project context positions
flattr in an AI-pivot portfolio, and `docs/flattr-spec.md` hints at future
narration. The day a "describe my route / explain the grade" LLM feature lands,
two existing facts become security-relevant *immediately*:

1. **`display_name` is attacker-influenceable text** (lens 3, file `03`). Anyone
   can edit an OSM place name. If that string is concatenated into a prompt
   ("Routing the user to {display_name}…"), it's a textbook prompt-injection
   vector. The control is to **frame untrusted text as data, never as
   instructions**, and never let model output flow back into a sink (URL, fs,
   eval) without a gate.
2. **Tool scope.** If an agent ever drives the router (calls `geocode`,
   `directedAstar`, `fetchOverpass`), give it the *narrowest* tool set the task
   needs. An agent that only needs to read a route should not also hold the
   elevation-fetch or file-write tools.

**Trigger:** the first `@anthropic-ai/sdk` / `openai` import. At that point this
lens flips from `not exercised` to the most important lens in the audit, and
`03` becomes the load-bearing pattern file.

---

## 8. security-red-flags-audit (capstone checklist)

Consolidated, marked against this repo. `FIRES` = present risk;
`DEFERRED` = inert today, live under a named future change; `N/A` = no surface.

```
  flag                                  status     location / note
  ────────────────────────────────────  ─────────  ───────────────────────────
  Untrusted input treated as trusted    FIRES      grade.ts:30 only guard;
   (external OSM/elevation)               (med)      else trusted. → 01
  Artifact loaded without validation    FIRES      loadGraph.ts:10 `as Graph`.
   (highest availability risk)            (HIGH)     → 02
  Exact GPS sent to 3rd party           FIRES      MapScreen.tsx:97 → geocode.ts
   (location privacy)                     (low)      → 03
  String-built query w/ user input      DEFERRED   encoded today (URLSearchParams
                                                     / encodeURIComponent). OK.
  Attacker text rendered in UI (XSS)    DEFERRED   AddressBar.tsx:23; React
                                                     escapes. Live if → WebView.
  Attacker text → LLM prompt            DEFERRED   no LLM yet. → 03, lens 7.
  Secret in source / bundle / logs      N/A        only build-time env key;
                                                     data/ gitignored.
  SQL injection                         N/A        no database.
  Command injection                     N/A        no shell-out.
  SSRF (redirect fetch to internal)     N/A        endpoints hard-coded consts.
  CSRF                                  N/A        no cookies, no server.
  Missing authn / authz                 N/A        no users, no resources.
  Session fixation / weak session       N/A        no sessions.
  No lockfile                           N/A        both lockfiles present.
  Known-CVE deps                        UNKNOWN    run `npm audit` (both trees).
```

**The one-line fixes, ranked:**

1. **`02` (HIGH):** validate `graph.json` at load with a runtime schema (Zod or
   a hand-rolled guard) so corruption fails *at the boundary* with a clear
   message, not deep in A*.
2. **`01` (MED):** add bounds checks alongside the grade clamp — finite
   coordinates, non-empty geometry, monotonic node references — before the
   artifact is built/trusted.
3. **`03` (LOW now, becomes HIGH with LLM):** keep treating `display_name` as
   data; the instant an LLM feature lands, frame it as untrusted input and
   never let it become instructions.

The pattern files below walk the three that fire.
