// mobile/src/GradeSlider.tsx — Max-grade control: three preset buttons
// (kick scooter / walking / any). Each sets the steepest uphill you'll tolerate.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { USERMAX_PRESETS } from "features/grade/classify";

const ICONS: Record<string, string> = {
  "Kick scooter": "🛴",
  Walking: "🚶",
  Any: "🏔️",
};

export function GradeSlider({
  userMax,
  onChange,
}: {
  userMax: number;
  onChange: (userMax: number) => void;
}): React.JSX.Element {
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Max grade</Text>
      <View style={styles.chips}>
        {USERMAX_PRESETS.map((p) => (
          <Pressable
            key={p.label}
            style={[styles.chip, userMax === p.userMax && styles.chipOn]}
            onPress={() => onChange(p.userMax)}
            accessibilityLabel={`${p.label} ${p.userMax}%`}
          >
            <Text style={styles.icon}>{ICONS[p.label] ?? "•"}</Text>
            <Text style={styles.pct}>{p.userMax}%</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 12,
    top: 268, // below the legend (which sits below the address bar)
    width: 64, // slim
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  label: { fontWeight: "600", fontSize: 10, color: "#666", marginBottom: 2 },
  chips: { alignItems: "center" },
  chip: {
    width: 50,
    backgroundColor: "#eef0f2",
    borderRadius: 10,
    paddingVertical: 5,
    marginTop: 6,
    alignItems: "center",
  },
  chipOn: { backgroundColor: "#cfe3ff", borderWidth: 1, borderColor: "#1565c0" },
  icon: { fontSize: 20 },
  pct: { fontSize: 10, color: "#444", marginTop: 1 },
});
