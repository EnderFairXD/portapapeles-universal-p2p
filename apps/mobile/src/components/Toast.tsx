import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';

import { colors, radius, type } from '@/theme';

/** Aviso breve abajo («Copiado»). El texto se conserva mientras se desvanece. */
export function Toast({ message, visible, bottom }: { message: string; visible: boolean; bottom: number }) {
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: 160, useNativeDriver: true }).start();
  }, [visible, opacity]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.toast, { bottom, opacity }]}
      accessibilityLiveRegion="polite"
      accessibilityElementsHidden={!visible}
    >
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: { ...type.small, color: colors.text, fontWeight: '600' },
});
