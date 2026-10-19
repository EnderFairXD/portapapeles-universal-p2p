import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PHOTO_ACCESS_NOTICE } from '@/components/StatusCard';
import { connection } from '@/lib/connection';
import { chooseReceiveDir } from '@/lib/files';
import { readableDir } from '@/lib/format';
import { loadSettings, updateSettings } from '@/lib/settings';
import { useConnection } from '@/lib/useConnection';
import { colors, radius, TOUCH, type } from '@/theme';

/** Una fila con interruptor; toda la fila se puede tocar. */
function ToggleRow({ title, hint, value, onChange }: { title: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      style={styles.toggle}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ checked: value }}
    >
      <View style={styles.toggleText}>
        <Text style={styles.value}>{title}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.linkOff, true: colors.indigoDeep }}
        thumbColor={value ? colors.outFg : colors.headerMuted}
        accessible={false}
        importantForAccessibility="no"
      />
    </Pressable>
  );
}

export default function Settings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [dirUri, setDirUri] = useState<string | null>(() => loadSettings().receiveDirUri);
  const [busy, setBusy] = useState(false);
  const conn = useConnection();
  const pcName = conn.pc?.name ?? null;
  const [sendShots, setSendShots] = useState(() => loadSettings().sendScreenshots);
  const [saveGallery, setSaveGallery] = useState(() => loadSettings().saveToGallery);

  const toggleShots = (value: boolean) => {
    setSendShots(value);
    updateSettings({ sendScreenshots: value });
    connection.refreshScreenshots(); // arranca o para el vigilante al momento
  };
  const toggleGallery = (value: boolean) => {
    setSaveGallery(value);
    updateSettings({ saveToGallery: value }); // se lee en cada imagen recibida
  };

  const forget = () => {
    if (!pcName) return;
    Alert.alert(`¿Olvidar «${pcName}»?`, 'Tendrás que volver a escanear el QR.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Olvidar', style: 'destructive', onPress: () => connection.forgetPc() },
    ]);
  };

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
        <View style={[styles.card, styles.cardGap]}>
          <Text style={styles.label}>PC emparejado</Text>
          <Text style={[styles.value, !pcName && styles.valueEmpty]} numberOfLines={2}>
            {pcName ?? 'Ninguno'}
          </Text>
          <View style={styles.actions}>
            {pcName && (
              <Pressable
                style={({ pressed }) => [styles.change, pressed && styles.changePressed]}
                onPress={forget}
                accessibilityRole="button"
                accessibilityLabel={`Olvidar ${pcName}`}
              >
                <Text style={[styles.changeText, styles.forgetText]}>Olvidar</Text>
              </Pressable>
            )}
            <Pressable
              style={({ pressed }) => [styles.change, pressed && styles.changePressed]}
              onPress={() => router.push('/scan')}
              accessibilityRole="button"
            >
              <Text style={styles.changeText}>Emparejar otro PC</Text>
            </Pressable>
          </View>
        </View>

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
            style={({ pressed }) => [styles.change, styles.changeTop, pressed && styles.changePressed, busy && styles.changeBusy]}
            onPress={change}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Cambiar carpeta de recepción"
            accessibilityState={{ disabled: busy }}
          >
            <Text style={styles.changeText}>Cambiar</Text>
          </Pressable>
        </View>

        <View style={[styles.card, styles.cardTop]}>
          <Text style={styles.label}>Imágenes y capturas</Text>
          <ToggleRow
            title="Enviar capturas automáticamente"
            hint="Las capturas de pantalla nuevas se envían al PC al volver a ClipSync."
            value={sendShots}
            onChange={toggleShots}
          />
          {sendShots && conn.photoAccessMissing && (
            <View style={styles.permission}>
              <Text style={styles.hint}>{PHOTO_ACCESS_NOTICE}</Text>
              <Pressable
                style={({ pressed }) => [styles.change, styles.changeTop, pressed && styles.changePressed]}
                onPress={() => {
                  Linking.openSettings().catch(() => {});
                }}
                accessibilityRole="button"
                accessibilityLabel="Abrir ajustes de Android para permitir el acceso a las fotos"
              >
                <Text style={styles.changeText}>Abrir ajustes</Text>
              </Pressable>
            </View>
          )}
          <ToggleRow
            title="Guardar imágenes recibidas en la galería"
            hint="Se guardan en el álbum «ClipSync»."
            value={saveGallery}
            onChange={toggleGallery}
          />
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
  cardGap: { marginBottom: 12 },
  cardTop: { marginTop: 12 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TOUCH, marginTop: 10 },
  toggleText: { flex: 1 },
  permission: { marginTop: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  forgetText: { color: colors.danger },
  label: { ...type.section, color: colors.textMuted },
  value: { ...type.body, color: colors.text, fontWeight: '600', marginTop: 6 },
  valueEmpty: { color: colors.textMuted, fontWeight: '400' },
  hint: { ...type.small, color: colors.textMuted, marginTop: 4 },
  change: {
    minHeight: TOUCH,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  changeTop: { marginTop: 14 },
  changePressed: { backgroundColor: colors.surfaceAlt },
  changeBusy: { opacity: 0.45 },
  changeText: { ...type.body, color: colors.text, fontWeight: '600' },
  version: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: 20 },
});
