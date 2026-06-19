// mobile/src/AddressBar.tsx — From/To inputs with autocomplete suggestions, a
// "use current location" button on From, and a Route button. Controlled by MapScreen.
import React from "react";
import { View, TextInput, Pressable, Text, ScrollView, StyleSheet } from "react-native";
import type { GeocodeResult } from "pipeline/geocode";

export type Field = "from" | "to";

function Suggestions({
  items,
  onSelect,
}: {
  items: GeocodeResult[];
  onSelect: (r: GeocodeResult) => void;
}): React.JSX.Element {
  return (
    <ScrollView style={styles.suggest} keyboardShouldPersistTaps="handled">
      {items.map((r, i) => (
        <Pressable key={`${r.lat},${r.lng},${i}`} style={styles.suggestRow} onPress={() => onSelect(r)}>
          <Text style={styles.suggestText} numberOfLines={2}>
            {r.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export function AddressBar({
  fromText,
  toText,
  onFromChange,
  onToChange,
  onFocusField,
  activeField,
  onUseCurrentLocation,
  onSwap,
  suggestions,
  suggestField,
  onSelectSuggestion,
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
  onSwap: () => void;
  suggestions: GeocodeResult[];
  suggestField: Field | null;
  onSelectSuggestion: (f: Field, r: GeocodeResult) => void;
  onRoute: (from: string, to: string) => void;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const canRoute = fromText.trim().length > 0 && toText.trim().length > 0 && !busy;
  const hint =
    activeField === "from"
      ? "Type, or tap the map to set From"
      : activeField === "to"
        ? "Type, or tap the map to set To"
        : null;
  return (
    <View style={styles.bar}>
      <View style={styles.fieldRow}>
        <TextInput
          style={[styles.input, activeField === "from" && styles.inputActive]}
          placeholder="From — address or place"
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
      {suggestField === "from" && suggestions.length > 0 && (
        <Suggestions items={suggestions} onSelect={(r) => onSelectSuggestion("from", r)} />
      )}
      <View style={styles.fieldRow}>
        <TextInput
          style={[styles.input, activeField === "to" && styles.inputActive]}
          placeholder="To — address or place"
          placeholderTextColor="#888"
          value={toText}
          onChangeText={onToChange}
          onFocus={() => onFocusField("to")}
          autoCapitalize="none"
          returnKeyType="go"
          onSubmitEditing={() => canRoute && onRoute(fromText, toText)}
        />
        <Pressable style={styles.swapBtn} onPress={onSwap} accessibilityLabel="Swap From and To">
          <Text style={styles.swapIcon}>⇅</Text>
        </Pressable>
      </View>
      {suggestField === "to" && suggestions.length > 0 && (
        <Suggestions items={suggestions} onSelect={(r) => onSelectSuggestion("to", r)} />
      )}
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
  swapBtn: {
    marginLeft: 6,
    width: 40,
    height: 39,
    borderRadius: 8,
    backgroundColor: "#eef0f2",
    borderWidth: 1,
    borderColor: "#1565c0",
    alignItems: "center",
    justifyContent: "center",
  },
  swapIcon: { color: "#1565c0", fontSize: 18, fontWeight: "700" },
  suggest: { maxHeight: 168, backgroundColor: "#fff", borderRadius: 8, marginBottom: 6, borderWidth: 1, borderColor: "#e3e6e8" },
  suggestRow: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#eee" },
  suggestText: { fontSize: 13, color: "#222" },
  row: { flexDirection: "row", alignItems: "center" },
  hint: { flex: 1, color: "#1565c0", fontSize: 12, marginRight: 8 },
  error: { color: "#d23b2e" },
  go: { backgroundColor: "#1565c0", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  goDisabled: { backgroundColor: "#9bb8da" },
  goText: { color: "#fff", fontWeight: "700" },
});
