import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { LinearGradient } from 'expo-linear-gradient';
import * as Network from 'expo-network';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DiscoveredPeer, LogFn, PickedFile, sendFileMessage, sendTextMessage, startLanDiscovery } from '@/lib/lanTransport';

type TransportId = 'lan' | 'usb' | 'bluetooth';

const TRANSPORTS: { id: TransportId; label: string; available: boolean }[] = [
  { id: 'lan', label: 'LAN', available: true },
  { id: 'usb', label: 'USB', available: false },
  { id: 'bluetooth', label: 'Bluetooth', available: false },
];

/**
 * Puerto y forma de ruta del Modo Invitado, alineados con el diseño seguro de
 * docs/architecture.md §6: puerto 52848 (distinto del 52847 de LanTransport) y
 * `/t/<token>/clipboard`, con token de sesión — sin token, cualquiera en la LAN del PC
 * público podría pedir el clipboard. Sigue siendo un mockup visual: el servidor HTTP real
 * (y la generación/expiración real del token) es trabajo de la fase de implementación.
 */
const GUEST_MODE_PORT = 52848;

function buildGuestModePath(token: string): string {
  return `/t/${token}/clipboard`;
}

/** Token corto de ejemplo para el mockup — en la implementación real se genera por sesión y expira. */
function generateMockToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos (O/0, I/1)
  let token = '';
  for (let i = 0; i < 4; i += 1) {
    token += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return token;
}

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
  const [guestModeVisible, setGuestModeVisible] = useState(false);
  const [deviceIp, setDeviceIp] = useState<string | null>(null);
  const [ipLoading, setIpLoading] = useState(false);
  const [guestToken, setGuestToken] = useState<string | null>(null);
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

  const handleOpenGuestMode = useCallback(async () => {
    setGuestModeVisible(true);
    setGuestToken(generateMockToken());
    setIpLoading(true);
    try {
      const ip = await Network.getIpAddressAsync();
      setDeviceIp(ip && ip !== '0.0.0.0' ? ip : null);
    } catch (error) {
      log(`No se pudo obtener la IP del dispositivo: ${String(error)}`, 'error');
      setDeviceIp(null);
    } finally {
      setIpLoading(false);
    }
  }, [log]);

  const handleCopyCommand = useCallback(
    async (command: string, label: string) => {
      await Clipboard.setStringAsync(command);
      log(`${label} copiado al portapapeles`);
    },
    [log],
  );

  const guestModeUrl =
    deviceIp && guestToken ? `http://${deviceIp}:${GUEST_MODE_PORT}${buildGuestModePath(guestToken)}` : null;
  const curlCommand = guestModeUrl ? `curl ${guestModeUrl}` : null;
  const powershellCommand = guestModeUrl ? `Invoke-WebRequest -Uri ${guestModeUrl} -OutFile clip.txt` : null;

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

        <Pressable onPress={handleOpenGuestMode} style={styles.guestModeLink}>
          <Text style={styles.guestModeLinkText}>🖥️ Modo Terminal / Sin Instalar</Text>
        </Pressable>

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

      <Modal
        visible={guestModeVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setGuestModeVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Modo Terminal — Sin Instalar</Text>
              <Pressable onPress={() => setGuestModeVisible(false)} hitSlop={8}>
                <Text style={styles.modalClose}>✕</Text>
              </Pressable>
            </View>

            <Text style={styles.modalBadge}>🚧 Vista previa — el servidor HTTP todavía no existe</Text>

            <Text style={styles.modalBody}>
              Para un PC público o sin permisos de instalación: ejecuta uno de estos comandos allí para
              traer el portapapeles de este móvil, sin instalar ningún cliente.
            </Text>

            <View style={styles.modalInfoRow}>
              <View style={styles.modalInfoCol}>
                <Text style={styles.modalLabel}>IP de este móvil</Text>
                {ipLoading ? (
                  <ActivityIndicator size="small" color={colors.cyan} />
                ) : (
                  <Text style={styles.modalIp}>{deviceIp ?? 'No disponible'}</Text>
                )}
              </View>
              <View style={styles.modalInfoCol}>
                <Text style={styles.modalLabel}>Token de sesión</Text>
                <Text style={styles.modalToken}>{guestToken ?? '····'}</Text>
              </View>
            </View>
            <Text style={styles.modalHint}>
              El token cambia cada vez que abres este modo — sin él, nadie más en esa red puede pedir tu
              portapapeles.
            </Text>

            <Text style={styles.modalLabel}>Linux / macOS</Text>
            <Pressable
              style={styles.commandBox}
              disabled={!curlCommand}
              onPress={() => curlCommand && handleCopyCommand(curlCommand, 'Comando curl')}
            >
              <Text style={styles.commandText}>
                {curlCommand ?? `curl http://<ip>:${GUEST_MODE_PORT}${buildGuestModePath('····')}`}
              </Text>
            </Pressable>

            <Text style={styles.modalLabel}>Windows (PowerShell)</Text>
            <Pressable
              style={styles.commandBox}
              disabled={!powershellCommand}
              onPress={() => powershellCommand && handleCopyCommand(powershellCommand, 'Comando PowerShell')}
            >
              <Text style={styles.commandText}>
                {powershellCommand ??
                  `Invoke-WebRequest -Uri http://<ip>:${GUEST_MODE_PORT}${buildGuestModePath('····')} -OutFile clip.txt`}
              </Text>
            </Pressable>

            <Text style={styles.modalHint}>Toca un comando para copiarlo.</Text>
          </View>
        </View>
      </Modal>
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

  guestModeLink: { alignSelf: 'flex-start' },
  guestModeLinkText: { color: colors.cyan, fontSize: 12, fontWeight: '600' },

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

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(4, 5, 16, 0.72)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 36,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  modalClose: { color: colors.textMuted, fontSize: 18, fontWeight: '700', paddingHorizontal: 4 },
  modalBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    overflow: 'hidden',
  },
  modalBody: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  modalInfoRow: { flexDirection: 'row', gap: 20 },
  modalInfoCol: { flex: 1 },
  modalLabel: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 4 },
  modalIp: { color: colors.cyan, fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  modalToken: { color: colors.indigo, fontSize: 18, fontWeight: '700', fontFamily: 'monospace', letterSpacing: 2 },
  commandBox: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
  },
  commandText: { color: colors.text, fontFamily: 'monospace', fontSize: 12 },
  modalHint: { color: colors.textMuted, fontSize: 11, fontStyle: 'italic', marginTop: 2 },
});
