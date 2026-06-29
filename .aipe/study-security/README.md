# Study — Security (flattr)

The only question this guide asks: **what can an attacker reach, and what
happens when they do?** Everything below traces one axis — *trust* — across
every boundary where data crosses from somewhere you don't control into code
you do.

flattr is unusual for a security audit: it's a client-side TypeScript router
with **no auth, no backend, no server-side secrets, no database, no cookies**.
That removes most of the classic attack surface (no SQLi, no CSRF, no session
fixation, no XSS-via-server-render). What's left is a narrower but real set of
trust boundaries — all about *external data entering a pipeline that trusts it
too much*.

## The trust map (zoom out)

```
  flattr — where untrusted data crosses into trusted code

  ┌─ Trusted: your code ────────────────────────────────────────┐
  │                                                              │
  │   A* router · grade math · GeoJSON shaping · React UI        │
  │                                                              │
  └───▲───────────────▲───────────────────────▲─────────────────┘
      │ boundary 1     │ boundary 2             │ boundary 3
      │ OSM geometry   │ graph.json artifact    │ user input → 3rd-party URL
      │ + elevation    │ (cast, not validated)  │ (GPS + typed text)
  ┌───┴────────────┐ ┌─┴──────────────────┐ ┌──┴────────────────────┐
  │ Overpass (OSM) │ │ mobile/assets/     │ │ Nominatim (OSM geocode)│
  │ Open-Meteo     │ │   graph.json       │ │ — display_name back     │
  │ (keyless APIs) │ │ (build output)     │ │   into the UI           │
  └────────────────┘ └────────────────────┘ └────────────────────────┘
   Untrusted: third parties + an artifact nobody re-checks at load
```

The three boundaries are the three Pass-2 pattern files. Everything else the
8-lens audit marks honestly — most as `not yet exercised`, because the
architecture genuinely doesn't have the surface.

## Reading order

1. **`00-overview.md`** — one page: the trust axis, the verdict, the ranked
   exposure list. Start here.
2. **`audit.md`** — Pass 1. All 8 security lenses walked against real files,
   with `not yet exercised` named honestly and triggers for when each lens
   *starts* to apply.
3. **`01-external-data-trust-boundary.md`** — Overpass OSM geometry +
   Open-Meteo elevation entering the pipeline with one clamp (`±40%` grade)
   and no schema check. Runs at **both** build-time and runtime.
4. **`02-unvalidated-artifact-load.md`** — `graph.json` cast `as unknown as
   Graph` with zero runtime validation. The highest *availability* risk in the
   repo.
5. **`03-user-input-to-third-party-url.md`** — exact GPS coords + typed search
   text sent to Nominatim on every query; `display_name` strings come back
   attacker-influenced and render in the UI. The seam to watch when the future
   LLM layer lands.

## The verdict up front

There is **no confidentiality or integrity exposure** here worth losing sleep
over — no secrets to leak, no other user's data to reach, no privileged action
to escalate to. The entire risk surface is **availability + data integrity of
the route**: malformed external data or a drifted artifact crashes the app or
silently produces a wrong (unsafe-grade) route. The single worst exposure is
`02` — an unvalidated artifact that fails deep inside A* with a cryptic error
instead of at the boundary with a clear one.

## Cross-links to sibling guides

- **`study-system-design`** — the same three boundaries seen as architecture
  (build-time pipeline vs runtime tile loading); the artifact handoff.
- **`study-networking`** — the Overpass/Open-Meteo/Nominatim fetch posture:
  retries, timeouts, rate-limit backoff (`overpass.ts`, `elevation.ts`).
- **`study-data-modeling`** — the `Graph` schema itself (what `02` should
  validate against).
- **`study-debugging-observability`** — where a malformed artifact actually
  surfaces (deep in A*, not at load) and why that's a debugging tax.
- **`study-ai-engineering` / `study-prompt-engineering` / `study-agent-architecture`**
  — the future LLM seam flagged in `03`: `display_name` is attacker-influenced
  text that must never reach a prompt unframed.
- **`study-performance-engineering`** — the rate-limit clamps
  (`MAX_CORRIDOR_SPAN_DEG`, batch sizes) that double as a crude DoS guard on
  the free APIs.
