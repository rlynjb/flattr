// mobile/src/MapScreen.tsx — heatmap/zones toggle + tap-to-route + slider + honesty card.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StatusBar, StyleSheet } from "react-native";
import { Map, Camera, GeoJSONSource, Layer, Marker, type CameraRef } from "@maplibre/maplibre-react-native";
import * as Location from "expo-location";
import { graphToGeoJSON, routeToGeoJSON, zonesToGeoJSON } from "features/map/geojson";
import { bandsForUserMax } from "features/grade/classify";
import { computeZones } from "features/grade/zones";
import { nearestNode } from "features/routing/nearest";
import { directedAstar } from "features/routing/astar";
import { routeSummary, type RouteSummary } from "features/routing/summary";
import { prefixGraph } from "features/map/tiles";
import { geocode } from "pipeline/geocode";
import { loadGraph } from "./loadGraph";
import { useTileGraph } from "./useTileGraph";
import { GradeSlider } from "./GradeSlider";
import { RouteSummaryCard } from "./RouteSummaryCard";
import { Legend } from "./Legend";
import { AddressBar } from "./AddressBar";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const DEFAULT_USERMAX = 8;
const GRID_N = 16;
const STATUS_BAR_INSET = StatusBar.currentHeight ?? 24; // keep overlays below the phone status bar

export function MapScreen(): React.JSX.Element {
  // Bundled area is the base tile; panning loads more tiles and merges them in.
  const baseGraph = useMemo(() => {
    try {
      return prefixGraph(loadGraph(), "base");
    } catch {
      return null;
    }
  }, []);
  const { graph, loadingStep, onRegionDidChange } = useTileGraph(baseGraph);

  // Center of the bundled base area — the camera's initial/fallback target so it
  // never opens at world view before the GPS fix lands.
  const baseCenter = useMemo<[number, number]>(() => {
    const b = baseGraph?.bbox ?? [-122.3284, 47.6181, -122.3214, 47.6241];
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }, [baseGraph]);

  const [userMax, setUserMax] = useState(DEFAULT_USERMAX);
  const [startId, setStartId] = useState<string | null>(null);
  const [endId, setEndId] = useState<string | null>(null);
  const [view, setView] = useState<"edges" | "zones">("edges");
  const [userLoc, setUserLoc] = useState<[number, number] | null>(null); // [lng, lat]
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const cameraRef = useRef<CameraRef>(null);

  // Fetch the phone's current location. `recenter` animates the camera to it (for
  // the locate button); at launch we just set userLoc and the Camera centers via prop.
  const locate = useCallback(async (recenter: boolean) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      setUserLoc(c);
      if (recenter) cameraRef.current?.easeTo({ center: c, zoom: 15, duration: 600 });
    } catch {
      // ignore — keep the bbox fallback
    }
  }, []);

  // Locate on launch (centers the map there; falls back to the data area if denied).
  useEffect(() => {
    locate(false);
  }, [locate]);

  // Locate button: snap to the last-known location immediately (responsive), then
  // refresh from GPS in the background and ease to the fresh fix if it moved.
  const recenter = useCallback(() => {
    if (userLoc) cameraRef.current?.easeTo({ center: userLoc, zoom: 15, duration: 500 });
    locate(true);
  }, [userLoc, locate]);

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

  // Geocode From/To addresses, snap each to the nearest graph node, and route.
  const handleRoute = async (from: string, to: string) => {
    setRouteBusy(true);
    setRouteError(null);
    try {
      const viewbox = baseGraph?.bbox; // bias results toward the covered area
      const a = await geocode(from, { viewbox });
      const b = await geocode(to, { viewbox }); // sequential: Nominatim allows ~1 req/sec
      if (!a || !b) {
        setRouteError(!a && !b ? "Both addresses not found" : !a ? "From not found" : "To not found");
        return;
      }
      setStartId(nearestNode(graph, { lat: a.lat, lng: a.lng }));
      setEndId(nearestNode(graph, { lat: b.lat, lng: b.lng }));
      cameraRef.current?.easeTo({
        center: [(a.lng + b.lng) / 2, (a.lat + b.lat) / 2],
        zoom: 14,
        duration: 600,
      });
    } catch {
      setRouteError("Lookup failed — try again");
    } finally {
      setRouteBusy(false);
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
      <Map style={styles.map} mapStyle={STYLE_URL} onRegionDidChange={onRegionDidChange}>
        <Camera ref={cameraRef} center={userLoc ?? baseCenter} zoom={userLoc ? 15 : 14} />
        {/* distinct `key` per branch: MapLibre freezes source/layer `id`, so React must
            unmount one and mount the other on toggle, not mutate the id in place. */}
        {view === "edges" ? (
          <GeoJSONSource key="src-edges" id="edges" data={heatmap as unknown as GeoJSON.FeatureCollection}>
            <Layer id="edge-lines" type="line" style={{ lineColor: ["get", "color"], lineWidth: 2 }} />
          </GeoJSONSource>
        ) : (
          <GeoJSONSource key="src-zones" id="zones" data={zonesFC as unknown as GeoJSON.FeatureCollection}>
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
        {userLoc && (
          <Marker id="me" lngLat={userLoc}>
            <View style={styles.meDot} />
          </Marker>
        )}
      </Map>

      {/* All overlays sit in a status-bar-inset layer; box-none lets map gestures pass through. */}
      <View style={styles.overlays} pointerEvents="box-none">
        <View style={styles.toggle}>
          {(["edges", "zones"] as const).map((v) => (
            <Pressable key={v} onPress={() => setView(v)} style={[styles.toggleBtn, view === v && styles.toggleOn]}>
              <Text style={[styles.toggleText, view === v && styles.toggleTextOn]}>{v}</Text>
            </Pressable>
          ))}
        </View>

        {loadingStep && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <View style={styles.loadingCard}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.loadingTitle}>Loading grades</Text>
              <Text style={styles.loadingStep}>{loadingStep}…</Text>
            </View>
          </View>
        )}
        <AddressBar onRoute={handleRoute} busy={routeBusy} error={routeError} />
        <Legend userMax={userMax} />
        <Pressable style={styles.locate} onPress={recenter} accessibilityLabel="Center on my location">
          <Text style={styles.locateIcon}>◎</Text>
        </Pressable>
        {showCard && <RouteSummaryCard found={routed.found} summary={routed.summary} userMax={userMax} />}
        <GradeSlider userMax={userMax} onChange={setUserMax} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  map: { flex: 1 },
  // top offset (not paddingTop): absolute children ignore padding, so shift the box itself.
  overlays: { position: "absolute", top: STATUS_BAR_INSET, left: 0, right: 0, bottom: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { color: "#d23b2e", textAlign: "center" },
  pin: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: "#fff" },
  meDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: "#2979ff", borderWidth: 3, borderColor: "#fff" },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingCard: {
    backgroundColor: "rgba(0,0,0,0.82)",
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 28,
    alignItems: "center",
    minWidth: 200,
  },
  loadingTitle: { color: "#fff", fontSize: 16, fontWeight: "700", marginTop: 12 },
  loadingStep: { color: "#dfe3e6", fontSize: 13, marginTop: 4 },
  locate: {
    position: "absolute",
    right: 16,
    bottom: 90,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.95)",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  locateIcon: { fontSize: 24, color: "#1565c0" },
  toggle: {
    position: "absolute",
    top: 160, // below the address bar, right side
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
