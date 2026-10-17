import { StyleSheet, View } from 'react-native';

/** Icono de ajustes dibujado con vistas: dos reguladores. */
export function SettingsIcon({ color }: { color: string }) {
  return (
    <View style={styles.box} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.line}>
        <View style={[styles.track, { backgroundColor: color }]} />
        <View style={[styles.knob, { backgroundColor: color, left: 12 }]} />
      </View>
      <View style={styles.line}>
        <View style={[styles.track, { backgroundColor: color }]} />
        <View style={[styles.knob, { backgroundColor: color, left: 3 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 24, height: 24, justifyContent: 'center', gap: 8 },
  line: { height: 8, justifyContent: 'center' },
  track: { height: 2, borderRadius: 1 },
  knob: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
});
