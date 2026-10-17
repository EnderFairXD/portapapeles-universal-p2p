import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { connection } from '@/lib/connection';
import { decideScan } from '@/lib/scanDecision';
import { colors, radius, TOUCH, type } from '@/theme';

const INVALID_QR = 'Este QR no es de ClipSync';
// tras un QR ajeno se espera antes de volver a leer, para no repetir el aviso en bucle
const RETRY_MS = 2000;

export default function Scan() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [invalid, setInvalid] = useState(false);
  // true mientras se procesa una lectura (aviso, confirmación o emparejado)
  const busy = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  const finish = useCallback(
    (info: Parameters<typeof connection.pair>[0]) => {
      connection.pair(info);
      router.back();
    },
    [router],
  );

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (busy.current) return;
      busy.current = true;

      const decision = decideScan(data, connection.getState().pc?.name ?? null);
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
            { text: 'Cancelar', style: 'cancel', onPress: () => (busy.current = false) },
            { text: 'Sustituir', onPress: () => finish(decision.info) },
          ],
          { cancelable: true, onDismiss: () => (busy.current = false) },
        );
      } else {
        finish(decision.info);
      }
    },
    [finish],
  );

  return (
    <View style={styles.screen}>
      <LinearGradient colors={[colors.headerTop, colors.bg]} style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <Pressable
          style={styles.back}
          onPress={() => router.back()}
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
