// mobile/src/useTileGraph.ts — pan-to-load coverage with background neighbor preloading.
// Starts from the bundled base graph. On pan, the center tile loads (showing the
// progress overlay) and its 4 neighbors preload SILENTLY, so panning into them is
// instant. All loads run serially (one network round-trip at a time) to stay under
// the free Overpass/Open-Meteo rate limits; tiles are cached and LRU-capped.
import { useCallback, useMemo, useRef, useState } from "react";
import type { Graph } from "features/routing/types";
import { tileKeyOf, tileBbox, prefixGraph, mergeGraphs, stitchGraph, TILE_W, TILE_H } from "features/map/tiles";
import { fetchOverpass } from "pipeline/overpass";
import { buildGraph } from "pipeline/build-graph";
import { openMeteoProvider, type ElevationProvider } from "pipeline/elevation";

// Connectivity over fidelity: if the elevation API is down/throttled, build the
// corridor with flat (0 m) elevation so the route still connects, rather than failing
// the whole build with "no route". Grades in that stretch read flat until a reload.
function bestEffortElevation(p: ElevationProvider): ElevationProvider {
  return {
    async sample(points) {
      try {
        return await p.sample(points);
      } catch {
        return points.map(() => 0);
      }
    },
  };
}

const DEBOUNCE_MS = 800;
const MAX_TILES = 80; // LRU cap on display tiles — must hold a full screen's worth + margin
const MAX_VIEW_TILES = 64; // cap tiles enqueued per pan (nearest-to-center wins)
const MAX_CORRIDOR_SPAN_DEG = 0.12; // ~13 km — refuse routes wider than this (too far)
const MAX_SEG_M = 90; // match the ~90m free DEM
const DEDUPE = 0.0008; // ~90m elevation sample dedup
const MAX_LOAD_SPAN_DEG = 0.06; // don't load when zoomed further out than ~a few km

export type RegionEvent = {
  nativeEvent: { center: [number, number]; bounds?: [number, number, number, number] };
};

type QueueItem = { key: string; silent: boolean };

function neighborKeys(key: string): string[] {
  const [c, r] = key.split(",").map(Number);
  return [`${c + 1},${r}`, `${c - 1},${r}`, `${c},${r + 1}`, `${c},${r - 1}`];
}

// Every tile key intersecting `bounds`, ordered nearest-to-center first so the middle
// of the screen fills before the edges. Capped to MAX_VIEW_TILES.
function tilesInBounds(
  bounds: [number, number, number, number],
  center: [number, number]
): string[] {
  const [w, s, e, n] = bounds;
  const c0 = Math.floor(w / TILE_W);
  const c1 = Math.floor(e / TILE_W);
  const r0 = Math.floor(s / TILE_H);
  const r1 = Math.floor(n / TILE_H);
  const cc = center[0] / TILE_W;
  const cr = center[1] / TILE_H;
  const keys: { key: string; d: number }[] = [];
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      keys.push({ key: `${c},${r}`, d: (c + 0.5 - cc) ** 2 + (r + 0.5 - cr) ** 2 });
    }
  }
  keys.sort((a, b) => a.d - b.d);
  return keys.slice(0, MAX_VIEW_TILES).map((k) => k.key);
}

export function useTileGraph(baseGraph: Graph | null): {
  graph: Graph | null;
  loadingStep: string | null;
  onRegionDidChange: (e: RegionEvent) => void;
  ensureBbox: (bbox: [number, number, number, number]) => boolean;
} {
  const [tiles, setTiles] = useState<{ key: string; graph: Graph }[]>([]);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set()); // built tiles
  const queuedRef = useRef<Set<string>>(new Set()); // queued or in-flight
  const queueRef = useRef<QueueItem[]>([]);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The route corridor: one graph covering the bbox between the two endpoints, built
  // in a SINGLE Overpass+elevation fetch (far faster than dozens of tiny tiles) and
  // stitched into the merged graph so start and end land in one connected component.
  const [corridor, setCorridor] = useState<{ bbox: [number, number, number, number]; graph: Graph } | null>(null);
  const corridorRef = useRef<{ bbox: [number, number, number, number]; graph: Graph } | null>(null);
  const corridorBusyRef = useRef(false);
  const pendingBboxRef = useRef<[number, number, number, number] | null>(null);

  const graph = useMemo(
    // stitch coincident boundary nodes so routing crosses tile/base/corridor seams.
    () =>
      baseGraph
        ? stitchGraph(
            mergeGraphs([baseGraph, ...(corridor ? [corridor.graph] : []), ...tiles.map((t) => t.graph)])
          )
        : null,
    [baseGraph, corridor, tiles]
  );

  const coveredByBase = useCallback(
    (lng: number, lat: number) => {
      if (!baseGraph) return true;
      const [w, s, e, n] = baseGraph.bbox;
      return lng >= w && lng <= e && lat >= s && lat <= n;
    },
    [baseGraph]
  );

  // Process the queue one tile at a time. Primary items show the progress overlay;
  // silent (preload) items don't touch loadingStep.
  const pump = useCallback(() => {
    if (busyRef.current || corridorBusyRef.current) return; // don't compete with a corridor build
    const item = queueRef.current.shift();
    if (!item) return;
    busyRef.current = true;
    if (!item.silent) setLoadingStep("Fetching streets");
    (async () => {
      try {
        const bbox = tileBbox(item.key);
        const osm = await fetchOverpass(bbox);
        // best-effort elevation: a throttled tile still loads (flat) rather than leaving
        // a blank hole in the screen — grades fill in on a later pan when the API recovers.
        const elev = bestEffortElevation(openMeteoProvider());
        const g = await buildGraph(item.key, bbox, osm, elev, MAX_SEG_M, { dedupePrecision: DEDUPE }, item.silent ? undefined : setLoadingStep);
        loadedRef.current.add(item.key);
        setTiles((prev) => {
          const next = [...prev, { key: item.key, graph: prefixGraph(g, item.key) }];
          while (next.length > MAX_TILES) {
            const dropped = next.shift();
            if (dropped) {
              loadedRef.current.delete(dropped.key);
              queuedRef.current.delete(dropped.key);
            }
          }
          return next;
        });
      } catch {
        // rate-limited / offline — drop it; a later pan retries.
      } finally {
        queuedRef.current.delete(item.key);
        busyRef.current = false;
        if (!item.silent) setLoadingStep(null);
        pump();
      }
    })();
  }, []);

  const enqueue = useCallback(
    (key: string, silent: boolean) => {
      if (loadedRef.current.has(key) || queuedRef.current.has(key)) return;
      const [w, s, e, n] = tileBbox(key);
      if (coveredByBase((w + e) / 2, (s + n) / 2)) return; // already in the base graph
      queuedRef.current.add(key);
      if (silent) queueRef.current.push({ key, silent });
      else queueRef.current.unshift({ key, silent }); // primary jumps the line
      pump();
    },
    [coveredByBase, pump]
  );

  const onRegionDidChange = useCallback(
    (e: RegionEvent) => {
      const { center, bounds } = e.nativeEvent;
      if (bounds && (bounds[2] - bounds[0] > MAX_LOAD_SPAN_DEG || bounds[3] - bounds[1] > MAX_LOAD_SPAN_DEG)) {
        return; // zoomed out too far (e.g. world view before GPS)
      }
      const [lng, lat] = center;
      const key = tileKeyOf(lng, lat);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        // drop not-yet-started SILENT preloads from a previous area (keep primary
        // items like a route corridor), then queue every tile in the visible screen
        // so grades cover the whole viewport, not just the center.
        queueRef.current = queueRef.current.filter((it) => {
          if (it.silent) queuedRef.current.delete(it.key);
          return !it.silent;
        });
        enqueue(key, false); // center: primary (shows overlay)
        const screen = bounds ? tilesInBounds(bounds, center) : neighborKeys(key);
        for (const k of screen) if (k !== key) enqueue(k, true); // rest: silent, center-out
      }, DEBOUNCE_MS);
    },
    [enqueue]
  );

  // Build (or rebuild) the corridor graph for the latest requested bbox. One fetch at
  // a time; if a newer bbox arrives mid-build it runs next.
  const pumpCorridor = useCallback(() => {
    if (corridorBusyRef.current) return;
    const bbox = pendingBboxRef.current;
    if (!bbox) return;
    pendingBboxRef.current = null;
    corridorBusyRef.current = true;
    setLoadingStep("Fetching streets");
    (async () => {
      try {
        const osm = await fetchOverpass(bbox);
        // Gentler throttle + more retries: the corridor sends several elevation batches
        // at once, which trips the free Open-Meteo rate limit under the default config.
        const elev = bestEffortElevation(openMeteoProvider(fetch, { delayMs: 500, retries: 2 }));
        const g = await buildGraph("corridor", bbox, osm, elev, MAX_SEG_M, { dedupePrecision: DEDUPE }, setLoadingStep);
        corridorRef.current = { bbox, graph: prefixGraph(g, "corridor") };
        setCorridor(corridorRef.current);
      } catch {
        // overpass failed (rate-limit/offline) — leave the corridor as-is; user can retry.
      } finally {
        corridorBusyRef.current = false;
        setLoadingStep(null);
        pumpCorridor(); // pick up any newer request that arrived while building
        pump(); // resume display-tile loading now that the corridor is done
      }
    })();
  }, [pump]);

  // Ensure the merged graph covers the bbox spanning both route endpoints, so they sit
  // in one connected component. Skips if the current corridor already contains it.
  // Returns false if the span is too wide to route.
  const ensureBbox = useCallback(
    (bbox: [number, number, number, number]): boolean => {
      const [w, s, e, n] = bbox;
      if (e - w > MAX_CORRIDOR_SPAN_DEG || n - s > MAX_CORRIDOR_SPAN_DEG) return false;
      const cb = corridorRef.current?.bbox;
      if (cb && cb[0] <= w && cb[1] <= s && cb[2] >= e && cb[3] >= n) return true; // already covered
      pendingBboxRef.current = bbox;
      pumpCorridor();
      return true;
    },
    [pumpCorridor]
  );

  return { graph, loadingStep, onRegionDidChange, ensureBbox };
}
