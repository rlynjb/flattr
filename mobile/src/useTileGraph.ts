// mobile/src/useTileGraph.ts — pan-to-load coverage. Starts from the bundled base
// graph; as the map center enters an unloaded tile, debounce, fetch OSM + Open-Meteo
// elevation, build that tile on-device, and merge it in (cached, LRU-capped).
import { useCallback, useMemo, useRef, useState } from "react";
import type { Graph } from "features/routing/types";
import { tileKeyOf, tileBbox, prefixGraph, mergeGraphs } from "features/map/tiles";
import { fetchOverpass } from "pipeline/overpass";
import { buildGraph } from "pipeline/build-graph";
import { openMeteoProvider } from "pipeline/elevation";

const DEBOUNCE_MS = 800;
const MAX_TILES = 24; // LRU cap to bound memory/render cost (smaller tiles -> keep more)
const MAX_SEG_M = 90; // match the ~90m free DEM (see pipeline)
const DEDUPE = 0.0008; // ~90m sample dedup (rate-limit friendly)

export type RegionEvent = { nativeEvent: { center: [number, number] } };

export function useTileGraph(baseGraph: Graph | null): {
  graph: Graph | null;
  loadingKey: string | null;
  onRegionDidChange: (e: RegionEvent) => void;
} {
  const [tiles, setTiles] = useState<{ key: string; graph: Graph }[]>([]);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());
  const loadingRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const graph = useMemo(
    () => (baseGraph ? mergeGraphs([baseGraph, ...tiles.map((t) => t.graph)]) : null),
    [baseGraph, tiles]
  );

  const coveredByBase = useCallback(
    (lng: number, lat: number) => {
      if (!baseGraph) return true; // nothing to load against
      const [w, s, e, n] = baseGraph.bbox;
      return lng >= w && lng <= e && lat >= s && lat <= n;
    },
    [baseGraph]
  );

  const loadTile = useCallback(async (key: string) => {
    if (loadedRef.current.has(key) || loadingRef.current.has(key)) return;
    loadingRef.current.add(key);
    setLoadingKey(key);
    try {
      const bbox = tileBbox(key);
      const osm = await fetchOverpass(bbox);
      const g = await buildGraph(key, bbox, osm, openMeteoProvider(), MAX_SEG_M, {
        dedupePrecision: DEDUPE,
      });
      loadedRef.current.add(key);
      setTiles((prev) => {
        const next = [...prev, { key, graph: prefixGraph(g, key) }];
        while (next.length > MAX_TILES) {
          const dropped = next.shift();
          if (dropped) loadedRef.current.delete(dropped.key);
        }
        return next;
      });
    } catch {
      // rate-limited / offline — leave the area uncovered; a later pan retries.
    } finally {
      loadingRef.current.delete(key);
      setLoadingKey((cur) => (cur === key ? null : cur));
    }
  }, []);

  const onRegionDidChange = useCallback(
    (e: RegionEvent) => {
      const [lng, lat] = e.nativeEvent.center;
      if (coveredByBase(lng, lat)) return;
      const key = tileKeyOf(lng, lat);
      if (loadedRef.current.has(key) || loadingRef.current.has(key)) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => loadTile(key), DEBOUNCE_MS);
    },
    [coveredByBase, loadTile]
  );

  return { graph, loadingKey, onRegionDidChange };
}
