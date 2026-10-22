import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MODE_CHANGE_NOTICE, PHOTO_ACCESS_NOTICE } from '@/components/StatusCard';
import { connection, type BondedDevice } from '@/lib/connection';
import { chooseReceiveDir } from '@/lib/files';
import { readableDir } from '@/lib/format';
import { loadSettings, updateSettings } from '@/lib/settings';
import { BLUETOOTH_ISSUE_MESSAGES, modeChangePending, type TransportMode } from '@/lib/transportPolicy';
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

const MODE_OPTIONS: { mode: TransportMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'wifi', label: 'WiFi' },
  { mode: 'usb', label: 'USB' },
  { mode: 'bluetooth', label: 'Bluetooth' },
];

const MODE_HINTS: Record<TransportMode, string> = {
  auto: 'Prueba WiFi, USB y Bluetooth, por ese orden, y cambia al mejor cuando puede.',
  wifi: 'Solo se conecta por la red WiFi.',
  usb: 'Solo se conecta por cable USB.',
  bluetooth: 'Solo se conecta por Bluetooth.',
};

/** Selector de una opción entre varias, en una fila. */
function Segmented({ label, options, value, onChange }: {
  label: string;
  options: { mode: TransportMode; label: string }[];
  value: TransportMode;
  onChange: (mode: TransportMode) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const selected = o.mode === value;
        return (
          <Pressable
            key={o.mode}
            style={[styles.segment, selected && styles.segmentOn]}
            onPress={() => onChange(o.mode)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: selected }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
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

  // lista de dispositivos Bluetooth emparejados en el sistema (null: aún no se ha abierto)
  const [bonded, setBonded] = useState<BondedDevice[] | null>(null);
  const [listing, setListing] = useState(false);
  const [btDenied, setBtDenied] = useState(false);
  const modePending = modeChangePending(conn.transportMode, conn.transport);
  const permissionMissing = btDenied || conn.bluetoothIssue === 'no_permission';

  const chooseMode = (mode: TransportMode) => connection.setTransportMode(mode);

  const openBonded = async () => {
    if (listing) return;
    setListing(true);
    try {
      const list = await connection.bondedDevices();
      // sin lista y con el aviso de permiso puesto, es que se denegó el permiso
      setBtDenied(list.length === 0 && connection.getState().lastError === BLUETOOTH_ISSUE_MESSAGES.no_permission);
      setBonded(list);
    } finally {
      setListing(false);
    }
  };

  const pickDevice = (d: BondedDevice) => {
    connection.setBtAddress(d.address);
    setBonded(null);
    setBtDenied(false);
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
          <Text style={styles.label}>Medio de conexión</Text>
          <Segmented label="Medio de conexión" options={MODE_OPTIONS} value={conn.transportMode} onChange={chooseMode} />
          <Text style={styles.hint}>{MODE_HINTS[conn.transportMode]}</Text>
          {modePending && (
            <Text style={[styles.hint, styles.pendingNote]} accessibilityLiveRegion="polite">
              {MODE_CHANGE_NOTICE}
            </Text>
          )}
        </View>

        <View style={[styles.card, styles.cardTop]}>
          <Text style={styles.label}>PC por Bluetooth</Text>
          <Text style={[styles.value, !conn.btAddress && styles.valueEmpty]} numberOfLines={1}>
            {conn.btAddress ?? 'Sin elegir'}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.change, styles.changeTop, pressed && styles.changePressed, listing && styles.changeBusy]}
            onPress={openBonded}
            disabled={listing}
            accessibilityRole="button"
            accessibilityLabel="Elegir el PC entre los dispositivos Bluetooth emparejados"
            accessibilityState={{ disabled: listing }}
          >
            <Text style={styles.changeText}>Elegir</Text>
          </Pressable>
          {bonded && bonded.length > 0 && (
            <View style={styles.devices}>
              {bonded.map((d) => (
                <Pressable
                  key={d.address}
                  style={({ pressed }) => [styles.device, pressed && styles.changePressed]}
                  onPress={() => pickDevice(d)}
                  accessibilityRole="button"
                  accessibilityLabel={`Usar ${d.name || d.address}`}
                >
                  <Text style={styles.value} numberOfLines={1}>
                    {d.name || 'Sin nombre'}
                  </Text>
                  <Text style={styles.hint}>{d.address}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {bonded && bonded.length === 0 && !permissionMissing && (
            <Text style={styles.hint}>{BLUETOOTH_ISSUE_MESSAGES.no_address}</Text>
          )}
          {permissionMissing && (
            <View style={styles.permission}>
              <Text style={styles.hint}>{BLUETOOTH_ISSUE_MESSAGES.no_permission}</Text>
              <Pressable
                style={({ pressed }) => [styles.change, styles.changeTop, pressed && styles.changePressed]}
                onPress={() => {
                  Linking.openSettings().catch(() => {});
                }}
                accessibilityRole="button"
                accessibilityLabel="Abrir ajustes de Android para permitir el acceso a Bluetooth"
              >
                <Text style={styles.changeText}>Abrir ajustes</Text>
              </Pressable>
            </View>
          )}
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
  segmented: {
    flexDirection: 'row',
    marginTop: 10,
    padding: 3,
    gap: 3,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segment: { flex: 1, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  segmentOn: { backgroundColor: colors.indigoDeep },
  segmentText: { ...type.small, color: colors.textMuted, fontWeight: '600' },
  segmentTextOn: { color: '#fff' },
  pendingNote: { color: colors.outFg, fontWeight: '600' },
  devices: { marginTop: 10, gap: 6 },
  device: {
    minHeight: TOUCH,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  version: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginTop: 20 },
});
