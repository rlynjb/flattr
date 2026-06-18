// mobile/src/GradeSlider.tsx — userMax control as a VERTICAL slider (green/flat at
// bottom, red/steep at top), presets below. The thumb is your max grade: below it
// (gentler) reads green, above it (steeper) reads red.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import Slider from "@react-native-community/slider";
import { USERMAX_PRESETS } from "features/grade/classify";

const SLIDER_LEN = 180; // visual height of the rotated slider

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
      <Text style={styles.value}>{userMax.toFixed(0)}%</Text>
      <View style={styles.sliderBox}>
        <Slider
          style={styles.slider}
          minimumValue={2}
          maximumValue={15}
          step={1}
          value={userMax}
          onValueChange={onChange}
          // rotated -90deg => min (2%) at the BOTTOM, max (15%) at the TOP.
          // filled (min->thumb) green = grades you accept; remainder red = too steep.
          minimumTrackTintColor="#2e9e3f"
          maximumTrackTintColor="#d23b2e"
          thumbTintColor="#1565c0"
        />
      </View>
      <View style={styles.chips}>
        {USERMAX_PRESETS.map((p) => (
          <Pressable key={p.label} style={styles.chip} onPress={() => onChange(p.userMax)}>
            <Text style={styles.chipText}>
              {p.label} {p.userMax}%
            </Text>
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
    top: 150, // below the legend (top-left)
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  label: { fontWeight: "600", fontSize: 11, color: "#444" },
  value: { fontWeight: "700", fontSize: 16, marginBottom: 4 },
  // The slider lays out as SLIDER_LEN x 40, then rotates into this LEN-tall box.
  sliderBox: { width: 44, height: SLIDER_LEN, alignItems: "center", justifyContent: "center" },
  slider: { width: SLIDER_LEN, height: 40, transform: [{ rotate: "-90deg" }] },
  chips: { marginTop: 8, alignItems: "stretch" },
  chip: {
    backgroundColor: "#eef0f2",
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 6,
  },
  chipText: { fontSize: 12, textAlign: "center" },
});
