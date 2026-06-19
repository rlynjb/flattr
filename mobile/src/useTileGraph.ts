// mobile/src/useTileGraph.ts — viewport + route-corridor coverage on top of the bundled
// base graph. Instead of stitching together dozens of tiny per-tile fetches (slow: each
// is its own Overpass + elevation round-trip, and they fill the screen unevenly), we
// fetch the WHOLE visible viewport in ONE graph build, and likewise the WHOLE corridor
// between two route endpoints. Both are stitched into the merged graph so routing and
// display cross seams. One network build runs at a time (corridor has priority) to stay
// under the free Overpass/Open-Meteo rate limits.
import { useCallback, useMemo, useRef, useState } from "react";
import type { Graph } from "features/routing/types";
import { prefixGraph, mergeGraphs, stitchGraph } from "features/map/tiles";
import { fetchOverpass } from "pipeline/overpass";
import { buildGraph } from "pipeline/build-graph";
import { openMeteoProvider, type ElevationProvider } from "pipeline/elevation";

// Connectivity/coverage over fidelity: if the elevation API is down/throttled, build
// with flat (0 m) elevation rather than failing the whole build — the streets still
// render and routing still connects; grades fill in on a later load when the API recovers.
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

const DEBOUNCE_MS = 600;
const MAX_CORRIDOR_SPAN_DEG = 0.12; // ~13 km — refuse routes wider than this (too far)
const MAX_SEG_M = 90; // match the ~90m free DEM
const DEDUPE = 0.0008; // ~90m elevation sample dedup
const MAX_LOAD_SPAN_DEG = 0.06; // don't load when zoomed further out than ~a few km
const VIEW_PAD = 0.2; // pad the viewport fetch so small pans don't trigger a refetch

type Bbox = [number, number, number, number];
type Region = { bbox: Bbox; graph: Graph };

export type RegionEvent = {
  nativeEvent: { center: [number, number]; bounds?: Bbox };
};

/** Does region `r` fully contain `bbox`? */
function covers(r: Region | null, bbox: Bbox): boolean {
  if (!r) return false;
  const [w, s, e, n] = bbox;
  return r.bbox[0] <= w && r.bbox[1] <= s && r.bbox[2] >= e && r.bbox[3] >= n;
}

function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

export function useTileGraph(baseGraph: Graph | null): {
  graph: Graph | null;
  loadingStep: string | null;
  onRegionDidChange: (e: RegionEvent) => void;
  ensureBbox: (bbox: Bbox) => boolean;
} {
  const [view, setView] = useState<Region | null>(null);
  const [corridor, setCorridor] = useState<Region | null>(null);
  const [loadingStep, setLoadingStep] = useState<string | null>(null);

  const viewRef = useRef<Region | null>(null);
  const corridorRef = useRef<Region | null>(null);
  const busyRef = useRef(false);
  const pendingViewRef = useRef<Bbox | null>(null);
  const pendingCorridorRef = useRef<Bbox | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const graph = useMemo(
    // stitch coincident boundary nodes so routing crosses base/view/corridor seams.
    () =>
      baseGraph
        ? stitchGraph(
            mergeGraphs([
              baseGraph,
              ...(corridor ? [corridor.graph] : []),
              ...(view ? [view.graph] : []),
            ])
          )
        : null,
    [baseGraph, corridor, view]
  );

  // One graph build at a time. The route corridor takes priority over the viewport so a
  // pending route isn't starved by panning. After each build, drain the next request.
  const pump = useCallback(() => {
    if (busyRef.current) return;
    let kind: "corridor" | "view";
    let bbox: Bbox;
    if (pendingCorridorRef.current) {
      kind = "corridor";
      bbox = pendingCorridorRef.current;
      pendingCorridorRef.current = null;
    } else if (pendingViewRef.current) {
      kind = "view";
      bbox = pendingViewRef.current;
      pendingViewRef.current = null;
    } else {
      return;
    }
    busyRef.current = true;
    setLoadingStep("Fetching streets");
    (async () => {
      try {
        const osm = await fetchOverpass(bbox);
        // Fail-fast elevation (few retries) so a throttled build degrades to flat quickly
        // instead of stalling the screen on doomed 429 backoffs.
        const elev = bestEffortElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 }));
        const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, { dedupePrecision: DEDUPE }, setLoadingStep);
        const region: Region = { bbox, graph: prefixGraph(g, kind) };
        if (kind === "corridor") {
          corridorRef.current = region;
          setCorridor(region);
        } else {
          viewRef.current = region;
          setView(region);
        }
      } catch {
        // Overpass failed (rate-limit/offline) — keep the last region; a later pan retries.
      } finally {
        busyRef.current = false;
        setLoadingStep(null);
        pump(); // drain the next pending request (corridor first)
      }
    })();
  }, []);

  const onRegionDidChange = useCallback(
    (e: RegionEvent) => {
      const { bounds } = e.nativeEvent;
      if (!bounds) return;
      if (bounds[2] - bounds[0] > MAX_LOAD_SPAN_DEG || bounds[3] - bounds[1] > MAX_LOAD_SPAN_DEG) {
        return; // zoomed out too far (e.g. world view before GPS)
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        // Already fully shown by the base graph or the current viewport fetch? skip.
        if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;
        if (covers(viewRef.current, bounds)) return;
        const [w, s, e, n] = bounds;
        const px = (e - w) * VIEW_PAD;
        const py = (n - s) * VIEW_PAD;
        pendingViewRef.current = [w - px, s - py, e + px, n + py];
        pump();
      }, DEBOUNCE_MS);
    },
    [baseGraph, pump]
  );

  // Ensure the merged graph covers the bbox spanning both route endpoints, so they sit
  // in one connected component. Skips if the current corridor already contains it.
  // Returns false if the span is too wide to route.
  const ensureBbox = useCallback(
    (bbox: Bbox): boolean => {
      const [w, s, e, n] = bbox;
      if (e - w > MAX_CORRIDOR_SPAN_DEG || n - s > MAX_CORRIDOR_SPAN_DEG) return false;
      if (covers(corridorRef.current, bbox)) return true;
      pendingCorridorRef.current = bbox;
      pump();
      return true;
    },
    [pump]
  );

  return { graph, loadingStep, onRegionDidChange, ensureBbox };
}
