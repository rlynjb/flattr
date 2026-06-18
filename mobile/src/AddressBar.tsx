// mobile/src/AddressBar.tsx — From/To address inputs + Route button. Controlled by
// MapScreen so a map tap (after focusing a field) can auto-fill the address.
// The From field has a "use current location" button on its right.
import React from "react";
import { View, TextInput, Pressable, Text, StyleSheet } from "react-native";

export type Field = "from" | "to";

export function AddressBar({
  fromText,
  toText,
  onFromChange,
  onToChange,
  onFocusField,
  activeField,
  onUseCurrentLocation,
  onRoute,
  busy,
  error,
}: {
  fromText: string;
  toText: string;
  onFromChange: (t: string) => void;
  onToChange: (t: string) => void;
  onFocusField: (f: Field) => void;
  activeField: Field | null;
  onUseCurrentLocation: () => void;
  onRoute: (from: string, to: string) => void;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const canRoute = fromText.trim().length > 0 && toText.trim().length > 0 && !busy;
  const hint =
    activeField === "from"
      ? "Tap the map to set From"
      : activeField === "to"
        ? "Tap the map to set To"
        : null;
  return (
    <View style={styles.bar}>
      <View style={styles.fieldRow}>
        <TextInput
          style={[styles.input, activeField === "from" && styles.inputActive]}
          placeholder="From address"
          placeholderTextColor="#888"
          value={fromText}
          onChangeText={onFromChange}
          onFocus={() => onFocusField("from")}
          autoCapitalize="none"
          returnKeyType="next"
        />
        <Pressable style={styles.locBtn} onPress={onUseCurrentLocation} accessibilityLabel="Use current location">
          <Text style={styles.locIcon}>◎</Text>
        </Pressable>
      </View>
      <TextInput
        style={[styles.input, styles.toInput, activeField === "to" && styles.inputActive]}
        placeholder="To address"
        placeholderTextColor="#888"
        value={toText}
        onChangeText={onToChange}
        onFocus={() => onFocusField("to")}
        autoCapitalize="none"
        returnKeyType="go"
        onSubmitEditing={() => canRoute && onRoute(fromText, toText)}
      />
      <View style={styles.row}>
        <Text style={[styles.hint, error && styles.error]} numberOfLines={1}>
          {error ?? hint ?? ""}
        </Text>
        <Pressable
          style={[styles.go, !canRoute && styles.goDisabled]}
          onPress={() => canRoute && onRoute(fromText, toText)}
          disabled={!canRoute}
        >
          <Text style={styles.goText}>{busy ? "Routing…" : "Route"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    top: 8,
    left: 8,
    right: 8,
    backgroundColor: "rgba(255,255,255,0.96)",
    borderRadius: 12,
    padding: 8,
  },
  fieldRow: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  input: {
    flex: 1,
    backgroundColor: "#f1f3f5",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: "#111",
    borderWidth: 1,
    borderColor: "transparent",
  },
  toInput: { marginBottom: 6 },
  inputActive: { borderColor: "#1565c0", backgroundColor: "#eaf2ff" },
  locBtn: {
    marginLeft: 6,
    width: 40,
    height: 39,
    borderRadius: 8,
    backgroundColor: "#1565c0",
    alignItems: "center",
    justifyContent: "center",
  },
  locIcon: { color: "#fff", fontSize: 18 },
  row: { flexDirection: "row", alignItems: "center" },
  hint: { flex: 1, color: "#1565c0", fontSize: 12, marginRight: 8 },
  error: { color: "#d23b2e" },
  go: { backgroundColor: "#1565c0", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  goDisabled: { backgroundColor: "#9bb8da" },
  goText: { color: "#fff", fontWeight: "700" },
});
