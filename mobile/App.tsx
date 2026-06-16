import React from "react";
import { SafeAreaView, StatusBar, StyleSheet } from "react-native";
import { MapScreen } from "./src/MapScreen";

export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <MapScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
