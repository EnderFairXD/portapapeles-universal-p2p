import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { HistoryEntry } from '@/lib/connection';
import { formatClock, preview } from '@/lib/format';
import { colors, radius, TOUCH, type } from '@/theme';

import { DirectionBadge } from './DirectionBadge';

interface RowProps {
  entry: HistoryEntry;
  onCopy: (text: string) => void;
}

/** Una fila del historial: tocar un texto lo copia; los archivos solo informan. */
function HistoryRow({ entry, onCopy }: RowProps) {
  const time = formatClock(entry.at);
  const isFile = entry.kind === 'file';
  const text = entry.text ?? '';
  const fileName = entry.fileName || 'archivo';

  const content = (
    <>
      <DirectionBadge direction={entry.direction} />
      <View style={styles.body}>
        {isFile ? (
          <>
            <Text style={styles.fileName} numberOfLines={1} ellipsizeMode="middle">
              {fileName}
            </Text>
            <Text style={styles.fileHint}>{entry.direction === 'in' ? 'Archivo recibido' : 'Archivo enviado'}</Text>
          </>
        ) : (
          <Text style={styles.text} numberOfLines={3}>
            {preview(text)}
          </Text>
        )}
      </View>
      {time && <Text style={styles.time}>{time}</Text>}
    </>
  );

  if (isFile) {
    return <View style={styles.row}>{content}</View>;
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onCopy(text)}
      accessibilityRole="button"
      accessibilityLabel={`${entry.direction === 'in' ? 'Recibido' : 'Enviado'}: ${preview(text, 120)}`}
      accessibilityHint="Toca para copiar al portapapeles"
    >
      {content}
    </Pressable>
  );
}

/** Hasta 50 elementos: no hace falta virtualizar. */
export function HistoryList({ history, onCopy }: { history: HistoryEntry[]; onCopy: (text: string) => void }) {
  return (
    <View style={styles.section}>
      <Text style={styles.title} accessibilityRole="header">
        Historial
      </Text>
      {history.length === 0 ? (
        <Text style={styles.empty}>Los textos que copies con el PC conectado aparecerán aquí.</Text>
      ) : (
        history.map((h) => <HistoryRow key={h.id} entry={h} onCopy={onCopy} />)
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 22 },
  title: { ...type.section, color: colors.textMuted, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    minHeight: TOUCH,
    padding: 12,
    marginBottom: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  body: { flex: 1, minWidth: 0 },
  text: { ...type.body, color: colors.text },
  fileName: { ...type.body, color: colors.text, fontWeight: '600' },
  fileHint: { ...type.small, color: colors.textMuted, marginTop: 2 },
  time: { ...type.small, color: colors.textMuted },
  empty: { ...type.small, color: colors.textMuted, paddingVertical: 8 },
});
