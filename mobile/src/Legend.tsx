// mobile/src/Legend.tsx — color key. Thresholds track userMax (bandsForUserMax),
// using the same colors as the map (bandColor), so the legend never drifts from
// what's drawn. green/yellow/red are the abs-grade bands (heatmap & zones); grey is
// the route-only "exceeds your max" band.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { bandColor, bandsForUserMax } from "features/grade/classify";

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function Legend({ userMax }: { userMax: number }): React.JSX.Element {
  const { greenMax, yellowMax } = bandsForUserMax(userMax);
  const rows: { band: "green" | "yellow" | "red" | "grey"; label: string }[] = [
    { band: "green", label: `Flat/gentle (≤${fmt(greenMax)}%)` },
    { band: "yellow", label: `Moderate (${fmt(greenMax)}–${fmt(yellowMax)}%)` },
    { band: "red", label: `Steep (>${fmt(yellowMax)}%)` },
    { band: "grey", label: `Over your max` },
  ];
  return (
    <View style={styles.panel}>
      {rows.map((r) => (
        <View key={r.band} style={styles.row}>
          <View style={[styles.swatch, { backgroundColor: bandColor(r.band) }]} />
          <Text style={styles.label}>{r.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    top: 196, // below the slider panel (now at the top)
    left: 12,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  row: { flexDirection: "row", alignItems: "center", marginVertical: 2 },
  swatch: { width: 14, height: 14, borderRadius: 3, marginRight: 8 },
  label: { fontSize: 11, color: "#222" },
});
