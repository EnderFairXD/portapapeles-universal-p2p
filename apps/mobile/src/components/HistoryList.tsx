import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { HistoryEntry } from '@/lib/connection';
import { formatClock, preview } from '@/lib/format';
import { colors, radius, TOUCH, type } from '@/theme';

import { DirectionBadge } from './DirectionBadge';

interface RowProps {
  entry: HistoryEntry;
  onCopy: (entry: HistoryEntry) => void;
}

const THUMB = 56;

/** Miniatura de una imagen del historial; si ya no se puede cargar, un recuadro con «Imagen». */
function Thumb({ uri, label }: { uri: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={[styles.thumb, styles.thumbMissing]} accessibilityLabel={label}>
        <Text style={styles.thumbMissingText}>Imagen</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={styles.thumb}
      resizeMode="cover"
      resizeMethod="resize"
      onError={() => setFailed(true)}
      accessible
      accessibilityLabel={label}
    />
  );
}

/** Una fila del historial: tocar un texto o una imagen la copia; los archivos solo informan. */
function HistoryRow({ entry, onCopy }: RowProps) {
  const time = formatClock(entry.at);
  const isFile = entry.kind === 'file';
  const isImage = entry.kind === 'image';
  const text = entry.text ?? '';
  const fileName = entry.fileName || 'archivo';
  const imageLabel = entry.direction === 'in' ? 'Imagen recibida' : 'Imagen enviada';

  const content = (
    <>
      <DirectionBadge direction={entry.direction} />
      <View style={styles.body}>
        {isImage ? (
          <>
            {entry.imageUri && <Thumb uri={entry.imageUri} label={`Miniatura. ${imageLabel}`} />}
            <Text style={styles.fileHint}>{imageLabel}</Text>
          </>
        ) : isFile ? (
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

  // un archivo, o una imagen sin copia que poner en el portapapeles, solo informan
  if (isFile || (isImage && !entry.imageUri)) {
    return <View style={styles.row}>{content}</View>;
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onCopy(entry)}
      accessibilityRole="button"
      accessibilityLabel={isImage ? imageLabel : `${entry.direction === 'in' ? 'Recibido' : 'Enviado'}: ${preview(text, 120)}`}
      accessibilityHint="Toca para copiar al portapapeles"
    >
      {content}
    </Pressable>
  );
}

/** Hasta 50 elementos: no hace falta virtualizar. */
export function HistoryList({ history, onCopy }: { history: HistoryEntry[]; onCopy: (entry: HistoryEntry) => void }) {
  return (
    <View style={styles.section}>
      <Text style={styles.title} accessibilityRole="header">
        Historial
      </Text>
      {history.length === 0 ? (
        <Text style={styles.empty}>Lo que copies con el PC conectado (textos e imágenes) aparecerá aquí.</Text>
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
  thumb: { width: THUMB, height: THUMB, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt, marginBottom: 6 },
  thumbMissing: { alignItems: 'center', justifyContent: 'center' },
  thumbMissingText: { ...type.small, color: colors.textMuted },
  time: { ...type.small, color: colors.textMuted },
  empty: { ...type.small, color: colors.textMuted, paddingVertical: 8 },
});
