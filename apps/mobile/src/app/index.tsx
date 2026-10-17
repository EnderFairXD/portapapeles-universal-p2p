import { StyleSheet, Text, View } from 'react-native';

// Marcador temporal: la pantalla nueva llega en la Tarea 13.
export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>ClipSync</Text>
      <Text style={styles.subtitle}>En construcción</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a' },
  title: { color: '#f8fafc', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#94a3b8', fontSize: 16, marginTop: 8 },
});
