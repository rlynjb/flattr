// features/map/geojson.ts — Graph -> GeoJSON for the MapLibre heatmap layer.
// Edge.geometry is [lat,lng]; GeoJSON requires [lng,lat] — we flip here (and test it).
import type { Graph, Path } from "../routing/types";
import { classifyAbs, classifyDirected, bandColor, bandsForUserMax, type Bands } from "../grade/classify";
import { directedGrade, edgeById } from "../routing/graph";
import type { ZoneCell } from "../grade/zones";

export type EdgeFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { id: string; absGradePct: number; color: string };
};

export type EdgeFeatureCollection = {
  type: "FeatureCollection";
  features: EdgeFeature[];
};

/** Convert graph edges to a colored GeoJSON FeatureCollection (color via classifyAbs). */
export function graphToGeoJSON(graph: Graph, bands?: Bands): EdgeFeatureCollection {
  const features: EdgeFeature[] = graph.edges.map((e) => ({
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: e.geometry.map(([lat, lng]) => [lng, lat] as [number, number]),
    },
    properties: {
      id: e.id,
      absGradePct: e.absGradePct,
      color: bandColor(classifyAbs(e.absGradePct, bands)),
    },
  }));
  return { type: "FeatureCollection", features };
}

// MapLibre RN v11 LngLatBounds is a flat [west, south, east, north] tuple — which
// is exactly our Graph bbox [minLng, minLat, maxLng, maxLat]. This named helper
// documents that match and gives the map a typed bounds value.
export type LngLatBounds = [west: number, south: number, east: number, north: number];

/** Graph bbox [minLng,minLat,maxLng,maxLat] -> MapLibre v11 LngLatBounds (identical shape). */
export function bboxToCameraBounds(bbox: [number, number, number, number]): LngLatBounds {
  return [bbox[0], bbox[1], bbox[2], bbox[3]];
}

/**
 * The edges of a resolved route as GeoJSON, each colored by its DIRECTED grade in
 * the travel direction (spec §7) — a descent is green even on a steep edge.
 * `path.edges[i]` is traversed starting from `path.nodes[i]`.
 */
export function routeToGeoJSON(graph: Graph, path: Path, userMax: number): EdgeFeatureCollection {
  const features: EdgeFeature[] = path.edges.map((edgeId, i) => {
    const edge = edgeById(graph, edgeId);
    const fromNode = path.nodes[i];
    const g = directedGrade(edge, fromNode);
    return {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: edge.geometry.map(([lat, lng]) => [lng, lat] as [number, number]),
      },
      properties: {
        id: edge.id,
        absGradePct: edge.absGradePct,
        color: bandColor(classifyDirected(g, userMax)),
      },
    };
  });
  return { type: "FeatureCollection", features };
}

export type ZoneFeature = {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: { color: string; value: number };
};

export type ZoneFeatureCollection = {
  type: "FeatureCollection";
  features: ZoneFeature[];
};

/** Zone cells as colored GeoJSON polygons; color via userMax-driven abs-grade bands. */
export function zonesToGeoJSON(cells: ZoneCell[], userMax: number): ZoneFeatureCollection {
  const bands = bandsForUserMax(userMax);
  const features: ZoneFeature[] = cells.map((c) => {
    const [minLng, minLat, maxLng, maxLat] = c.bbox;
    const ring: [number, number][] = [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat], // closed
    ];
    return {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { color: bandColor(classifyAbs(c.value, bands)), value: c.value },
    };
  });
  return { type: "FeatureCollection", features };
}
