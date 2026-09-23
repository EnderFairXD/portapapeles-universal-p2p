import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { LinearGradient } from 'expo-linear-gradient';
import * as Network from 'expo-network';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DEFAULT_TCP_PORT, GUEST_MODE_PORT } from '@clipsync/protocol';

import { startBleDiscovery, type BleDiscoveredPeer } from '@/lib/bleTransport';
import { startGuestServer, type GuestPayload, type GuestServerHandle } from '@/lib/guestServer';
import { DiscoveredPeer, LogFn, PickedFile, sendFileMessage, sendTextMessage, startLanDiscovery } from '@/lib/lanTransport';

type TransportId = 'lan' | 'usb' | 'bluetooth';

const TRANSPORTS: { id: TransportId; label: string }[] = [
  { id: 'lan', label: 'LAN' },
  { id: 'usb', label: 'USB' },
  { id: 'bluetooth', label: 'Bluetooth' },
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

interface CopyRowProps {
  icon: string;
  label: string;
  command: string | null;
  onCopy: (command: string, label: string) => void;
}

/** Fila de comando copiable — el Modo Invitado ya no distingue por SO (curl funciona igual en Windows 10+, Linux y Mac). */
function CopyRow({ icon, label, command, onCopy }: CopyRowProps) {
  return (
    <View style={styles.osCommandEntry}>
      <Text style={styles.osCommandLabel}>
        {icon} {label}
      </Text>
      <Pressable style={styles.commandBox} disabled={!command} onPress={() => command && onCopy(command, label)}>
        <Text style={styles.commandText} selectable>
          {command ?? '…'}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Pantalla de depuración/demo de la Fase 2: sin pulido final, pero ya con los flujos
 * reales (selección de dispositivo, payload texto/archivo, selector de transporte)
 * en vez de un botón único que auto-envía al primer peer encontrado.
 */
export default function DiscoveryScreen() {
  const [logs, setLogs] = useState<string[]>([]);
  const [peers, setPeers] = useState<DiscoveredPeer[]>([]);
  const [blePeers, setBlePeers] = useState<BleDiscoveredPeer[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<DiscoveredPeer | null>(null);
  const [scanning, setScanning] = useState(false);
  const [transport, setTransport] = useState<TransportId>('lan');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  // useState (no useRef): el lint del proyecto (react-hooks/refs) prohíbe leer `.current`
  // de un ref durante el render, y `progressAnim` se usa en el JSX de abajo.
  const [progressAnim] = useState(() => new Animated.Value(0));

  // Modo Invitado: selección propia, independiente de `message`/`file` (que son para
  // envío P2P) — el usuario puede querer compartir algo distinto por este modo.
  const [guestModeVisible, setGuestModeVisible] = useState(false);
  const [guestMessage, setGuestMessage] = useState('');
  const [guestFile, setGuestFile] = useState<PickedFile | null>(null);
  const [guestServerRunning, setGuestServerRunning] = useState(false);
  const [deviceIp, setDeviceIp] = useState<string | null>(null);
  const [ipLoading, setIpLoading] = useState(false);

  const stopDiscoveryRef = useRef<(() => void) | null>(null);
  const guestServerRef = useRef<GuestServerHandle | null>(null);

  const log = useCallback<LogFn>((msg, level = 'info') => {
    console.log(`[LAN] ${msg}`);
    const line = `[${new Date().toLocaleTimeString()}] ${level === 'error' ? '⚠️ ' : ''}${msg}`;
    setLogs((prev) => [line, ...prev].slice(0, 100));
  }, []);

  useEffect(
    () => () => {
      stopDiscoveryRef.current?.();
      guestServerRef.current?.stop();
    },
    [],
  );

  useEffect(() => {
    const target = sendProgress && sendProgress.total > 0 ? sendProgress.sent / sendProgress.total : 0;
    Animated.timing(progressAnim, {
      toValue: target,
      duration: 220,
      useNativeDriver: false, // animamos "width" en %, no soportado por el native driver
    }).start();
  }, [sendProgress, progressAnim]);

  const handleScan = useCallback(() => {
    if (scanning) return;
    setPeers([]);
    setBlePeers([]);
    setSelectedPeer(null);

    if (transport === 'lan') {
      setScanning(true);
      stopDiscoveryRef.current = startLanDiscovery((found) => {
        setPeers((prev) =>
          prev.some((p) => p.host === found.host && p.port === found.port) ? prev : [...prev, found],
        );
      }, log);
      return;
    }

    if (transport === 'usb') {
      // adb reverse hace que el 127.0.0.1 del propio móvil llegue al servidor del PC — no
      // hay nada que escanear, el "peer" es siempre este mismo.
      const usbPeer: DiscoveredPeer = { name: 'PC vía USB (adb reverse)', host: '127.0.0.1', port: DEFAULT_TCP_PORT };
      setPeers([usbPeer]);
      log(`Modo USB: usando el túnel en 127.0.0.1:${DEFAULT_TCP_PORT} (el escritorio lo levanta solo al detectar el cable)`);
      return;
    }

    // Bluetooth
    setScanning(true);
    stopDiscoveryRef.current = startBleDiscovery((found) => {
      setBlePeers((prev) => (prev.some((p) => p.id === found.id) ? prev : [...prev, found]));
    }, log);
  }, [log, scanning, transport]);

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

  const pickFile = useCallback(async (): Promise<PickedFile | null> => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return null;
    const asset = result.assets[0];
    return {
      uri: asset.uri,
      name: asset.name,
      size: asset.size ?? 0,
      mimeType: asset.mimeType ?? 'application/octet-stream',
    };
  }, []);

  const handlePickFile = useCallback(async () => {
    const picked = await pickFile();
    if (!picked) return;
    setFile(picked);
    log(`Archivo adjuntado: ${picked.name} (${formatBytes(picked.size)})`);
  }, [pickFile, log]);

  const canSend = !!selectedPeer && !sending && (message.trim().length > 0 || !!file);

  const handleSend = useCallback(async () => {
    if (!selectedPeer) return;
    setSending(true);
    setSendProgress(null);
    try {
      if (file) {
        await sendFileMessage(selectedPeer, file, log, (sent, total) => setSendProgress({ sent, total }));
        setFile(null);
      } else {
        await sendTextMessage(selectedPeer, message.trim(), log);
        setMessage('');
      }
    } catch {
      // el detalle del error ya quedó registrado por sendTextMessage/sendFileMessage vía log()
    } finally {
      setSending(false);
      setSendProgress(null);
    }
  }, [selectedPeer, file, message, log]);

  const handleTransportPress = useCallback(
    (id: TransportId) => {
      if (id === transport) return;
      stopDiscoveryRef.current?.();
      stopDiscoveryRef.current = null;
      setScanning(false);
      setPeers([]);
      setBlePeers([]);
      setSelectedPeer(null);
      setTransport(id);
      log(`Transporte activo: ${TRANSPORTS.find((t) => t.id === id)?.label}`);
    },
    [log, transport],
  );

  const handleOpenGuestMode = useCallback(async () => {
    setGuestModeVisible(true);
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

  const handleCloseGuestMode = useCallback(() => {
    setGuestModeVisible(false);
    guestServerRef.current?.stop();
    guestServerRef.current = null;
    setGuestServerRunning(false);
  }, []);

  const handlePickGuestFile = useCallback(async () => {
    const picked = await pickFile();
    if (!picked) return;
    setGuestFile(picked);
    log(`Archivo para compartir: ${picked.name} (${formatBytes(picked.size)})`);
  }, [pickFile, log]);

  const canActivateGuestServer = guestMessage.trim().length > 0 || !!guestFile;

  const handleActivateGuestServer = useCallback(() => {
    if (!canActivateGuestServer) return;
    const payload: GuestPayload = guestFile
      ? { kind: 'file', uri: guestFile.uri, name: guestFile.name, mimeType: guestFile.mimeType, size: guestFile.size }
      : { kind: 'text', content: guestMessage.trim() };

    guestServerRef.current?.stop();
    guestServerRef.current = startGuestServer({ port: GUEST_MODE_PORT, payload, log });
    setGuestServerRunning(true);
  }, [canActivateGuestServer, guestFile, guestMessage, log]);

  const handleStopGuestServer = useCallback(() => {
    guestServerRef.current?.stop();
    guestServerRef.current = null;
    setGuestServerRunning(false);
  }, []);

  const handleCopyCommand = useCallback(
    async (command: string, label: string) => {
      await Clipboard.setStringAsync(command);
      log(`${label} copiado al portapapeles`);
    },
    [log],
  );

  const guestModeUrl = deviceIp ? `http://${deviceIp}:${GUEST_MODE_PORT}` : null;
  const curlOutputName = guestFile ? guestFile.name : 'compartido.txt';
  const curlCommand = guestModeUrl ? `curl ${guestModeUrl} -o "${curlOutputName}"` : null;

  return (
    <View style={styles.container}>
      <LinearGradient colors={[colors.indigoDeep, colors.bg]} style={styles.header}>
        <Text style={styles.title}>ClipSync</Text>
        <Text style={styles.subtitle}>
          Portapapeles universal P2P — {TRANSPORTS.find((t) => t.id === transport)?.label}
        </Text>
      </LinearGradient>

      <View style={styles.body}>
        <View style={styles.pillRow}>
          {TRANSPORTS.map((t) => {
            const active = t.id === transport;
            return (
              <Pressable
                key={t.id}
                onPress={() => handleTransportPress(t.id)}
                style={[styles.pill, active && styles.pillActive]}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable onPress={handleOpenGuestMode} style={styles.guestModeLink}>
          <Text style={styles.guestModeLinkText}>🖥️ Modo Terminal / Sin Instalar</Text>
        </Pressable>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            {transport === 'lan' && 'Dispositivos en la LAN'}
            {transport === 'usb' && 'Conexión USB'}
            {transport === 'bluetooth' && 'Dispositivos Bluetooth cercanos'}
          </Text>
          <Pressable onPress={scanning ? handleStopScan : handleScan} style={styles.scanButton}>
            {scanning && <ActivityIndicator size="small" color={colors.cyan} style={styles.scanSpinner} />}
            <Text style={styles.scanButtonText}>{scanning ? 'Detener' : 'Buscar'}</Text>
          </Pressable>
        </View>

        {transport === 'bluetooth' ? (
          blePeers.length === 0 ? (
            <Text style={styles.emptyText}>
              {scanning ? 'Buscando dispositivos BLE…' : 'Sin dispositivos detectados todavía. Pulsa "Buscar".'}
            </Text>
          ) : (
            <FlatList
              data={blePeers}
              keyExtractor={(p) => p.id}
              style={styles.peerList}
              renderItem={({ item }) => (
                <View style={styles.peerRow}>
                  <View>
                    <Text style={styles.peerName}>{item.name ?? 'Dispositivo sin nombre'}</Text>
                    <Text style={styles.peerAddress}>{item.id}</Text>
                  </View>
                </View>
              )}
            />
          )
        ) : peers.length === 0 ? (
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

        {transport === 'bluetooth' ? (
          <Text style={styles.emptyText}>
            El envío por Bluetooth todavía no está implementado — esta pestaña hoy solo detecta dispositivos
            cercanos que anuncien el servicio (Fase 4 en progreso, ver docs/architecture.md §5).
          </Text>
        ) : (
          <>
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

            <Pressable
              onPress={handleSend}
              disabled={!canSend}
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
            >
              <Text style={[styles.sendButtonText, !canSend && styles.sendButtonTextDisabled]}>
                {selectedPeer ? `Enviar a ${selectedPeer.name}` : 'Selecciona un PC primero'}
              </Text>
            </Pressable>
          </>
        )}

        <FlatList
          style={styles.logList}
          data={logs}
          keyExtractor={(_, index) => String(index)}
          renderItem={({ item }) => <Text style={styles.logLine}>{item}</Text>}
        />
      </View>

      <Modal visible={guestModeVisible} animationType="slide" transparent onRequestClose={handleCloseGuestMode}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Modo Terminal — Sin Instalar</Text>
              <Pressable onPress={handleCloseGuestMode} hitSlop={8}>
                <Text style={styles.modalClose}>✕</Text>
              </Pressable>
            </View>

            {!guestServerRunning ? (
              <>
                <Text style={styles.modalBody}>
                  Para un PC público o sin permisos de instalación: elige qué compartir y activa el servidor.
                  Mientras esté activo, cualquiera que sepa tu IP en esa red puede descargarlo — sin instalar
                  nada, sin token que teclear.
                </Text>

                <Text style={styles.modalLabel}>¿Qué quieres compartir?</Text>
                <TextInput
                  style={[styles.input, !!guestFile && styles.inputDisabled]}
                  placeholder="Escribe un texto…"
                  placeholderTextColor={colors.textMuted}
                  value={guestMessage}
                  onChangeText={(text) => {
                    setGuestMessage(text);
                    if (text.length > 0) setGuestFile(null);
                  }}
                  multiline
                  editable={!guestFile}
                />

                <View style={styles.attachRow}>
                  <Pressable
                    onPress={handlePickGuestFile}
                    disabled={guestMessage.trim().length > 0}
                    style={[styles.attachButton, guestMessage.trim().length > 0 && styles.attachButtonDisabled]}
                  >
                    <Text style={styles.attachButtonText}>📎 Adjuntar archivo</Text>
                  </Pressable>
                  {guestFile && (
                    <View style={styles.attachedFile}>
                      <Text style={styles.attachedFileName} numberOfLines={1}>
                        {guestFile.name}
                      </Text>
                      <Text style={styles.attachedFileSize}>{formatBytes(guestFile.size)}</Text>
                      <Pressable onPress={() => setGuestFile(null)} hitSlop={8}>
                        <Text style={styles.attachedFileRemove}>✕</Text>
                      </Pressable>
                    </View>
                  )}
                </View>

                <Pressable
                  onPress={handleActivateGuestServer}
                  disabled={!canActivateGuestServer}
                  style={[styles.sendButton, !canActivateGuestServer && styles.sendButtonDisabled]}
                >
                  <Text style={[styles.sendButtonText, !canActivateGuestServer && styles.sendButtonTextDisabled]}>
                    ▶ Activar servidor
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.modalBadge}>🟢 Servidor activo en el puerto {GUEST_MODE_PORT}</Text>
                <Text style={styles.modalBody}>
                  Compartiendo: {guestFile ? `📎 ${guestFile.name} (${formatBytes(guestFile.size)})` : `texto (${guestMessage.trim().length} caracteres)`}
                </Text>

                <Text style={styles.modalLabel}>IP de este móvil</Text>
                {ipLoading ? (
                  <ActivityIndicator size="small" color={colors.cyan} />
                ) : (
                  <Text style={styles.modalIp}>{deviceIp ?? 'No disponible'}</Text>
                )}

                <CopyRow icon="🌐" label="Navegador Web" command={guestModeUrl} onCopy={handleCopyCommand} />
                <CopyRow icon="💻" label="Terminal (curl)" command={curlCommand} onCopy={handleCopyCommand} />

                <Pressable onPress={handleStopGuestServer} style={styles.attachButton}>
                  <Text style={styles.attachButtonText}>■ Detener servidor</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {sending && (
        <View style={styles.loadingOverlay} pointerEvents="auto">
          <BlurView intensity={45} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={styles.loadingCard}>
            <LinearGradient colors={[colors.indigo, colors.cyan]} style={styles.loadingRing}>
              <View style={styles.loadingRingInner}>
                <ActivityIndicator size="small" color={colors.cyan} />
              </View>
            </LinearGradient>

            <Text style={styles.loadingTitle}>{file ? `Enviando "${file.name}"` : 'Enviando mensaje…'}</Text>

            {sendProgress ? (
              <>
                <View style={styles.progressTrack}>
                  <Animated.View
                    style={[
                      styles.progressFillWrap,
                      {
                        width: progressAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: ['0%', '100%'],
                        }),
                      },
                    ]}
                  >
                    <LinearGradient
                      colors={[colors.indigo, colors.cyan]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={StyleSheet.absoluteFill}
                    />
                  </Animated.View>
                </View>
                <Text style={styles.loadingSubtitle}>
                  Fragmento {sendProgress.sent} de {sendProgress.total} ·{' '}
                  {Math.round((sendProgress.sent / sendProgress.total) * 100)}%
                </Text>
              </>
            ) : (
              <Text style={styles.loadingSubtitle}>Esperando respuesta del PC…</Text>
            )}
          </View>
        </View>
      )}
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
  pillText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  pillTextActive: { color: colors.text },

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
    alignItems: 'center',
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
  modalLabel: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 4 },
  modalIp: { color: colors.cyan, fontSize: 18, fontWeight: '700', fontFamily: 'monospace' },
  commandBox: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
  },
  commandText: { color: colors.text, fontFamily: 'monospace', fontSize: 12 },
  osCommandEntry: { gap: 4 },
  osCommandLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },

  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingCard: {
    width: '78%',
    backgroundColor: 'rgba(23, 25, 53, 0.9)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 14,
  },
  loadingRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 3,
  },
  loadingRingInner: {
    flex: 1,
    width: '100%',
    borderRadius: 24,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingTitle: { color: colors.text, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  loadingSubtitle: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  progressFillWrap: { height: '100%', borderRadius: 999, overflow: 'hidden' },
});
