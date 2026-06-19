# 02 — DNS, routing, and addressing
### names, addresses, routing, proxies, edge layers, and origin resolution
**Industry name:** name resolution / addressing — *Industry standard*

═════════════════════════════════════════════════
ZOOM OUT, THEN ZOOM IN
═════════════════════════════════════════════════

Every `fetch(url)` you've ever written started with a hostname that had to become an IP before a single byte moved. You never think about it because the platform does it silently. flattr is the same — and the lesson here is mostly about what flattr *doesn't* do: no DNS config, no proxy, no edge layer it owns, no service discovery. Just four hardcoded hostnames handed to the OS resolver.

```
  Zoom out — where addressing sits

  ┌─ App / Build layer ─────────────────────────────┐
  │  fetch("https://overpass-api.de/api/...")        │
  │             │  hostname string                   │
  └─────────────▼────────────────────────────────────┘
  ┌─ ★ Resolution layer (OS / platform — NOT flattr) ★┐
  │  DNS resolver: hostname ──► IP address           │ ← we are here
  └─────────────┬────────────────────────────────────┘
                │  IP + port 443
  ┌─ Network ───▼────────────────────────────────────┐
  │  routed across the public internet to the provider│
  └───────────────────────────────────────────────────┘
```

Zoom in: addressing is "how does `overpass-api.de` become a machine I can open a connection to?" In flattr the answer is entirely delegated — flattr names the host, the OS resolves it, the internet routes it. flattr writes the *name* and nothing below it.

═════════════════════════════════════════════════
THE STRUCTURE PASS
═════════════════════════════════════════════════

**Layers.** Name (the URL string in the code) → Resolution (DNS, owned by the OS) → Routing (the public internet) → Origin (the provider's servers, possibly behind their own CDN you can't see).

**Axis — control (who decides the next step?).**

```
  Axis "who controls this step?" — down the addressing stack

  ┌─────────────────────────────────────┐
  │ Name: the URL constant in source     │  → flattr decides
  └─────────────────────────────────────┘
      ┌─────────────────────────────────┐
      │ Resolution: DNS lookup           │  → OS / platform decides
      └─────────────────────────────────┘
          ┌─────────────────────────────┐
          │ Routing + origin CDN         │  → provider / internet decides
          └─────────────────────────────┘

  control flips from flattr → platform → provider as you descend
```

**Seams.** The seam is the URL string itself. Above it, flattr decides (it picks the hostname, e.g. `DEFAULT_ENDPOINT` in `pipeline/overpass.ts:4`). Below it, control flips entirely to the platform and then the provider. Because the hostnames are *hardcoded constants*, the seam is rigid — there's no environment-based endpoint switching except the one case where Google vs Open-Meteo is chosen by env var (and that's a provider swap, not a DNS/endpoint config).

═════════════════════════════════════════════════
HOW IT WORKS
═════════════════════════════════════════════════

#### Move 1 — the mental model

You know how `fetch("/api/x")` resolves relative to your page's origin, but `fetch("https://other.com/x")` goes somewhere else entirely? The hostname is the only thing that decides *which machine*. flattr's hostnames are all absolute and all third-party — there's no relative URL, no own-origin, because flattr has no origin.

```
  Pattern — name → IP → route, all below the URL string

   "overpass-api.de"        (the name flattr writes)
          │  DNS resolve  (OS-owned)
          ▼
   65.21.x.x  :443         (an IP flattr never sees)
          │  route across internet
          ▼
   provider origin (maybe behind THEIR CDN — invisible to flattr)
```

#### Move 2 — walking the addressing

**The four names.** flattr addresses exactly four hostnames, all string constants in source. There's no service registry, no DNS-SD, no config file — the names are baked into the modules that use them.

```
  The address book (all hardcoded constants)

  overpass-api.de              ← pipeline/overpass.ts:4
  api.open-meteo.com           ← pipeline/elevation.ts:106
  maps.googleapis.com          ← pipeline/elevation.ts:72 (only if key set)
  nominatim.openstreetmap.org  ← pipeline/geocode.ts:5, :55
  tiles.openfreemap.org        ← mobile/src/MapScreen.tsx:21 (used by MapLibre)
```

**Resolution is invisible.** flattr never touches DNS. It hands a hostname to `fetch` (or to MapLibre for tiles) and the platform resolver does the A/AAAA lookup, honors the system DNS cache, and returns an IP. There is no custom resolver, no `/etc/hosts` override in code, no DNS-over-HTTPS configuration. Inferred: at build time Node uses the OS resolver; at runtime React Native uses the device's resolver. flattr depends on both working and configures neither.

**No proxy, no owned edge.** Trace the request and you'll find nothing between flattr and the provider that flattr controls. No reverse proxy, no API gateway, no CDN flattr operates, no load balancer. Each provider may sit behind *its own* CDN (Overpass and Nominatim are well-known to), but that edge belongs to them — flattr can't see it, configure it, or cache at it.

```
  Layers-and-hops — there is no owned middle

  ┌─ flattr ─┐  GET/POST    ┌─ (NOTHING flattr   ┌─ Provider edge ──┐
  │  fetch   │ ──────────►  │   owns here)      ──► (THEIR CDN/LB,   │
  │          │              │                      invisible)        │
  └──────────┘              └─────────────────────└──────────────────┘
       no proxy · no gateway · no owned CDN · no LB
```

**Addressing the *data*, not just the host.** There's a second kind of addressing worth naming: flattr addresses geographic points, and how it encodes them into URLs is a real design choice. Open-Meteo points go as parallel `latitude=` / `longitude=` comma lists (`pipeline/elevation.ts:104-106`); Google points go as `lat,lng|lat,lng` pipe-joined pairs (`pipeline/elevation.ts:71`); Overpass takes a bbox embedded in the QL body, not the URL (`pipeline/overpass.ts:7-15`). Same conceptual address (a coordinate), three wire encodings — because each provider's API defines its own.

#### Move 3 — the principle

When you don't own any infrastructure between yourself and the provider, "addressing" collapses to "pick the right hostname and trust the platform with everything below it." The engineering question stops being "how do I route this" and becomes "what's my fallback when the name I hardcoded stops resolving or the origin behind it changes."

═════════════════════════════════════════════════
PRIMARY DIAGRAM
═════════════════════════════════════════════════

The full addressing picture — names flattr owns, everything below it delegated.

```
  flattr addressing — name owned, rest delegated

  ┌─ flattr code (owns the NAME) ──────────────────────────────┐
  │  4 hardcoded hostnames, no proxy, no service discovery     │
  └────────────────────────────┬───────────────────────────────┘
                               │  hostname string
  ┌─ Platform (owns RESOLUTION) ▼──────────────────────────────┐
  │  OS DNS resolver → IP   (Node at build · device at run)    │
  └────────────────────────────┬───────────────────────────────┘
                               │  IP:443
  ┌─ Internet + Provider (owns ROUTING + ORIGIN) ▼─────────────┐
  │  public routing → provider's own CDN/LB (invisible)        │
  └─────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
IMPLEMENTATION IN CODEBASE
═════════════════════════════════════════════════

**Use cases.** Addressing is "reached for" implicitly on every call, but the *decisions* are visible in two places: the endpoint constants, and the one injectable-endpoint design that lets tests avoid resolving the real host.

**The endpoint constant + the injection seam** — `pipeline/overpass.ts` (lines 4, 21-26):

```
  pipeline/overpass.ts  (lines 4, 21-26)

  const DEFAULT_ENDPOINT =
    "https://overpass-api.de/api/interpreter";   ← the hardcoded NAME

  export async function fetchOverpass(
    bbox, 
    endpoint: string = DEFAULT_ENDPOINT,          ← but overridable…
    fetchImpl: typeof fetch = fetch,              ← …and fetch is injectable
    ...
        │
        └─ tests pass a fake endpoint + fake fetch (overpass.test.ts:32),
           so the suite NEVER resolves overpass-api.de. The injectable
           endpoint is the seam that decouples logic from real DNS.
```

The default is a constant, but the signature lets a caller (or a test) substitute the endpoint and the fetch implementation. That's the one place flattr's addressing is configurable — and it exists for testability, not for production endpoint switching.

**Encoding coordinates into the address** — `pipeline/elevation.ts` (lines 104-106):

```
  pipeline/elevation.ts  (lines 104-106)

  const lats = batch.map((p) => p.lat).join(",");   ← parallel arrays:
  const lngs = batch.map((p) => p.lng).join(",");   │  all lats, all lngs
  const url = `https://api.open-meteo.com/v1/elevation
                ?latitude=${lats}&longitude=${lngs}`; ← addressed in query
        │
        └─ the "address" of the data is the query string; 100 points ride
           in one URL. Note: no encodeURIComponent here — fine because
           numbers and commas are URL-safe, but it's an unstated assumption
```

═════════════════════════════════════════════════
ELABORATE
═════════════════════════════════════════════════

Hardcoded hostnames are the right call for a hobby/MVP build but they're also the quietest fragility in the repo. Public OSM endpoints rotate and rate-limit by host: `overpass-api.de` is one of several mirrors (there's also `overpass.kumi.systems`, `lz4.overpass-api.de`), and the polite move under sustained use is to rotate across mirrors. flattr doesn't — it pins one host. If that mirror is down or blocks flattr's User-Agent, there's no automatic failover at the addressing layer (the retry layer in `07` retries the *same* host, not a different one). The fix, when it matters, is a host list + rotation, not anything DNS-level.

═════════════════════════════════════════════════
INTERVIEW DEFENSE
═════════════════════════════════════════════════

**Q: "How does flattr handle service discovery / endpoint configuration?"**

Answer: "It doesn't need to — there's no fleet of services to discover. Endpoints are hardcoded hostname constants, one per provider. The only configurability is a test seam: `fetchOverpass` takes the endpoint and the fetch impl as parameters so the suite never resolves the real host. The one runtime 'choice' is Google-vs-Open-Meteo elevation, selected by an env var, but that swaps the whole provider, not just an endpoint."

```
  4 constants → no registry, no discovery
  test seam: endpoint + fetchImpl injectable
  env var: GOOGLE_ELEVATION_KEY picks provider, not endpoint
```

Anchor: *no owned infrastructure means addressing is just picking a hostname and delegating the rest.*

**Q: "What happens if `overpass-api.de` stops resolving?"**

Answer: "The build fails outright — there's no fallback host. At runtime, `useTileGraph` catches the error and keeps the last graph, so the app degrades rather than crashes, but it can't fetch new coverage. The honest gap is no mirror rotation; the retry logic retries the same host, which doesn't help against a dead host."

Anchor: *one pinned host, no failover — fine for an MVP, a known fragility at scale.*

═════════════════════════════════════════════════
VALIDATE
═════════════════════════════════════════════════

1. **Reconstruct:** Name all four (five with Google) hostnames and the file:line where each is defined.
2. **Explain:** Why does `fetchOverpass` take `endpoint` as a parameter when there's only ever one real value? (`pipeline/overpass.ts:23`)
3. **Apply:** You want to rotate across three Overpass mirrors. Where in the code does that change land — the addressing layer or the retry layer? What's the minimal change?
4. **Defend:** Is hardcoding the hostname a bug or an acceptable MVP choice? Argue both sides, then commit to one.

═════════════════════════════════════════════════
SEE ALSO
═════════════════════════════════════════════════

- `01-network-map.md` — all hosts in one map.
- `03-tcp-udp-connections-and-sockets.md` — what happens after the name resolves.
- `07-timeouts-retries-pooling-and-backpressure.md` — why retrying the same host doesn't survive a dead host.
