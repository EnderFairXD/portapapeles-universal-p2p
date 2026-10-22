import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ConnState } from '@/lib/connection';
import { BLUETOOTH_ISSUE_MESSAGES, modeChangePending } from '@/lib/transportPolicy';
import { colors, radius, TOUCH, type } from '@/theme';

/** Aviso cuando enviar capturas está activado pero falta el permiso de fotos. */
export const PHOTO_ACCESS_NOTICE = 'Permite el acceso a las fotos para enviar tus capturas';

/** Aviso cuando se cambió el medio de conexión con una transferencia en curso. */
export const MODE_CHANGE_NOTICE = 'Se cambiará al terminar la transferencia';

const WIRE_WIDTH = 48;
const DASH_PERIOD = 12;

/** Texto de estado según la conexión. */
export function statusTitle(s: Pick<ConnState, 'status' | 'peerName' | 'transport' | 'pc'>): string {
  if (s.status === 'connected') {
    const via = s.transport === 'wifi' ? ' por WiFi' : s.transport === 'usb' ? ' por USB' : s.transport === 'bluetooth' ? ' por Bluetooth' : '';
    return `Conectado con ${s.peerName || 'el PC'}${via}`;
  }
  if (s.pc?.pairing) return `Emparejando con ${s.pc.name}…`;
  return s.status === 'connecting' ? 'Conectando…' : 'Buscando tu PC…';
}

/**
 * El enlace móvil - PC (el móvil a la izquierda, el PC se enciende al conectar): discontinuo y en movimiento mientras busca,
 * una línea cian continua al conectar.
 */
function Wire({ connected, searching }: { connected: boolean; searching: boolean }) {
  const drift = useState(() => new Animated.Value(0))[0];
  const fill = useState(() => new Animated.Value(connected ? 1 : 0))[0];
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduceMotion(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    Animated.timing(fill, {
      toValue: connected ? 1 : 0,
      duration: reduceMotion ? 0 : 550,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [connected, reduceMotion, fill]);

  useEffect(() => {
    if (connected || reduceMotion) return;
    drift.setValue(0);
    const loop = Animated.loop(
      Animated.timing(drift, { toValue: DASH_PERIOD, duration: 1200, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [connected, reduceMotion, drift]);

  const solidWidth = fill.interpolate({ inputRange: [0, 1], outputRange: [0, WIRE_WIDTH] });

  return (
    <View style={styles.link} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.node, styles.nodeSelf]} />
      <View style={styles.wire}>
        {!connected && (
          <Animated.View style={[styles.dashes, { transform: [{ translateX: drift }] }]}>
            {Array.from({ length: 6 }, (_, i) => (
              <View key={i} style={[styles.dash, searching && styles.dashSearching]} />
            ))}
          </Animated.View>
        )}
        <Animated.View style={[styles.solid, { width: solidWidth }]} />
      </View>
      <View style={[styles.node, styles.nodePeer, connected && styles.nodePeerOn]} />
    </View>
  );
}

interface Props {
  state: ConnState;
  /** Aviso informativo (p. ej. archivos esperando conexión). */
  notice?: string | null;
  /** Si se da, el aviso informativo lleva un botón «Cancelar». */
  onCancelNotice?: () => void;
  onDismissError: () => void;
  /** Con el aviso de permiso de fotos: abre los ajustes de Android de la app. */
  onOpenPhotoSettings?: () => void;
  /** Con el aviso de permiso de Bluetooth: abre los ajustes de Android de la app. */
  onOpenBluetoothSettings?: () => void;
}

export function StatusCard({ state, notice, onCancelNotice, onDismissError, onOpenPhotoSettings, onOpenBluetoothSettings }: Props) {
  const connected = state.status === 'connected';
  // el aviso del permiso de Bluetooth lleva su propio botón «Abrir ajustes»
  const permissionNotice = state.lastError === BLUETOOTH_ISSUE_MESSAGES.no_permission;
  const errorText = permissionNotice ? null : state.lastError;
  const modePending = modeChangePending(state.transportMode, state.transport);
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title} accessibilityRole="header" accessibilityLiveRegion="polite">
            {statusTitle(state)}
          </Text>
          {!connected && (
            <Text style={styles.hint}>Abre ClipSync en el PC, con el móvil en la misma red WiFi, por cable USB o por Bluetooth</Text>
          )}
        </View>
        <Wire connected={connected} searching={state.status === 'searching'} />
      </View>

      {(state.lastError || notice || state.photoAccessMissing || modePending) && (
        <View style={styles.notices}>
          {errorText && (
            <Pressable
              style={[styles.notice, styles.noticeError]}
              onPress={onDismissError}
              accessibilityRole="button"
              accessibilityLabel={`${errorText}. Toca para descartar`}
              hitSlop={4}
            >
              <View style={[styles.mark, { backgroundColor: colors.danger }]}>
                <Text style={styles.markText}>!</Text>
              </View>
              <Text style={styles.noticeText}>{errorText}</Text>
            </Pressable>
          )}
          {state.photoAccessMissing && (
            <View style={[styles.notice, styles.noticeInfo]} accessibilityLiveRegion="polite">
              <View style={[styles.mark, { backgroundColor: colors.outFg }]}>
                <Text style={styles.markText}>i</Text>
              </View>
              <Text style={styles.noticeText}>{PHOTO_ACCESS_NOTICE}</Text>
              {onOpenPhotoSettings && (
                <Pressable
                  style={styles.noticeAction}
                  onPress={onOpenPhotoSettings}
                  accessibilityRole="button"
                  accessibilityLabel="Abrir ajustes de Android para permitir el acceso a las fotos"
                  hitSlop={6}
                >
                  <Text style={styles.noticeActionText}>Abrir ajustes</Text>
                </Pressable>
              )}
            </View>
          )}
          {permissionNotice && (
            <View style={[styles.notice, styles.noticeInfo]} accessibilityLiveRegion="polite">
              <View style={[styles.mark, { backgroundColor: colors.outFg }]}>
                <Text style={styles.markText}>i</Text>
              </View>
              <Text style={styles.noticeText}>{BLUETOOTH_ISSUE_MESSAGES.no_permission}</Text>
              {onOpenBluetoothSettings && (
                <Pressable
                  style={styles.noticeAction}
                  onPress={onOpenBluetoothSettings}
                  accessibilityRole="button"
                  accessibilityLabel="Abrir ajustes de Android para permitir el acceso a Bluetooth"
                  hitSlop={6}
                >
                  <Text style={styles.noticeActionText}>Abrir ajustes</Text>
                </Pressable>
              )}
            </View>
          )}
          {modePending && (
            <View style={[styles.notice, styles.noticeInfo]} accessibilityLiveRegion="polite">
              <View style={[styles.mark, { backgroundColor: colors.outFg }]}>
                <Text style={styles.markText}>i</Text>
              </View>
              <Text style={styles.noticeText}>{MODE_CHANGE_NOTICE}</Text>
            </View>
          )}
          {notice && (
            <View style={[styles.notice, styles.noticeInfo]} accessibilityLiveRegion="polite">
              <View style={[styles.mark, { backgroundColor: colors.outFg }]}>
                <Text style={styles.markText}>i</Text>
              </View>
              <Text style={styles.noticeText}>{notice}</Text>
              {onCancelNotice && (
                <Pressable
                  style={styles.noticeAction}
                  onPress={onCancelNotice}
                  accessibilityRole="button"
                  accessibilityLabel="Cancelar el envío de lo compartido"
                  hitSlop={6}
                >
                  <Text style={styles.noticeActionText}>Cancelar</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  text: { flex: 1 },
  title: { ...type.title, color: colors.text },
  hint: { ...type.small, color: colors.headerMuted, marginTop: 4 },

  link: { flexDirection: 'row', alignItems: 'center', width: 88 },
  node: { width: 14, height: 14, borderRadius: radius.pill },
  nodeSelf: { backgroundColor: colors.indigo },
  nodePeer: { borderWidth: 2, borderColor: colors.linkOff },
  nodePeerOn: { backgroundColor: colors.cyan, borderColor: colors.cyan },
  wire: { width: WIRE_WIDTH, height: 2, marginHorizontal: 6, overflow: 'hidden' },
  dashes: { position: 'absolute', left: -DASH_PERIOD, top: 0, flexDirection: 'row' },
  dash: { width: 6, height: 2, marginRight: 6, backgroundColor: colors.linkOff },
  dashSearching: { backgroundColor: colors.headerMuted },
  solid: { position: 'absolute', left: 0, top: 0, height: 2, backgroundColor: colors.cyan },

  notices: { gap: 8, marginTop: 14 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: radius.md, minHeight: TOUCH - 8 },
  noticeError: { backgroundColor: colors.dangerBg },
  noticeInfo: { backgroundColor: colors.infoBg },
  noticeText: { ...type.small, color: colors.text, flex: 1 },
  noticeAction: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 6, marginVertical: -6 },
  noticeActionText: { ...type.small, color: colors.outFg, fontWeight: '700' },
  mark: { width: 18, height: 18, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  markText: { color: colors.bg, fontSize: 12, fontWeight: '700', lineHeight: 15 },
});
