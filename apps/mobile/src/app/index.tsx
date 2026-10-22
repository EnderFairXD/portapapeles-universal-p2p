import { useShareIntentContext } from 'expo-share-intent';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HistoryList } from '@/components/HistoryList';
import { SettingsIcon } from '@/components/SettingsIcon';
import { StatusCard } from '@/components/StatusCard';
import { Toast } from '@/components/Toast';
import { TransferList } from '@/components/TransferList';
import { Welcome } from '@/components/Welcome';
import { connection, type HistoryEntry } from '@/lib/connection';
import { filesLabel } from '@/lib/format';
import { pickAndSend, pickImageAndSend } from '@/lib/sendFlow';
import { useConnection } from '@/lib/useConnection';
import { colors, radius, TOUCH, type } from '@/theme';

export default function Home() {
  const state = useConnection();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  const [picking, setPicking] = useState(false);
  const [toast, setToast] = useState({ text: 'Copiado', visible: false });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const connected = state.status === 'connected';
  const waiting = hasShareIntent && !connected ? (shareIntent.files?.length ?? 0) : 0;

  const runPicker = useCallback(async (pick: () => Promise<void>) => {
    setPicking(true);
    try {
      await pick();
    } finally {
      setPicking(false);
    }
  }, []);
  const onPick = useCallback(() => runPicker(pickAndSend), [runPicker]);
  const onPickImage = useCallback(() => runPicker(pickImageAndSend), [runPicker]);

  const onCopy = useCallback(async (entry: HistoryEntry) => {
    try {
      await connection.copyFromHistory(entry);
      setToast({ text: 'Copiado', visible: true });
    } catch {
      setToast({ text: 'No se pudo copiar', visible: true });
    }
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 1600);
  }, []);

  // son métodos de la clase: hay que llamarlos con `connection.`
  const onDismissError = useCallback(() => connection.clearError(), []);
  const onCancel = useCallback((id: string) => connection.cancelTransfer(id), []);
  const onOpenPhotoSettings = useCallback(() => {
    Linking.openSettings().catch(() => {});
  }, []);
  // el permiso de Bluetooth también se cambia en los ajustes de Android de la app
  const onOpenBluetoothSettings = onOpenPhotoSettings;

  const disabled = !connected || picking;

  // sin PC emparejado no hay nada que mostrar salvo cómo emparejar
  if (state.status === 'unpaired') {
    return <Welcome lastError={state.lastError} onDismissError={onDismissError} />;
  }

  return (
    <View style={styles.screen}>
      <LinearGradient colors={[colors.headerTop, colors.bg]} style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>ClipSync</Text>
          <Pressable
            style={styles.iconButton}
            onPress={() => router.push('/settings')}
            accessibilityRole="button"
            accessibilityLabel="Ajustes"
          >
            <SettingsIcon color={colors.headerMuted} />
          </Pressable>
        </View>
        <View style={styles.status}>
          <StatusCard
            state={state}
            notice={waiting > 0 ? `Esperando conexión para enviar ${filesLabel(waiting)}` : null}
            onCancelNotice={waiting > 0 ? () => resetShareIntent() : undefined}
            onDismissError={onDismissError}
            onOpenPhotoSettings={onOpenPhotoSettings}
            onOpenBluetoothSettings={onOpenBluetoothSettings}
          />
        </View>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          style={({ pressed }) => [styles.send, pressed && styles.sendPressed, disabled && styles.sendDisabled]}
          onPress={onPick}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
        >
          <Text style={styles.sendText}>{connected ? 'Enviar archivo' : 'Abre ClipSync en el PC'}</Text>
        </Pressable>

        {connected && (
          <Pressable
            style={({ pressed }) => [styles.send, styles.sendSecondary, pressed && styles.sendPressed, picking && styles.sendDisabled]}
            onPress={onPickImage}
            disabled={picking}
            accessibilityRole="button"
            accessibilityLabel="Enviar imagen de la galería al portapapeles del PC"
            accessibilityState={{ disabled: picking }}
          >
            <Text style={styles.sendText}>Enviar imagen</Text>
          </Pressable>
        )}

        <TransferList transfers={state.transfers} onCancel={onCancel} />
        <HistoryList history={state.history} onCopy={onCopy} />
      </ScrollView>

      <Toast message={toast.text} visible={toast.visible} bottom={insets.bottom + 24} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: { paddingHorizontal: 16, paddingBottom: 20 },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { ...type.brand, color: colors.text },
  iconButton: { width: TOUCH, height: TOUCH, marginRight: -10, alignItems: 'center', justifyContent: 'center' },
  status: { marginTop: 10 },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  send: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.indigoDeep,
  },
  sendSecondary: { marginTop: 12, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  sendPressed: { backgroundColor: colors.indigo },
  sendDisabled: { opacity: 0.45 },
  sendText: { ...type.body, color: '#fff', fontWeight: '700' },
});
