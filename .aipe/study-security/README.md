# Study — Security (flattr)

The trust axis as a discipline: for every boundary in this repo, what can
each side see, reach, or tamper with — and what happens when an attacker
reaches it.

```
  the only question this guide answers

  what can an attacker reach, and what happens when they do?

  trace the trust axis across every boundary ──────────────────────
     where does untrusted input enter?     → third-party APIs + user text
     who is allowed past this boundary?     → NOBODY (no auth surface)
     what's hidden, what's exposed?         → GPS + search queries leave device
     what do my dependencies let in?        → Expo / MapLibre / RN tree
```

## The honest verdict, up front

flattr has a **modest, honest attack surface**. There is no auth, no
accounts, no server you operate, no database, no session, no LLM/agent
layer. That removes whole classes of vulnerability (no SQLi, no CSRF, no
broken-authz, no prompt injection) — and this guide says so plainly rather
than inventing threats to look thorough.

What *is* real: this app trusts data from four third-party services it does
not control (Overpass/OSM, Open-Meteo, Nominatim, OpenFreeMap tiles), it
sends the user's GPS coordinate and typed search text to one of those
services, and it loads a half-megabyte build artifact (`graph.json`) into
the routing engine through an **unchecked type cast** with zero runtime
validation. None of these is a CVE. All of them are trust assumptions, and
this guide names where each one would break.

## Reading order

1. **`00-overview.md`** — one-page orientation: the whole trust map in one
   diagram, the four boundaries, the ranked findings.
2. **`audit.md`** — Pass 1, the 8-lens security audit. Each lens names what
   the repo does (with `file:line`) or emits `not yet exercised` honestly.
   The capstone lens is a consolidated red-flag checklist.
3. **Pattern files** — Pass 2, the security-shaped mechanisms worth a deep
   walk:
   - **`01-external-data-trust-boundary.md`** — the build pipeline trusts
     OSM geometry and DEM elevation; the `MAX_GRADE_PCT` clamp is the one
     place that data is sanitized before it drives routing cost.
   - **`02-unvalidated-artifact-load.md`** — `graph.json` enters the engine
     via `as unknown as Graph` with no schema check. The single highest-
     consequence trust assumption in the runtime.
   - **`03-user-input-to-third-party-url.md`** — geocode/search text is
     URL-encoded into Nominatim requests; what's safe, what leaves the
     device, what the privacy cost is.

## Cross-links to sibling guides

- **`.aipe/study-networking/`** — the outbound calls themselves (DNS, TLS,
  retries, timeouts) live there; this guide covers only the *trust* placed
  in what those calls return.
- **`.aipe/study-system-design/`** — the artifact boundary as an
  architecture decision (build-time vs runtime split) lives there; here we
  cover it as a trust boundary.
- **`.aipe/study-data-modeling/`** — the *shape* of `graph.json` lives
  there; here we cover the fact that the shape is asserted, never verified.

## The one rule this guide follows

Every claim cites a real path and line range. Every abstract statement is
followed by a concrete consequence ("if the artifact ships with a malformed
edge, `nearestNode` reads `undefined.lat` and the screen white-screens").
"This is secure" is banned. `not yet exercised` is used wherever the repo
genuinely lacks the surface — and explains what would introduce it.
