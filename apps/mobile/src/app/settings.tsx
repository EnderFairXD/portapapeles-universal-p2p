import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chooseReceiveDir } from '@/lib/files';
import { readableDir } from '@/lib/format';
import { loadSettings } from '@/lib/settings';
import { colors, radius, TOUCH, type } from '@/theme';

export default function Settings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [dirUri, setDirUri] = useState<string | null>(() => loadSettings().receiveDirUri);
  const [busy, setBusy] = useState(false);

  const change = async () => {
    setBusy(true);
    try {
      const uri = await chooseReceiveDir();
      if (uri) setDirUri(uri);
    } finally {
      setBusy(false);
    }
  };

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
          Ajustes
        </Text>
      </LinearGradient>

      <View style={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.card}>
          <Text style={styles.label}>Carpeta de recepción</Text>
          <Text style={[styles.value, !dirUri && styles.valueEmpty]} numberOfLines={2}>
            {readableDir(dirUri)}
          </Text>
          <Text style={styles.hint}>
            {dirUri
              ? 'Aquí se guardan los archivos que envía el PC.'
              : 'Se te pedirá una carpeta al recibir el primer archivo.'}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.change, pressed && styles.changePressed, busy && styles.changeBusy]}
            onPress={change}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Cambiar carpeta de recepción"
            accessibilityState={{ disabled: busy }}
          >
            <Text style={styles.changeText}>Cambiar</Text>
          </Pressable>
        </View>

        <View style={styles.version}>
          <Text style={styles.hint}>Versión</Text>
          <Text style={styles.hint}>{Constants.expoConfig?.version ?? '—'}</Text>
        </View>
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
  content: { paddingHorizontal: 16, paddingTop: 8 },
  card: {
    padding: 16,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: { ...type.section, color: colors.textMuted },
  value: { ...type.body, color: colors.text, fontWeight: '600', marginTop: 6 },
  valueEmpty: { color: colors.textMuted, fontWeight: '400' },
  hint: { ...type.small, color: colors.textMuted, marginTop: 4 },
  change: {
    minHeight: TOUCH,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 18,
    marginTop: 14,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  changePressed: { backgroundColor: colors.surfaceAlt },
  changeBusy: { opacity: 0.45 },
  changeText: { ...type.body, color: colors.text, fontWeight: '600' },
  version: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: 20 },
});
