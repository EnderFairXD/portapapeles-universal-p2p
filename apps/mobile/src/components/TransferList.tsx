import type { TransferUpdate } from '@clipsync/protocol';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { isAlive, percent, transferDetail } from '@/lib/format';
import { colors, radius, TOUCH, type } from '@/theme';

import { DirectionBadge } from './DirectionBadge';

interface Props {
  transfers: TransferUpdate[];
  onCancel: (transferId: string) => void;
}

function Row({ t, onCancel }: { t: TransferUpdate; onCancel: (id: string) => void }) {
  const alive = isAlive(t.state);
  const pct = percent(t.bytes, t.size);
  const name = t.name || 'archivo';
  return (
    <View style={styles.row}>
      <DirectionBadge direction={t.direction} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </Text>
        <Text style={[styles.detail, t.state === 'failed' && styles.detailFailed]} numberOfLines={2}>
          {transferDetail(t)}
        </Text>
        {alive && (
          <View
            style={styles.bar}
            accessibilityRole="progressbar"
            accessibilityLabel={`Progreso de ${name}`}
            accessibilityValue={{ min: 0, max: 100, now: pct }}
          >
            <View style={[styles.fill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
      {alive && (
        <Pressable
          style={({ pressed }) => [styles.cancel, pressed && styles.cancelPressed]}
          onPress={() => onCancel(t.transferId)}
          accessibilityRole="button"
          accessibilityLabel={`Cancelar ${name}`}
        >
          <Text style={styles.cancelText}>Cancelar</Text>
        </Pressable>
      )}
    </View>
  );
}

export function TransferList({ transfers, onCancel }: Props) {
  if (transfers.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.title} accessibilityRole="header">
        Transferencias
      </Text>
      <View style={styles.list}>
        {transfers.map((t) => (
          <Row key={t.transferId} t={t} onCancel={onCancel} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 22 },
  title: { ...type.section, color: colors.textMuted, marginBottom: 8 },
  list: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  body: { flex: 1, minWidth: 0 },
  name: { ...type.body, color: colors.text, fontWeight: '600' },
  detail: { ...type.small, color: colors.textMuted, marginTop: 2 },
  detailFailed: { color: colors.danger },
  bar: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceAlt, marginTop: 8, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.cyan },
  cancel: {
    minHeight: TOUCH,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelPressed: { backgroundColor: colors.surfaceAlt },
  cancelText: { ...type.small, color: colors.text, fontWeight: '600' },
});
