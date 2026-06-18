// mobile/src/AddressBar.tsx — From/To address inputs + Route button (replaces tap-to-route).
import React, { useState } from "react";
import { View, TextInput, Pressable, Text, StyleSheet } from "react-native";

export function AddressBar({
  onRoute,
  busy,
  error,
}: {
  onRoute: (from: string, to: string) => void;
  busy: boolean;
  error: string | null;
}): React.JSX.Element {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const canRoute = from.trim().length > 0 && to.trim().length > 0 && !busy;
  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        placeholder="From address"
        placeholderTextColor="#888"
        value={from}
        onChangeText={setFrom}
        autoCapitalize="none"
        returnKeyType="next"
      />
      <TextInput
        style={styles.input}
        placeholder="To address"
        placeholderTextColor="#888"
        value={to}
        onChangeText={setTo}
        autoCapitalize="none"
        returnKeyType="go"
        onSubmitEditing={() => canRoute && onRoute(from, to)}
      />
      <View style={styles.row}>
        {error ? <Text style={styles.error}>{error}</Text> : <View style={{ flex: 1 }} />}
        <Pressable
          style={[styles.go, !canRoute && styles.goDisabled]}
          onPress={() => canRoute && onRoute(from, to)}
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
  input: {
    backgroundColor: "#f1f3f5",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    marginBottom: 6,
    color: "#111",
  },
  row: { flexDirection: "row", alignItems: "center" },
  error: { flex: 1, color: "#d23b2e", fontSize: 12 },
  go: { backgroundColor: "#1565c0", borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  goDisabled: { backgroundColor: "#9bb8da" },
  goText: { color: "#fff", fontWeight: "700" },
});
