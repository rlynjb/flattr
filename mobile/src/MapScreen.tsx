// mobile/src/MapScreen.tsx — native MapLibre map: OpenFreeMap basemap + grade-colored edges.
// Targets @maplibre/maplibre-react-native v11 (Map / Camera / GeoJSONSource / Layer).
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Map, Camera, GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { graphToGeoJSON, bboxToCameraBounds } from "../../features/map/geojson";
import { loadGraph } from "./loadGraph";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export function MapScreen(): React.JSX.Element {
  let geojson: ReturnType<typeof graphToGeoJSON>;
  let bounds: ReturnType<typeof bboxToCameraBounds>;
  try {
    const graph = loadGraph();
    geojson = graphToGeoJSON(graph);
    bounds = bboxToCameraBounds(graph.bbox);
  } catch (err) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to load graph: {String(err)}</Text>
      </View>
    );
  }

  return (
    <Map style={styles.map} mapStyle={STYLE_URL}>
      <Camera bounds={bounds} />
      {geojson.features.length > 0 && (
        <GeoJSONSource id="edges" data={geojson as unknown as GeoJSON.FeatureCollection}>
          <Layer
            id="edge-lines"
            type="line"
            style={{ lineColor: ["get", "color"], lineWidth: 3, lineCap: "round" }}
          />
        </GeoJSONSource>
      )}
    </Map>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { color: "#d23b2e", textAlign: "center" },
});
