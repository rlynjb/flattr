// mobile/src/MapScreen.tsx — heatmap/zones toggle + tap-to-route + slider + honesty card.
import React, { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Map, Camera, GeoJSONSource, Layer, Marker } from "@maplibre/maplibre-react-native";
import {
  graphToGeoJSON,
  routeToGeoJSON,
  zonesToGeoJSON,
  bboxToCameraBounds,
} from "features/map/geojson";
import { bandsForUserMax } from "features/grade/classify";
import { computeZones } from "features/grade/zones";
import { nearestNode } from "features/routing/nearest";
import { directedAstar } from "features/routing/astar";
import { routeSummary, type RouteSummary } from "features/routing/summary";
import { loadGraph } from "./loadGraph";
import { GradeSlider } from "./GradeSlider";
import { RouteSummaryCard } from "./RouteSummaryCard";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_USERMAX = 8;
const GRID_N = 16;

export function MapScreen(): React.JSX.Element {
  const graph = useMemo(() => {
    try {
      return loadGraph();
    } catch {
      return null;
    }
  }, []);

  const [userMax, setUserMax] = useState(DEFAULT_USERMAX);
  const [startId, setStartId] = useState<string | null>(null);
  const [endId, setEndId] = useState<string | null>(null);
  const [view, setView] = useState<"edges" | "zones">("edges");

  const heatmap = useMemo(
    () => (graph ? graphToGeoJSON(graph, bandsForUserMax(userMax)) : null),
    [graph, userMax]
  );
  const zoneCells = useMemo(() => (graph ? computeZones(graph, GRID_N) : []), [graph]);
  const zonesFC = useMemo(() => zonesToGeoJSON(zoneCells, userMax), [zoneCells, userMax]);

  // One directedAstar call -> route line + summary + found flag.
  const routed = useMemo(() => {
    if (!graph || !startId || !endId) {
      return { fc: null as ReturnType<typeof routeToGeoJSON> | null, summary: null as RouteSummary | null, found: true };
    }
    const r = directedAstar(graph, startId, endId, userMax);
    if (!r.path) return { fc: null, summary: null as RouteSummary | null, found: false };
    return {
      fc: routeToGeoJSON(graph, r.path, userMax),
      summary: routeSummary(graph, r.path, userMax),
      found: true,
    };
  }, [graph, startId, endId, userMax]);

  if (!graph || !heatmap) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to load graph.</Text>
      </View>
    );
  }

  const handlePress = (event: { nativeEvent: { lngLat: [number, number] } }) => {
    const [lng, lat] = event.nativeEvent.lngLat;
    const id = nearestNode(graph, { lat, lng });
    if (!startId || (startId && endId)) {
      setStartId(id);
      setEndId(null);
    } else {
      setEndId(id);
    }
  };

  const marker = (id: string, color: string) => {
    const n = graph.nodes[id];
    return (
      <Marker key={id} lngLat={[n.lng, n.lat]}>
        <View style={[styles.pin, { backgroundColor: color }]} />
      </Marker>
    );
  };

  const showCard = startId != null && endId != null;

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={STYLE_URL} onPress={handlePress}>
        <Camera bounds={bboxToCameraBounds(graph.bbox)} />
        {view === "edges" ? (
          <GeoJSONSource id="edges" data={heatmap as unknown as GeoJSON.FeatureCollection}>
            <Layer id="edge-lines" type="line" style={{ lineColor: ["get", "color"], lineWidth: 2 }} />
          </GeoJSONSource>
        ) : (
          <GeoJSONSource id="zones" data={zonesFC as unknown as GeoJSON.FeatureCollection}>
            <Layer id="zone-fill" type="fill" style={{ fillColor: ["get", "color"], fillOpacity: 0.5 }} />
          </GeoJSONSource>
        )}
        {routed.fc && (
          <GeoJSONSource id="route" data={routed.fc as unknown as GeoJSON.FeatureCollection}>
            <Layer
              id="route-line"
              type="line"
              style={{ lineColor: ["get", "color"], lineWidth: 6, lineCap: "round" }}
            />
          </GeoJSONSource>
        )}
        {startId && marker(startId, "#1565c0")}
        {endId && marker(endId, "#000000")}
      </Map>

      <View style={styles.toggle}>
        {(["edges", "zones"] as const).map((v) => (
          <Pressable key={v} onPress={() => setView(v)} style={[styles.toggleBtn, view === v && styles.toggleOn]}>
            <Text style={[styles.toggleText, view === v && styles.toggleTextOn]}>{v}</Text>
          </Pressable>
        ))}
      </View>

      {showCard && <RouteSummaryCard found={routed.found} summary={routed.summary} userMax={userMax} />}
      <GradeSlider userMax={userMax} onChange={setUserMax} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { color: "#d23b2e", textAlign: "center" },
  pin: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: "#fff" },
  toggle: {
    position: "absolute",
    top: 64,
    right: 12,
    flexDirection: "row",
    borderRadius: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#fff",
  },
  toggleBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "rgba(255,255,255,0.9)" },
  toggleOn: { backgroundColor: "#1565c0" },
  toggleText: { fontSize: 12, color: "#1565c0" },
  toggleTextOn: { color: "#fff", fontWeight: "700" },
});
