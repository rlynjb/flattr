// mobile/src/useTileGraph.ts — pan-to-load coverage with background neighbor preloading.
// Starts from the bundled base graph. On pan, the center tile loads (showing the
// progress overlay) and its 4 neighbors preload SILENTLY, so panning into them is
// instant. All loads run serially (one network round-trip at a time) to stay under
// the free Overpass/Open-Meteo rate limits; tiles are cached and LRU-capped.
import { useCallback, useMemo, useRef, useState } from "react";
import type { Graph } from "features/routing/types";
import { tileKeyOf, tileBbox, prefixGraph, mergeGraphs, stitchGraph } from "features/map/tiles";
import { fetchOverpass } from "pipeline/overpass";
import { buildGraph } from "pipeline/build-graph";
import { openMeteoProvider } from "pipeline/elevation";

const DEBOUNCE_MS = 800;
const MAX_TILES = 24; // LRU cap on merged tiles
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

export function useTileGraph(baseGraph: Graph | null): {
  graph: Graph | null;
  loadingStep: string | null;
  onRegionDidChange: (e: RegionEvent) => void;
} {
  const [tiles, setTiles] = useState<{ key: string; graph: Graph }[]>([]);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set()); // built tiles
  const queuedRef = useRef<Set<string>>(new Set()); // queued or in-flight
  const queueRef = useRef<QueueItem[]>([]);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const graph = useMemo(
    // stitch coincident boundary nodes so routing crosses tile/base seams.
    () => (baseGraph ? stitchGraph(mergeGraphs([baseGraph, ...tiles.map((t) => t.graph)])) : null),
    [baseGraph, tiles]
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
    if (busyRef.current) return;
    const item = queueRef.current.shift();
    if (!item) return;
    busyRef.current = true;
    if (!item.silent) setLoadingStep("Fetching streets");
    (async () => {
      try {
        const bbox = tileBbox(item.key);
        const osm = await fetchOverpass(bbox);
        const g = await buildGraph(item.key, bbox, osm, openMeteoProvider(), MAX_SEG_M, { dedupePrecision: DEDUPE }, item.silent ? undefined : setLoadingStep);
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
        // drop not-yet-started preloads from a previous area, then queue this one
        for (const it of queueRef.current) queuedRef.current.delete(it.key);
        queueRef.current = [];
        enqueue(key, false); // center: primary (shows overlay)
        for (const nb of neighborKeys(key)) enqueue(nb, true); // neighbors: silent preload
      }, DEBOUNCE_MS);
    },
    [enqueue]
  );

  return { graph, loadingStep, onRegionDidChange };
}
