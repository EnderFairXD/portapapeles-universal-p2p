import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, FlatList, StyleSheet, Text, View } from 'react-native';

import { DiscoveredPeer, LogFn, sendTextMessage, startLanDiscovery } from '@/lib/lanTransport';

/**
 * Pantalla de depuración de la Fase 2: sin diseño definitivo todavía, solo lo mínimo
 * para disparar el descubrimiento mDNS y el envío TCP, y ver los logs en pantalla
 * además de la consola de Metro/logcat.
 */
export default function DiscoveryScreen() {
  const [logs, setLogs] = useState<string[]>([]);
  const [peer, setPeer] = useState<DiscoveredPeer | null>(null);
  const [scanning, setScanning] = useState(false);
  const stopDiscoveryRef = useRef<(() => void) | null>(null);

  const log = useCallback<LogFn>((message, level = 'info') => {
    console.log(`[LAN] ${message}`);
    const line = `[${new Date().toLocaleTimeString()}] ${level === 'error' ? '⚠️ ' : ''}${message}`;
    setLogs((prev) => [line, ...prev].slice(0, 100));
  }, []);

  useEffect(() => () => stopDiscoveryRef.current?.(), []);

  const handleScan = useCallback(() => {
    if (scanning) return;
    setScanning(true);
    setPeer(null);
    stopDiscoveryRef.current = startLanDiscovery((found) => {
      setPeer(found);
      stopDiscoveryRef.current?.();
      setScanning(false);
    }, log);
  }, [log, scanning]);

  const handleSend = useCallback(() => {
    if (!peer) return;
    sendTextMessage(peer, `Hola desde el móvil 👋 (${new Date().toLocaleTimeString()})`, log).catch(() => {
      // el error ya quedó registrado por sendTextMessage vía `log`
    });
  }, [peer, log]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Portapapeles Universal P2P</Text>
      <Text style={styles.subtitle}>Fase 2 — LanTransport (mDNS + TCP)</Text>

      <View style={styles.actions}>
        <Button title={scanning ? 'Buscando…' : 'Buscar PC en la LAN'} onPress={handleScan} disabled={scanning} />
        <Button title="Enviar mensaje de prueba" onPress={handleSend} disabled={!peer} />
      </View>

      <Text style={styles.peer}>
        {peer ? `Peer: ${peer.name} (${peer.host}:${peer.port})` : 'Sin peer descubierto todavía'}
      </Text>

      <FlatList
        style={styles.logList}
        data={logs}
        keyExtractor={(_, index) => String(index)}
        renderItem={({ item }) => <Text style={styles.logLine}>{item}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60, paddingHorizontal: 16, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '600' },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 16 },
  actions: { gap: 8, marginBottom: 16 },
  peer: { marginBottom: 12, fontSize: 13, color: '#333' },
  logList: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#ddd' },
  logLine: { fontFamily: 'monospace', fontSize: 11, paddingVertical: 2 },
});
