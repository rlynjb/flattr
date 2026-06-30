# Study — Security · flattr

The trust axis, made into an audit. One question runs through every file:
**what can an attacker reach, and what happens when they do?**

flattr has an unusual threat model for a "study security" target: there's no
server, no database, no auth, no cookies, no sessions. It's a client-side
TypeScript routing engine (`features/`, `pipeline/`) wrapped in an Expo / React
Native app (`mobile/`) that reads a prebuilt static graph. So the classic web
surface — SQLi, XSS, CSRF, broken authz — is genuinely **not exercised**. That's
not a gap to hide; it's the finding. The real attack surface is narrower and
sharper: external data flowing into a routing pipeline with almost no
validation, and a build artifact trusted on faith.

```
  flattr trust map — where untrusted data crosses into trusted code

  ┌─ UNTRUSTED (outside the boundary) ─────────────────────────────┐
  │  Overpass OSM   Open-Meteo elev   Nominatim   graph.json        │
  │  (3rd-party)    (3rd-party)       (3rd-party)  (build artifact)  │
  └────┬──────────────┬──────────────────┬────────────┬────────────┘
       │ boundary 1   │ boundary 1       │ boundary 3 │ boundary 2
  ─────┼──────────────┼──────────────────┼────────────┼──────────── trust line
       ▼              ▼                  ▼            ▼
  ┌─ TRUSTED (flattr code) ────────────────────────────────────────┐
  │  pipeline/      pipeline/        mobile/       mobile/           │
  │  parseOsm       computeGrades    MapScreen     loadGraph         │
  │  (build-time)   (±40% clamp)     (React-       (as unknown       │
  │                                   escaped)      as Graph)        │
  └────────────────────────────────────────────────────────────────┘

  3 live boundaries. No authn/authz/session/SQL boundary exists yet.
```

## Reading order

1. **`00-overview.md`** — one-page orientation: the three boundaries, the
   single worst exposure, what's honestly not-yet-exercised.
2. **`audit.md`** — Pass 1. All 8 security lenses walked against real
   `file:line` evidence. Every lens gets a verdict, including the honest
   `not yet exercised` ones with the trigger that would activate them.
3. **Pattern files** (Pass 2) — the security-shaped boundaries flattr actually
   exercises, each a full deep-walk:
   - `01-external-data-trust-boundary.md` — Overpass + Open-Meteo enter the
     pipeline; the only validation is a ±40% grade clamp.
   - `02-unvalidated-artifact-load.md` — `graph.json` cast `as unknown as
     Graph` with no schema check. The highest *availability* risk in the repo.
   - `03-user-input-to-third-party-url.md` — exact GPS + typed text sent to
     Nominatim; attacker-editable `display_name` rendered in the UI (inert
     today via React escaping, a prompt-injection vector the day an LLM lands).

## The single worst exposure (verdict first)

**`mobile/src/loadGraph.ts:10` — `graph as unknown as Graph`.** Not a
confidentiality bug — an *availability* one. A malformed or drifted artifact
(dangling edge ref, missing node, NaN coordinate) passes the cast unchecked and
crashes deep inside A* at `astar.ts:65` (`byId.get(edgeId)!`) or
`astar.ts:72` (`graph.nodes[next]`), far from the load site. → `02-`.

## Cross-links to sibling guides

- **`study-system-design`** — the same boundaries as *architecture* (tiling,
  corridor loading, the build-vs-runtime split) rather than as *trust*.
- **`study-data-modeling`** — the `Graph` schema itself (`Node`/`Edge`/
  `adjacency`); this guide cares who can *tamper* with it, that guide cares how
  it's *shaped*.
- **`study-testing`** — the injectable `fetchImpl` seam that lets the pipeline
  be tested without network is the same seam a validation layer would hook.
- **`study-networking`** — the retry/backoff/timeout behavior on Overpass and
  Open-Meteo (`overpass.ts:18`, `elevation.ts:114`) as *transport*, not trust.
- **`study-ai-engineering`** / **`study-prompt-engineering`** — the day an LLM
  feature consumes `display_name`, `03-` becomes a live prompt-injection
  finding instead of a dormant one.
- **`study-frontend-engineering`** — `AddressBar.tsx` rendering and the React
  auto-escaping that keeps `display_name` inert today.
- **`study-debugging-observability`** — the silent `catch {}` blocks
  (`MapScreen.tsx:202`, `useTileGraph.ts:219`) that swallow boundary failures.
