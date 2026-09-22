import * as DocumentPicker from 'expo-document-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DiscoveredPeer, LogFn, PickedFile, sendFileMessage, sendTextMessage, startLanDiscovery } from '@/lib/lanTransport';

type TransportId = 'lan' | 'usb' | 'bluetooth';

const TRANSPORTS: { id: TransportId; label: string; available: boolean }[] = [
  { id: 'lan', label: 'LAN', available: true },
  { id: 'usb', label: 'USB', available: false },
  { id: 'bluetooth', label: 'Bluetooth', available: false },
];

const colors = {
  bg: '#0d0e24',
  surface: '#171935',
  surfaceAlt: '#1f2247',
  border: '#2c2f5c',
  indigo: '#6366f1',
  indigoDeep: '#4338ca',
  cyan: '#22d3ee',
  text: '#eef0fb',
  textMuted: '#8d90bd',
  danger: '#f87171',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Pantalla de depuración/demo de la Fase 2: sin pulido final, pero ya con los flujos
 * reales (selección de dispositivo, payload texto/archivo, selector de transporte)
 * en vez de un botón único que auto-envía al primer peer encontrado.
 */
export default function DiscoveryScreen() {
  const [logs, setLogs] = useState<string[]>([]);
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<DiscoveredPeer | null>(null);
  const [scanning, setScanning] = useState(false);
  const [transport, setTransport] = useState<TransportId>('lan');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [sending, setSending] = useState(false);
  const stopDiscoveryRef = useRef<(() => void) | null>(null);

  const log = useCallback<LogFn>((msg, level = 'info') => {
    console.log(`[LAN] ${msg}`);
    const line = `[${new Date().toLocaleTimeString()}] ${level === 'error' ? '⚠️ ' : ''}${msg}`;
    setLogs((prev) => [line, ...prev].slice(0, 100));
  }, []);

  useEffect(() => () => stopDiscoveryRef.current?.(), []);

  const handleScan = useCallback(() => {
    if (scanning) return;
    setScanning(true);
    setPeers([]);
    setSelectedPeer(null);
    stopDiscoveryRef.current = startLanDiscovery((found) => {
      setPeers((prev) =>
        prev.some((p) => p.host === found.host && p.port === found.port) ? prev : [...prev, found],
      );
    }, log);
  }, [log, scanning]);

  const handleStopScan = useCallback(() => {
    stopDiscoveryRef.current?.();
    stopDiscoveryRef.current = null;
    setScanning(false);
  }, []);

  const handleSelectPeer = useCallback(
    (peer: DiscoveredPeer) => {
      setSelectedPeer(peer);
      log(`PC seleccionado: ${peer.name} (${peer.host}:${peer.port})`);
    },
    [log],
  );

  const handlePickFile = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setFile({
      uri: asset.uri,
      name: asset.name,
      size: asset.size ?? 0,
      mimeType: asset.mimeType ?? 'application/octet-stream',
    });
    log(`Archivo adjuntado: ${asset.name} (${formatBytes(asset.size ?? 0)})`);
  }, [log]);

  const canSend = !!selectedPeer && !sending && (message.trim().length > 0 || !!file);

  const handleSend = useCallback(async () => {
    if (!selectedPeer) return;
    setSending(true);
    try {
      if (file) {
        await sendFileMessage(selectedPeer, file, log);
        setFile(null);
      } else {
        await sendTextMessage(selectedPeer, message.trim(), log);
        setMessage('');
      }
    } catch {
      // el detalle del error ya quedó registrado por sendTextMessage/sendFileMessage vía log()
    } finally {
      setSending(false);
    }
  }, [selectedPeer, file, message, log]);

  const handleTransportPress = useCallback(
    (id: TransportId) => {
      const target = TRANSPORTS.find((t) => t.id === id);
      if (!target?.available) {
        log(`Transporte "${target?.label}" — próximamente`, 'error');
        return;
      }
      setTransport(id);
    },
    [log],
  );

  return (
    <View style={styles.container}>
      <LinearGradient colors={[colors.indigoDeep, colors.bg]} style={styles.header}>
        <Text style={styles.title}>ClipSync</Text>
        <Text style={styles.subtitle}>Portapapeles universal P2P — Fase 2 (LAN)</Text>
      </LinearGradient>

      <View style={styles.body}>
        <View style={styles.pillRow}>
          {TRANSPORTS.map((t) => {
            const active = t.id === transport;
            return (
              <Pressable
                key={t.id}
                onPress={() => handleTransportPress(t.id)}
                style={[styles.pill, active && styles.pillActive, !t.available && styles.pillDisabled]}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{t.label}</Text>
                {!t.available && <Text style={styles.pillBadge}>🔒 Próximamente</Text>}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Dispositivos en la LAN</Text>
          <Pressable onPress={scanning ? handleStopScan : handleScan} style={styles.scanButton}>
            {scanning && <ActivityIndicator size="small" color={colors.cyan} style={styles.scanSpinner} />}
            <Text style={styles.scanButtonText}>{scanning ? 'Detener' : 'Buscar'}</Text>
          </Pressable>
        </View>

        {peers.length === 0 ? (
          <Text style={styles.emptyText}>
            {scanning ? 'Buscando…' : 'Sin dispositivos descubiertos todavía. Pulsa "Buscar".'}
          </Text>
        ) : (
          <FlatList
            data={peers}
            keyExtractor={(p) => `${p.host}:${p.port}`}
            style={styles.peerList}
            renderItem={({ item }) => {
              const selected = selectedPeer?.host === item.host && selectedPeer?.port === item.port;
              return (
                <Pressable
                  onPress={() => handleSelectPeer(item)}
                  style={[styles.peerRow, selected && styles.peerRowSelected]}
                >
                  <View>
                    <Text style={styles.peerName}>{item.name}</Text>
                    <Text style={styles.peerAddress}>
                      {item.host}:{item.port}
                    </Text>
                  </View>
                  {selected && <Text style={styles.peerCheck}>✓</Text>}
                </Pressable>
              );
            }}
          />
        )}

        <Text style={styles.sectionTitle}>Mensaje</Text>
        <TextInput
          style={[styles.input, !!file && styles.inputDisabled]}
          placeholder="Escribe o pega el texto a enviar…"
          placeholderTextColor={colors.textMuted}
          value={message}
          onChangeText={(text) => {
            setMessage(text);
            if (text.length > 0) setFile(null);
          }}
          multiline
          editable={!file}
        />

        <View style={styles.attachRow}>
          <Pressable
            onPress={handlePickFile}
            disabled={message.trim().length > 0}
            style={[styles.attachButton, message.trim().length > 0 && styles.attachButtonDisabled]}
          >
            <Text style={styles.attachButtonText}>📎 Adjuntar archivo</Text>
          </Pressable>
          {file && (
            <View style={styles.attachedFile}>
              <Text style={styles.attachedFileName} numberOfLines={1}>
                {file.name}
              </Text>
              <Text style={styles.attachedFileSize}>{formatBytes(file.size)}</Text>
              <Pressable onPress={() => setFile(null)} hitSlop={8}>
                <Text style={styles.attachedFileRemove}>✕</Text>
              </Pressable>
            </View>
          )}
        </View>

        <Pressable onPress={handleSend} disabled={!canSend} style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}>
          {sending ? (
            <ActivityIndicator size="small" color={colors.bg} />
          ) : (
            <Text style={[styles.sendButtonText, !canSend && styles.sendButtonTextDisabled]}>
              {selectedPeer ? `Enviar a ${selectedPeer.name}` : 'Selecciona un PC primero'}
            </Text>
          )}
        </Pressable>

        <FlatList
          style={styles.logList}
          data={logs}
          keyExtractor={(_, index) => String(index)}
          renderItem={({ item }) => <Text style={styles.logLine}>{item}</Text>}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingBottom: 20, paddingHorizontal: 20 },
  title: { fontSize: 26, fontWeight: '700', color: colors.text, letterSpacing: 0.5 },
  subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 16, gap: 12 },

  pillRow: { flexDirection: 'row', gap: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillActive: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  pillDisabled: { opacity: 0.55 },
  pillText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  pillTextActive: { color: colors.text },
  pillBadge: { color: colors.textMuted, fontSize: 9 },

  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  scanSpinner: { marginRight: 6 },
  scanButtonText: { color: colors.cyan, fontSize: 13, fontWeight: '700' },

  emptyText: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic', paddingVertical: 6 },

  peerList: { maxHeight: 140 },
  peerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  peerRowSelected: { borderColor: colors.cyan, backgroundColor: colors.surfaceAlt },
  peerName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  peerAddress: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  peerCheck: { color: colors.cyan, fontSize: 16, fontWeight: '700' },

  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    color: colors.text,
    fontSize: 14,
    minHeight: 70,
    textAlignVertical: 'top',
  },
  inputDisabled: { opacity: 0.4 },

  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  attachButton: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  attachButtonDisabled: { opacity: 0.4 },
  attachButtonText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  attachedFile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    maxWidth: 220,
  },
  attachedFileName: { color: colors.text, fontSize: 12, maxWidth: 120 },
  attachedFileSize: { color: colors.textMuted, fontSize: 11 },
  attachedFileRemove: { color: colors.danger, fontSize: 13, fontWeight: '700', paddingHorizontal: 2 },

  sendButton: {
    backgroundColor: colors.cyan,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { backgroundColor: colors.surfaceAlt },
  sendButtonText: { color: colors.bg, fontSize: 15, fontWeight: '700' },
  sendButtonTextDisabled: { color: colors.textMuted },

  logList: {
    flex: 1,
    marginTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingTop: 8,
  },
  logLine: { fontFamily: 'monospace', fontSize: 10, color: colors.textMuted, paddingVertical: 1 },
});
