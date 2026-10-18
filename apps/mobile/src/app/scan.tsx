import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { connection } from '@/lib/connection';
import { loadSettings } from '@/lib/settings';
import { decideScan } from '@/lib/scanDecision';
import { colors, radius, TOUCH, type } from '@/theme';

const INVALID_QR = 'Este QR no es de ClipSync';
// tras un QR ajeno se espera antes de volver a leer, para no repetir el aviso en bucle
const RETRY_MS = 2000;

export default function Scan() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission, refreshPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);
  // true mientras se procesa una lectura (aviso, confirmación o emparejado)
  const busy = useRef(false);
  // todas las salidas de la pantalla (emparejar, Cancelar, cerrar el aviso) pasan por `leave`
  const left = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  // al volver de los ajustes del sistema, comprobar de nuevo si se dio el permiso
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshPermission().catch(() => {});
    });
    return () => sub.remove();
  }, [refreshPermission]);

  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    // sin pantalla detrás (el escáner es la primera) «Volver» lleva a la principal
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const finish = useCallback(
    (info: Parameters<typeof connection.pair>[0]) => {
      connection.pair(info);
      leave();
    },
    [leave],
  );

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (busy.current) return;
      busy.current = true;

      const decision = decideScan(data, loadSettings().pc);
      if (decision.kind === 'invalid') {
        setInvalid(true);
        retryTimer.current = setTimeout(() => {
          setInvalid(false);
          busy.current = false;
        }, RETRY_MS);
      } else if (decision.kind === 'confirm') {
        Alert.alert(
          `Ya estás emparejado con «${decision.current}». ¿Sustituirlo por «${decision.info.name}»?`,
          undefined,
          [
            // el usuario decide no sustituir: se sale (la cámara seguiría viendo el mismo QR)
            { text: 'Cancelar', style: 'cancel', onPress: leave },
            { text: 'Sustituir', onPress: () => finish(decision.info) },
          ],
          { cancelable: true, onDismiss: leave },
        );
      } else {
        finish(decision.info);
      }
    },
    [finish, leave],
  );

  return (
    <View style={styles.screen}>
      <LinearGradient colors={[colors.headerTop, colors.bg]} style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Pressable
          style={styles.back}
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Volver"
          hitSlop={8}
        >
          <Text style={styles.backText}>‹ Volver</Text>
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Escanear QR del PC
        </Text>
      </LinearGradient>

      <View style={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        {!permission ? null : permission.granted ? (
          <View style={styles.cameraBox}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onScanned}
            />
            {invalid && (
              <View style={styles.invalid} accessibilityLiveRegion="polite">
                <Text style={styles.invalidText}>{INVALID_QR}</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.denied}>
            <Text style={styles.deniedText}>ClipSync necesita la cámara para leer el QR</Text>
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>{permission.canAskAgain ? 'Permitir cámara' : 'Abrir ajustes'}</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: { paddingHorizontal: 16, paddingBottom: 20 },
  back: { minHeight: TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  backText: { ...type.body, color: colors.headerMuted, fontWeight: '600' },
  title: { ...type.title, color: colors.text, marginTop: 4 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  cameraBox: { flex: 1, overflow: 'hidden', borderRadius: radius.lg, backgroundColor: colors.surface },
  invalid: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.dangerBg,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  invalidText: { ...type.body, color: colors.text, textAlign: 'center', fontWeight: '600' },
  denied: { gap: 16, alignItems: 'flex-start' },
  deniedText: { ...type.body, color: colors.text },
  button: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 22,
    borderRadius: radius.md,
    backgroundColor: colors.indigoDeep,
  },
  buttonPressed: { backgroundColor: colors.indigo },
  buttonText: { ...type.body, color: '#fff', fontWeight: '700' },
});
