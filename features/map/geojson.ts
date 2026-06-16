// features/map/geojson.ts — Graph -> GeoJSON for the MapLibre heatmap layer.
// Edge.geometry is [lat,lng]; GeoJSON requires [lng,lat] — we flip here (and test it).
import type { Graph } from "../routing/types";
import { classifyAbs, bandColor, type Bands } from "../grade/classify";

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
