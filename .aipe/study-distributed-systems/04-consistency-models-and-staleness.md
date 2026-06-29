# Consistency Models & Staleness

**Industry name(s):** stale reads / eventual consistency / read-repair / availability-over-consistency (the CAP choice) · *Industry standard*

## Zoom out, then zoom in

This is the richest exercised concept in the repo. flattr makes two distinct consistency decisions, both deliberate, and one of them is a textbook CAP tradeoff you can point at in real code.

```
  Zoom out — two layers of "how fresh is this data?"

  ┌─ Local state layer ─────────────────────────────────────────┐
  │  graph.json (bundled)   ★ STALE BY DESIGN ★                  │ ← decision 1
  │   frozen at build time, ships in the app bundle             │
  └────────────────────────┬─────────────────────────────────────┘
                           │ augmented at run time by ↓
  ┌─ Local persistence layer ▼──────────────────────────────────┐
  │  elevCache (AsyncStorage) ★ EVENTUALLY CONSISTENT LOCALLY ★  │ ← decision 2
  │   degraded → self-heal retry → converges to real grades     │
  └────────────────────────┬─────────────────────────────────────┘
                           │ on miss, crosses to ↓
  ┌─ Provider layer ───────▼──────────────────────────────────────┐
  │  Open-Meteo (the source of truth for elevation)              │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** A consistency model answers: when you read, how fresh is the answer, and what's promised? Strong consistency = you always see the latest write. Eventual consistency = you might see a stale value now, but the system converges to fresh given time and no new writes. flattr uses *neither extreme uniformly* — it picks the right weakening for each layer: the base graph is intentionally frozen (staleness is acceptable for street geometry), and the elevation overlay is eventually consistent with an explicit convergence mechanism (because a throttle shouldn't break the map).

## Structure pass

**Layers.** Bundled graph (frozen) → cache (converging) → provider (source of truth).

**The axis: `guarantees` — what's promised about freshness at each layer?** Hold that question constant and walk down:

```
  One question down the layers: "how fresh, and what's promised?"

  ┌─ graph.json (bundled) ──────────────────┐
  │  freshness: as of last `npm run build`   │  → STALE, promised stale
  │  convergence: none (rebuild to refresh)  │     (acceptable: streets rarely move)
  └──────────────────┬───────────────────────┘
  ┌─ elevCache ──────▼───────────────────────┐
  │  freshness: real value OR flat fallback   │  → EVENTUALLY fresh
  │  convergence: self-heal retry (12s loop)  │     (degraded → real)
  └──────────────────┬───────────────────────┘
  ┌─ Open-Meteo ─────▼───────────────────────┐
  │  freshness: authoritative (the DEM)       │  → SOURCE OF TRUTH
  │  convergence: n/a                          │     (but DEM never changes, so
  └───────────────────────────────────────────┘      cached forever is correct)
```

**The seams.** Two. First seam: the bundle boundary — data is frozen on the dev side, read-only on the user side; freshness flips from "live" to "as-of-build." Second seam: the cache miss — `getElev` returns `undefined`, and the read crosses to the provider, where freshness flips from "maybe stale/flat" to "authoritative." Both seams are where a consistency decision got made.

## How it works

### Move 1 — the mental model

You know eventual consistency from any optimistic-UI pattern: you show the user *something* immediately (maybe slightly wrong), then reconcile with the server and correct it. flattr's elevation layer is exactly that shape — show flat grades now if the API is throttled, then quietly upgrade to real grades when it recovers.

```
  The convergence kernel — degraded read that self-heals

  ┌──────────────────────────────────────────────────────────┐
  │ 1. try real elevation                                     │
  │ 2. throttled? → return FLAT (0m), mark region `degraded`  │ ← availability
  │ 3. render immediately (streets connect, map usable)       │   over
  │ 4. schedule a silent retry of the degraded region         │   consistency
  │ 5. retry lands real grades → `degraded` clears → converge │ ← read-repair
  │ 6. (capped at MAX_RETRIES so an outage can't loop forever)│
  └──────────────────────────────────────────────────────────┘
```

Name each part by what breaks without it: drop step 2 and a throttle fails the whole build (no map). Drop step 4 and the flat grades are permanent — never converges. Drop step 6 and a sustained outage retries forever, draining battery and quota. All three are present in `useTileGraph.ts`.

### Move 2 — the walkthrough

**Part 1 — staleness by design (the bundled graph).** The base graph isn't fetched; it's baked and shipped:

```ts
// pipeline/run-build.ts:43-48 — built ONCE, on a dev machine
const osm = await fetchOverpass(BBOX);
const graph = await buildGraph("seattle-mvp", BBOX, osm, provider, maxSegM, sampleOpts);
mkdirSync("data", { recursive: true });
writeGraph(graph, "data/graph.json");   // frozen artifact
```

```ts
// mobile/src/loadGraph.ts:7-11 — read-only at run time, no refresh path
import graph from "../assets/graph.json";
export function loadGraph(): Graph {
  return graph as unknown as Graph;       // whatever the world looked like at build
}
```

This is a *consistency decision*, not an accident. Street geometry changes on the order of years; a graph that's months stale routes you correctly the vast majority of the time. The cost — owned plainly — is that a new sidewalk built after the last `npm run build:graph` simply doesn't exist in the app until someone rebuilds and reships. That's an acceptable staleness window for this data, and choosing it deliberately is the lesson. (Contrast: you would *never* freeze a bank balance this way.)

**Part 2 — the CAP choice, in one function.** Here's the availability-over-consistency decision as actual code:

```ts
// mobile/src/useTileGraph.ts:20-31
function bestEffortElevation(p: ElevationProvider, onFallback: () => void): ElevationProvider {
  return {
    async sample(points) {
      try {
        return await p.sample(points);       // try for the consistent (real) answer
      } catch {
        onFallback();                        // mark: we gave up consistency
        return points.map(() => 0);          // return AVAILABLE answer (flat) instead
      }
    },
  };
}
```

When Open-Meteo throttles, you have a partition (you can't reach the source of truth). CAP says: pick consistency (fail — show nothing until you can get real grades) or availability (return *an* answer — flat grades — and stay usable). flattr picks **availability**. The comment at `useTileGraph.ts:17-19` states it outright: *"Connectivity/coverage over fidelity... the streets still render and routing still connects."* This is the single clearest distributed-systems decision in the codebase.

**Part 3 — but availability without convergence is just being wrong.** Returning flat grades and stopping there would be a bug — the user would see a permanently flat map. So `degraded` is tracked and drives a self-heal loop:

```ts
// mobile/src/useTileGraph.ts:209-218 — schedule the read-repair
if (degraded && retryCountRef.current < MAX_RETRIES) {  // capped: no infinite loop
  retryCountRef.current += 1;
  if (retryRef.current) clearTimeout(retryRef.current);
  retryRef.current = setTimeout(() => {
    if (viewRef.current?.degraded)                       // still flat? re-queue it
      pendingViewRef.current = { bbox: viewRef.current.bbox, silent: true };  // silent: no spinner
    if (corridorRef.current?.degraded)
      pendingCorridorRef.current = { bbox: corridorRef.current.bbox, silent: true };
    pump();
  }, RETRY_MS);                                          // RETRY_MS = 12000 (12s)
}
```

The `silent: true` flag (set here, consumed at `useTileGraph.ts:183,196,223`) is a nice touch: the self-heal happens in the background without flashing the loading overlay, so grades just *appear* once the API recovers. This is **read-repair** — a stale/degraded value gets corrected on a later access, the same mechanism Dynamo-style stores use to converge replicas.

**Part 4 — two graphs, two consistency policies.** The subtlest part: flattr keeps *two* derived graphs with *different* consistency rules, because routing and display have different tolerance for bad data:

```ts
// mobile/src/useTileGraph.ts — graph (routing) INCLUDES degraded regions:
//   :132-145  flat grades are fine for CONNECTIVITY ("no route" must stay distinct)
// displayGraph (heatmap) EXCLUDES degraded regions:
//   :150-162  so bogus all-flat grades don't paint over real grades
```

```
  Same data, two consistency policies — by use case

  region X is `degraded` (flat fallback)
        │
        ├──► routing graph:  INCLUDE it
        │      (you'd rather route over flat-but-connected streets
        │       than tell the user "no route exists")
        │
        └──► display graph:  EXCLUDE it
               (you'd rather show nothing than paint fake green
                over the real grades the user is trying to read)
```

That's a genuinely sharp call: *availability* wins for routing (include degraded), *consistency* wins for display (exclude degraded). Same underlying data, opposite policy, chosen per use case. Most engineers would use one merged graph and get a subtle "why is the whole hill green?" bug.

**Part 5 — read-your-writes, and why it's trivial here.** A classic consistency hazard: you write, then read, and the read doesn't reflect your write (because it hit a stale replica). flattr can't hit this — there are no writes across the boundary (`03`), and the local cache is write-through in-process (`putElev` updates the in-memory `Map` immediately at `elevCache.ts:35-40`, persistence is just a debounced backup). So a value you just cached is readable instantly on the next `getElev`. Read-your-writes holds for free, locally. It'd become a real concern only with a remote store and multiple readers.

### Move 2.5 — current vs future

```
  Phase A (now)                         Phase B (multi-device sync)
  ─────────────                         ───────────────────────────
  graph frozen at build, reship to      graph still fine to freeze
   refresh                              saved routes need a sync model:
  elevCache: local, converges via        • last-writer-wins? (clock needed → 07)
   self-heal retry                        • CRDT / merge?
  read-your-writes: free (in-process)   read-your-writes: now HARD
                                          (write on phone A, read on phone B)
```

The base-graph staleness model survives untouched into Phase B. What breaks is the moment *user-generated* state (saved routes, preferences) needs to exist on two devices — then you inherit the full eventual-consistency problem and need clocks (`07`) to order writes.

### Move 3 — the principle

Consistency is not one global setting — it's a per-data-class decision. flattr proves it by running three different policies in one app: frozen-stale for street geometry (cheap, acceptable), eventually-consistent-with-read-repair for elevation (availability + convergence), and strong-locally for the in-process cache (free read-your-writes). The skill isn't "pick strong consistency everywhere" — that's expensive and often impossible under partition. It's knowing which data can tolerate staleness, and engineering convergence for the data that can't.

## Primary diagram

```
  Consistency & staleness in flattr — full recap

  ┌─ Local state ───────────────────────────────────────────────┐
  │  graph.json  — FROZEN at build, stale-by-design, reship=refresh│
  └────────────────────────┬─────────────────────────────────────┘
                           │ augmented per viewport/corridor
  ┌─ Coordination ─────────▼─────────────────────────────────────┐
  │  sample(points)                                              │
  │    cache hit ─────────────────► real grade (instant, fresh)  │
  │    cache miss ─► Open-Meteo ─┬─ ok    → cache + use (fresh)   │
  │                              └─ 429   → FLAT + mark degraded  │ ← CAP: availability
  │                                          │                    │
  │   degraded region ──► silent retry (12s, capped) ──► converge │ ← read-repair
  │                                                               │
  │   routing graph:  include degraded (connectivity wins)        │ ← policy A
  │   display graph:  exclude degraded (correctness wins)         │ ← policy B
  └────────────────────────┬─────────────────────────────────────┘
                           ▼
  ┌─ Local persistence ──────────────────────────────────────────┐
  │  elevCache (AsyncStorage): in-mem write-through + debounced disk│
  │  DEM never changes → cached forever is CORRECT, not just cheap  │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

CAP (Brewer) says: under a network partition you must choose consistency *or* availability — you can't have both while partitioned. flattr's `bestEffortElevation` is a literal CAP choice: the throttle is the partition, flat-fallback is the availability pick. PACELC extends it: *else* (no partition) you trade latency vs consistency — which is exactly why the cache exists (cached-stale-but-instant beats fresh-but-slow). Read-repair and the convergence loop come from the Dynamo lineage (eventual consistency + anti-entropy). The reason flattr can get away with "cache forever" is domain-specific and worth saying out loud: a Copernicus DEM elevation sample for a fixed coordinate is immutable — the ground doesn't move — so there's no invalidation problem at all, which is the rare case where a cache has no staleness cost. Sibling `study-database-systems` covers the storage-engine side of the persisted cache; `study-performance-engineering` covers the latency tradeoff.

## Interview defense

**Q: "What's your consistency model?"**
Verdict first: three, one per data class.

```
  three data classes, three policies

  street graph  → frozen / stale-by-design  (reship to refresh)
  elevation     → eventual + read-repair     (degraded→retry→converge)
  local cache   → strong locally             (read-your-writes free)
```

"I don't have one global model — I picked per data class. Street geometry is frozen at build time and shipped in the bundle; it's stale by design because streets barely change and reshipping is cheap enough. Elevation is eventually consistent: if the API throttles I fall back to flat grades to stay available, mark the region degraded, and a capped background retry converges it to real grades once the API recovers — that's read-repair. The in-process cache gives me read-your-writes for free because writes hit memory synchronously before the debounced disk flush."

**Anchor:** *Frozen for geometry, eventual-with-repair for elevation, strong-locally for the cache — consistency is a per-data-class call.*

**Q: "Defend showing the user flat grades — isn't that just wrong data?"**
"It's a deliberate CAP choice. A throttle is a partition; I can either fail the whole map (consistency) or render flat-but-connected streets (availability). I pick availability because an unusable map is worse than a temporarily-flat one — and crucially it's not *permanently* wrong: it's marked degraded and self-heals. I also keep two graphs so the flat data is included for routing connectivity but excluded from the heatmap, so it never paints fake grades over real ones."

**Anchor:** *Flat-but-converging beats failed — and the two-graph split keeps the lie out of the display.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — the throttle that triggers the fallback.
- `03-idempotency-deduplication-and-delivery-semantics.md` — the cache's *safety* side (this is its *freshness* side).
- `07-clocks-coordination-and-leadership.md` — clocks become necessary the moment you sync writes across devices.
- sibling `study-database-systems` — the persisted-cache storage view.
- sibling `study-performance-engineering` — the latency-vs-freshness tradeoff.
