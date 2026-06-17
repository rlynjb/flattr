// mobile/src/RouteSummaryCard.tsx — honest route status (clean / flattest-but-steep / no route).
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import type { RouteSummary } from "features/routing/summary";

export function RouteSummaryCard({
  found,
  summary,
  userMax,
}: {
  found: boolean;
  summary: RouteSummary | null;
  userMax: number;
}): React.JSX.Element | null {
  if (!found || !summary) {
    if (found) return null; // no endpoints yet -> nothing to show
    return (
      <View style={[styles.card, styles.bad]}>
        <Text style={styles.badText}>No route between those points.</Text>
      </View>
    );
  }

  const km = (summary.distanceM / 1000).toFixed(2);
  const climb = Math.round(summary.climbM);
  const clean = summary.steepCount === 0;

  return (
    <View style={[styles.card, clean ? styles.ok : styles.warn]}>
      <Text style={styles.title}>{clean ? "Flat all the way" : "⚠ Flattest available"}</Text>
      {!clean && (
        <Text style={styles.detail}>
          {summary.steepCount} steep block{summary.steepCount === 1 ? "" : "s"} ({">"}
          {userMax}%)
        </Text>
      )}
      <Text style={styles.detail}>
        {km} km · +{climb} m climb
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", top: 12, left: 12, right: 12, borderRadius: 10, padding: 10 },
  ok: { backgroundColor: "rgba(46,158,63,0.92)" },
  warn: { backgroundColor: "rgba(232,181,0,0.95)" },
  bad: { backgroundColor: "rgba(210,59,46,0.92)" },
  title: { color: "#fff", fontWeight: "700" },
  detail: { color: "#fff" },
  badText: { color: "#fff", textAlign: "center", fontWeight: "600" },
});
