// mobile/src/MapScreen.tsx — heatmap + tap-to-route + userMax slider (v11 MapLibre).
import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Map, Camera, GeoJSONSource, Layer, Marker } from "@maplibre/maplibre-react-native";
import { graphToGeoJSON, routeToGeoJSON, bboxToCameraBounds } from "../../features/map/geojson";
import { bandsForUserMax } from "../../features/grade/classify";
import { nearestNode } from "../../features/routing/nearest";
import { directedAstar } from "../../features/routing/astar";
import { loadGraph } from "./loadGraph";
import { GradeSlider } from "./GradeSlider";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_USERMAX = 8; // Walking preset

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

  // Heatmap recolors with userMax (abs-grade bands).
  const heatmap = useMemo(
    () => (graph ? graphToGeoJSON(graph, bandsForUserMax(userMax)) : null),
    [graph, userMax]
  );

  // Route is derived from endpoints + userMax (directedAstar on-device).
  const route = useMemo(() => {
    if (!graph || !startId || !endId) return null;
    const r = directedAstar(graph, startId, endId, userMax);
    return r.path ? routeToGeoJSON(graph, r.path, userMax) : null;
  }, [graph, startId, endId, userMax]);

  const noRoute = graph != null && startId != null && endId != null && route == null;

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
      // first tap, or third tap after a complete pair -> restart
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

  return (
    <View style={styles.root}>
      <Map style={styles.map} mapStyle={STYLE_URL} onPress={handlePress}>
        <Camera bounds={bboxToCameraBounds(graph.bbox)} />
        <GeoJSONSource id="edges" data={heatmap as unknown as GeoJSON.FeatureCollection}>
          <Layer id="edge-lines" type="line" style={{ lineColor: ["get", "color"], lineWidth: 2 }} />
        </GeoJSONSource>
        {route && (
          <GeoJSONSource id="route" data={route as unknown as GeoJSON.FeatureCollection}>
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
      {noRoute && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>No route between those points.</Text>
        </View>
      )}
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
  banner: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: "rgba(210,59,46,0.92)",
    borderRadius: 8,
    padding: 10,
  },
  bannerText: { color: "#fff", textAlign: "center" },
});
