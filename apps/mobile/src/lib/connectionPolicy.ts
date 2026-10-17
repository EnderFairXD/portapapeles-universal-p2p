// Decisiones puras de ConnectionManager (sin React Native), para poder probarlas.

/** Una sesión que duró menos que esto antes de caer no cuenta como estable. */
export const STABLE_SESSION_MS = 5000;

/**
 * Espera antes de volver a conectar. Solo se reintenta al instante si la sesión llegó a
 * `ready` y aguantó lo suficiente; si cae enseguida, se espera el intervalo normal para no
 * entrar en un bucle de conexión/caída.
 */
export function reconnectDelayMs(wasReady: boolean, readyForMs: number, intervalMs: number): number {
  return wasReady && readyForMs >= STABLE_SESSION_MS ? 0 : intervalMs;
}

export type LocalSendOutcome = 'record' | 'too_large' | 'none';

/**
 * Qué hacer tras `sendClip`: un envío cuenta (historial y borrar el error) solo si la sesión
 * sigue abierta; si el socket estaba muerto, `write` la cierra y el texto no llegó.
 */
export function localSendOutcome(decision: string, sessionStillOpen: boolean): LocalSendOutcome {
  if (decision === 'too_large') return 'too_large';
  if (decision === 'send' && sessionStillOpen) return 'record';
  return 'none';
}
