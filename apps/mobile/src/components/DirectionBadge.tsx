import { StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

/** Flecha de dirección: ↑ enviado (índigo), ↓ recibido (cian), como en el PC. */
export function DirectionBadge({ direction }: { direction: 'in' | 'out' }) {
  const out = direction === 'out';
  return (
    <View
      style={[styles.badge, { backgroundColor: out ? colors.outBg : colors.inBg }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={out ? 'Enviado' : 'Recibido'}
    >
      <Text style={[styles.arrow, { color: out ? colors.outFg : colors.inFg }]}>{out ? '↑' : '↓'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { width: 28, height: 28, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  arrow: { fontSize: 15, fontWeight: '700', lineHeight: 18 },
});
