// mobile/src/useTileGraph.ts — viewport + route-corridor coverage on top of the bundled
// base graph. Instead of stitching together dozens of tiny per-tile fetches (slow: each
// is its own Overpass + elevation round-trip, and they fill the screen unevenly), we
// fetch the WHOLE visible viewport in ONE graph build, and likewise the WHOLE corridor
// between two route endpoints. Both are stitched into the merged graph so routing and
// display cross seams. One network build runs at a time (corridor has priority) to stay
// under the free Overpass/Open-Meteo rate limits.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "features/routing/types";
import { prefixGraph, mergeGraphs, stitchGraph } from "features/map/tiles";
import { fetchOverpass } from "pipeline/overpass";
import { buildGraph } from "pipeline/build-graph";
import { openMeteoProvider, type ElevationProvider } from "pipeline/elevation";
import { loadElevCache, getElev, putElev } from "./elevCache";

// Connectivity/coverage over fidelity: if the elevation API is down/throttled, build
// with flat (0 m) elevation rather than failing the whole build — the streets still
// render and routing still connects. `onFallback` flags that the grades are bogus
// (all flat) so the region can be retried once the API recovers.
function bestEffortElevation(p: ElevationProvider, onFallback: () => void): ElevationProvider {
  return {
    async sample(points) {
      try {
        return await p.sample(points);
      } catch {
        onFallback();
        return points.map(() => 0);
      }
    },
  };
}

// Elevation cache keyed by ~90m DEM cell, backed by the persistent store in elevCache.ts.
// Overlapping/revisited areas need ZERO elevation requests — the main cause of throttling
// — and survive app restarts. Only real (successfully fetched) values are cached.
const cellKey = (lat: number, lng: number) => `${Math.round(lat / DEDUPE)},${Math.round(lng / DEDUPE)}`;

function cachedElevation(p: ElevationProvider): ElevationProvider {
  return {
    async sample(points) {
      const out = new Array<number>(points.length);
      const missPts: { lat: number; lng: number }[] = [];
      const missIdx: number[] = [];
      points.forEach((pt, i) => {
        const hit = getElev(cellKey(pt.lat, pt.lng));
        if (hit !== undefined) out[i] = hit;
        else {
          missPts.push(pt);
          missIdx.push(i);
        }
      });
      if (missPts.length) {
        const got = await p.sample(missPts); // throws when throttled -> caller flattens
        got.forEach((e, j) => {
          out[missIdx[j]] = e;
          putElev(cellKey(missPts[j].lat, missPts[j].lng), e);
        });
      }
      return out;
    },
  };
}

const DEBOUNCE_MS = 600;
const MAX_RETRIES = 6; // silent flat-fallback retries before giving up (keeps last data)
const MAX_CORRIDOR_SPAN_DEG = 0.12; // ~13 km — refuse routes wider than this (too far)
const MAX_SEG_M = 90; // match the ~90m free DEM
const DEDUPE = 0.0008; // ~90m elevation sample dedup
const MAX_LOAD_SPAN_DEG = 0.06; // don't load when zoomed further out than ~a few km
const VIEW_PAD = 0.2; // pad the viewport fetch so small pans don't trigger a refetch
const RETRY_MS = 12000; // re-fetch a flat-fallback region this often until grades load

type Bbox = [number, number, number, number];
// `degraded` = built with flat fallback elevation (API was throttled); needs a retry.
type Region = { bbox: Bbox; graph: Graph; degraded: boolean };

export type RegionEvent = {
  nativeEvent: { center: [number, number]; bounds?: Bbox };
};

/** Does region `r` fully contain `bbox` with real (non-degraded) grades? */
function covers(r: Region | null, bbox: Bbox): boolean {
  if (!r || r.degraded) return false; // degraded → refetch to upgrade flat grades
  const [w, s, e, n] = bbox;
  return r.bbox[0] <= w && r.bbox[1] <= s && r.bbox[2] >= e && r.bbox[3] >= n;
}

function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

// `gradesOn` gates VIEWPORT grade-loading (the heatmap/zones data). When off, panning
// loads nothing — the map stays clean and we make no elevation requests. Routing (the
// corridor via ensureBbox) is independent and always works. Turning it on loads the
// current view.
export function useTileGraph(
  baseGraph: Graph | null,
  gradesOn: boolean
): {
  graph: Graph | null;
  displayGraph: Graph | null;
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
  // pending requests carry `silent` — user pans/routes show the loader; background
  // self-heal retries don't, so the overlay doesn't flash while grades catch up.
  const pendingViewRef = useRef<{ bbox: Bbox; silent: boolean } | null>(null);
  const pendingCorridorRef = useRef<{ bbox: Bbox; silent: boolean } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const gradesOnRef = useRef(gradesOn);
  const lastBoundsRef = useRef<Bbox | null>(null);

  // Load the persisted elevation cache once, so previously-fetched areas have real grades
  // immediately and don't re-hit the throttled elevation API.
  useEffect(() => {
    loadElevCache();
  }, []);

  // Routing graph: includes everything (even flat-fallback regions) — flat grades are
  // fine for connectivity, and excluding them would break "no route" again.
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

  // Display graph (heatmap/zones): EXCLUDES degraded (flat-fallback) regions so their
  // bogus all-green grades don't paint over the real grades underneath. They reappear
  // once the self-heal retry lands real elevation.
  const displayGraph = useMemo(
    () =>
      baseGraph
        ? stitchGraph(
            mergeGraphs([
              baseGraph,
              ...(corridor && !corridor.degraded ? [corridor.graph] : []),
              ...(view && !view.degraded ? [view.graph] : []),
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
    let req: { bbox: Bbox; silent: boolean };
    if (pendingCorridorRef.current) {
      kind = "corridor";
      req = pendingCorridorRef.current;
      pendingCorridorRef.current = null;
    } else if (pendingViewRef.current) {
      kind = "view";
      req = pendingViewRef.current;
      pendingViewRef.current = null;
    } else {
      return;
    }
    const { bbox, silent } = req;
    busyRef.current = true;
    if (!silent) setLoadingStep("Fetching streets");
    (async () => {
      try {
        const osm = await fetchOverpass(bbox);
        // Cache first (revisits need no requests), then fail-fast elevation so a throttled
        // build degrades to flat quickly instead of stalling on doomed 429 backoffs.
        let degraded = false;
        const elev = bestEffortElevation(
          cachedElevation(openMeteoProvider(fetch, { delayMs: 400, retries: 1 })),
          () => {
            degraded = true;
          }
        );
        const onPhase = silent ? undefined : setLoadingStep;
        const g = await buildGraph(kind, bbox, osm, elev, MAX_SEG_M, { dedupePrecision: DEDUPE }, onPhase);
        const region: Region = { bbox, graph: prefixGraph(g, kind), degraded };
        if (kind === "corridor") {
          corridorRef.current = region;
          setCorridor(region);
        } else {
          viewRef.current = region;
          setView(region);
        }
        // Grades came back flat (API throttled). Quietly re-queue this area so green
        // self-heals once the API recovers — no loader flash, and capped so it doesn't
        // loop forever during a sustained outage. A real (non-degraded) build stops it.
        if (degraded && retryCountRef.current < MAX_RETRIES) {
          retryCountRef.current += 1;
          if (retryRef.current) clearTimeout(retryRef.current);
          retryRef.current = setTimeout(() => {
            if (viewRef.current?.degraded) pendingViewRef.current = { bbox: viewRef.current.bbox, silent: true };
            if (corridorRef.current?.degraded)
              pendingCorridorRef.current = { bbox: corridorRef.current.bbox, silent: true };
            pump();
          }, RETRY_MS);
        }
      } catch {
        // Overpass failed (rate-limit/offline) — keep the last region; a later pan retries.
      } finally {
        busyRef.current = false;
        if (!silent) setLoadingStep(null);
        pump(); // drain the next pending request (corridor first)
      }
    })();
  }, []);

  // Fetch grade data for the current viewport (no debounce). Skips if the base graph or
  // current viewport region already covers it.
  const queueViewport = useCallback(
    (bounds: Bbox) => {
      if (baseGraph && bboxContains(baseGraph.bbox, bounds)) return;
      if (covers(viewRef.current, bounds)) return;
      const [w, s, e, n] = bounds;
      const px = (e - w) * VIEW_PAD;
      const py = (n - s) * VIEW_PAD;
      retryCountRef.current = 0; // new area → fresh self-heal budget
      pendingViewRef.current = { bbox: [w - px, s - py, e + px, n + py], silent: false };
      pump();
    },
    [baseGraph, pump]
  );

  const onRegionDidChange = useCallback(
    (e: RegionEvent) => {
      const { bounds } = e.nativeEvent;
      if (!bounds) return;
      if (bounds[2] - bounds[0] > MAX_LOAD_SPAN_DEG || bounds[3] - bounds[1] > MAX_LOAD_SPAN_DEG) {
        return; // zoomed out too far (e.g. world view before GPS)
      }
      lastBoundsRef.current = bounds; // remembered so toggling grades on loads this view
      if (!gradesOnRef.current) return; // heatmap off → don't load grade data while panning
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => queueViewport(bounds), DEBOUNCE_MS);
    },
    [queueViewport]
  );

  // When grades are toggled on, load the current view immediately (no pan needed).
  useEffect(() => {
    gradesOnRef.current = gradesOn;
    if (gradesOn && lastBoundsRef.current) queueViewport(lastBoundsRef.current);
  }, [gradesOn, queueViewport]);

  // Ensure the merged graph covers the bbox spanning both route endpoints, so they sit
  // in one connected component. Skips if the current corridor already contains it.
  // Returns false if the span is too wide to route.
  const ensureBbox = useCallback(
    (bbox: Bbox): boolean => {
      const [w, s, e, n] = bbox;
      if (e - w > MAX_CORRIDOR_SPAN_DEG || n - s > MAX_CORRIDOR_SPAN_DEG) return false;
      if (covers(corridorRef.current, bbox)) return true;
      retryCountRef.current = 0;
      pendingCorridorRef.current = { bbox, silent: false };
      pump();
      return true;
    },
    [pump]
  );

  return { graph, displayGraph, loadingStep, onRegionDidChange, ensureBbox };
}
