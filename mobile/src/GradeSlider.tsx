// mobile/src/GradeSlider.tsx — userMax control: a slider (2-15%) plus preset chips.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import Slider from "@react-native-community/slider";
import { USERMAX_PRESETS } from "features/grade/classify";

export function GradeSlider({
  userMax,
  onChange,
}: {
  userMax: number;
  onChange: (userMax: number) => void;
}): React.JSX.Element {
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Max grade: {userMax.toFixed(0)}%</Text>
      <Slider
        style={styles.slider}
        minimumValue={2}
        maximumValue={15}
        step={1}
        value={userMax}
        onValueChange={onChange}
        minimumTrackTintColor="#2e9e3f"
        maximumTrackTintColor="#d23b2e"
      />
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
    right: 12,
    bottom: 24,
    backgroundColor: "rgba(255,255,255,0.94)",
    borderRadius: 12,
    padding: 12,
  },
  label: { fontWeight: "600", marginBottom: 4 },
  slider: { width: "100%", height: 36 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  chip: { backgroundColor: "#eef0f2", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 12 },
});
