// Cola de archivos de «Compartir → ClipSync» (pura, sin React Native).

export type ShareStep = { kind: 'sent' } | { kind: 'no_connection' } | { kind: 'failed'; message: string };

export interface ShareProgress {
  /** El intent al que pertenece el progreso. */
  intent: unknown;
  /** Siguiente archivo por enviar. */
  next: number;
  /** Último fallo de un archivo ya descartado; se muestra al terminar. */
  failure: string | null;
}

export function newShareProgress(intent: unknown): ShareProgress {
  return { intent, next: 0, failure: null };
}

/**
 * Envía los archivos desde `progress.next`. Un archivo que falla se salta (su aviso queda en
 * `progress.failure`, no se reintenta); si se cae la conexión se para y se sigue al volver.
 * `done` = no queda nada por enviar.
 */
export function runShareQueue<T>(files: readonly T[], progress: ShareProgress, send: (file: T) => ShareStep): 'done' | 'waiting' {
  while (progress.next < files.length) {
    const step = send(files[progress.next]);
    if (step.kind === 'no_connection') return 'waiting';
    if (step.kind === 'failed') progress.failure = step.message;
    progress.next += 1;
  }
  return 'done';
}
