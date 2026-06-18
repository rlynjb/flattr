// mobile/src/GradeSlider.tsx — slim vertical Max-grade control: green/flat bottom →
// red/steep top, with icon preset buttons below (kick scooter / walking / any).
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import Slider from "@react-native-community/slider";
import { USERMAX_PRESETS } from "features/grade/classify";

const SLIDER_LEN = 180; // visual height of the rotated slider
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
      <Text style={styles.label}>Max</Text>
      <Text style={styles.value}>{userMax.toFixed(0)}%</Text>
      <View style={styles.sliderBox}>
        <Slider
          style={styles.slider}
          minimumValue={2}
          maximumValue={15}
          step={1}
          value={userMax}
          onValueChange={onChange}
          minimumTrackTintColor="#2e9e3f"
          maximumTrackTintColor="#d23b2e"
          thumbTintColor="#1565c0"
        />
      </View>
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
    top: 150, // below the legend
    width: 64, // slim
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  label: { fontWeight: "600", fontSize: 10, color: "#666" },
  value: { fontWeight: "700", fontSize: 15, marginBottom: 4 },
  sliderBox: { width: 40, height: SLIDER_LEN, alignItems: "center", justifyContent: "center" },
  slider: { width: SLIDER_LEN, height: 40, transform: [{ rotate: "-90deg" }] },
  chips: { marginTop: 8, alignItems: "center" },
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
