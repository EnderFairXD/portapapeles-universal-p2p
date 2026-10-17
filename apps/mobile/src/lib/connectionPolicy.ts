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

// --- envío de archivos ---

export const NO_CONNECTION_MESSAGE = 'No hay conexión con el PC';
export const INVALID_FILE_SIZE_MESSAGE = 'No se pudo leer el tamaño del archivo';

/** Resultado de encolar un archivo: sin sesión (se puede reintentar) o rechazado (no tiene arreglo). */
export type SendFileResult = { ok: true; id: string } | { ok: false; reason: 'no_session' | 'rejected' };

/**
 * Clasifica el fallo de `Session.sendFile`: un tamaño inválido (RangeError) es un rechazo del
 * archivo; cualquier otro (sesión cerrada o no lista) es falta de sesión.
 */
export function classifySendError(e: unknown): 'no_session' | 'rejected' {
  return e instanceof RangeError ? 'rejected' : 'no_session';
}

/** Aviso a mostrar tras un envío: solo «sin conexión» si no había sesión; un rechazo ya dejó el suyo. */
export function sendFailureMessage(result: SendFileResult): string | null {
  return !result.ok && result.reason === 'no_session' ? NO_CONNECTION_MESSAGE : null;
}

// --- pausa diferida tras un selector ---

export interface PauseCheckDeps {
  delayMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  appState(): string;
  pickerOpen(): boolean;
  pause(): void;
}

/**
 * Tras cerrarse un selector, Android resuelve su promesa antes de que la app vuelva a
 * 'active': comprobar al momento pararía la sesión en cada selección normal. Se espera
 * `delayMs` y solo entonces se mira si la app sigue en segundo plano.
 */
export function createPauseCheck(deps: PauseCheckDeps): { schedule(): void; cancel(): void } {
  let handle: unknown = null;
  const cancel = () => {
    if (handle !== null) deps.clearTimer(handle);
    handle = null;
  };
  return {
    schedule() {
      cancel();
      handle = deps.setTimer(() => {
        handle = null;
        if (deps.appState() === 'background' && !deps.pickerOpen()) deps.pause();
      }, deps.delayMs);
    },
    cancel,
  };
}
