import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingsIcon } from '@/components/SettingsIcon';
import { colors, radius, TOUCH, type } from '@/theme';

interface Props {
  /** Motivo por el que se perdió el emparejamiento, si lo hay. */
  lastError: string | null;
  onDismissError: () => void;
}

/** Pantalla inicial mientras no hay PC emparejado. */
export function Welcome({ lastError, onDismissError }: Props) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

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
        <Text style={styles.title} accessibilityRole="header">
          Empareja ClipSync con tu PC
        </Text>
      </LinearGradient>

      <View style={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.steps}>
          <Text style={styles.step}>1. Abre ClipSync en el PC y pulsa «Emparejar móvil».</Text>
          <Text style={styles.step}>2. Escanea el QR.</Text>
        </View>

        {lastError && (
          <Pressable
            style={styles.error}
            onPress={onDismissError}
            accessibilityRole="button"
            accessibilityLabel={`${lastError}. Toca para descartar`}
            hitSlop={4}
          >
            <View style={styles.mark}>
              <Text style={styles.markText}>!</Text>
            </View>
            <Text style={styles.errorText}>{lastError}</Text>
          </Pressable>
        )}

        <Pressable
          style={({ pressed }) => [styles.scan, pressed && styles.scanPressed]}
          onPress={() => router.push('/scan')}
          accessibilityRole="button"
        >
          <Text style={styles.scanText}>Escanear QR del PC</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: { paddingHorizontal: 16, paddingBottom: 20 },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { ...type.brand, color: colors.text },
  iconButton: { width: TOUCH, height: TOUCH, marginRight: -10, alignItems: 'center', justifyContent: 'center' },
  title: { ...type.title, color: colors.text, marginTop: 14 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 8, gap: 16 },
  steps: { gap: 8 },
  step: { ...type.body, color: colors.headerMuted },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.dangerBg,
  },
  errorText: { ...type.small, color: colors.text, flex: 1 },
  mark: { width: 18, height: 18, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.danger },
  markText: { color: colors.bg, fontSize: 12, fontWeight: '700', lineHeight: 15 },
  scan: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.indigoDeep,
  },
  scanPressed: { backgroundColor: colors.indigo },
  scanText: { ...type.body, color: '#fff', fontWeight: '700' },
});
