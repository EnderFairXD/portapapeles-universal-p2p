// Decisiones puras de ConnectionManager (sin React Native), para poder probarlas.
import type { TransferUpdate } from '@clipsync/protocol';

import type { Transport } from './transportPolicy';

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
  /** Lo que cree JS (`AppState.currentState`): llega con retraso si el hilo de JS está ocupado. */
  appState(): string;
  /** Pregunta a Android su estado actual, que se actualiza en `onHostResume` sin esperar a JS. */
  confirmAppState(): Promise<string>;
  pickerOpen(): boolean;
  pause(): void;
}

/**
 * Tras cerrarse un selector, Android resuelve su promesa antes de que la app vuelva a
 * 'active': comprobar al momento pararía la sesión en cada selección normal. Se espera
 * `delayMs` y solo entonces se mira si la app sigue en segundo plano.
 *
 * `AppState.currentState` solo cambia al procesarse el evento nativo: si una llamada síncrona
 * larga (p. ej. crear el archivo en una carpeta SAF, 3 s en MIUI) bloquea el hilo de JS, el
 * temporizador puede correr antes que el evento 'active' y ver aún 'background'. Por eso, antes
 * de pausar, se confirma con la parte nativa; si esa consulta falla, decide lo que crea JS entonces.
 */
export function createPauseCheck(deps: PauseCheckDeps): { schedule(): void; cancel(): void } {
  let handle: unknown = null;
  // sube con cada schedule()/cancel(): una consulta nativa de una vuelta anterior ya no vale
  let round = 0;
  const cancel = () => {
    round += 1;
    if (handle !== null) deps.clearTimer(handle);
    handle = null;
  };
  const stillBackground = (state: string, mine: number) =>
    mine === round && state === 'background' && !deps.pickerOpen();
  return {
    schedule() {
      cancel();
      const mine = round;
      handle = deps.setTimer(() => {
        handle = null;
        if (!stillBackground(deps.appState(), mine)) return;
        deps.confirmAppState().then(
          (state) => {
            if (stillBackground(state, mine)) deps.pause();
          },
          () => {
            if (stillBackground(deps.appState(), mine)) deps.pause();
          },
        );
      }, deps.delayMs);
    },
    cancel,
  };
}

// --- segundo plano con trabajo pendiente (I1) ---

/** Hay algo que no debe cortarse: archivos en cola o en curso, o un compartir sin enviar. */
export function hasPendingWork(transfers: readonly TransferUpdate[], sharePending: boolean): boolean {
  return sharePending || transfers.some((t) => t.state === 'queued' || t.state === 'active');
}

export type BackgroundDecision = 'pause' | 'watcher_only' | 'none';

/**
 * Qué hacer al pasar a segundo plano, al cerrarse un selector o al terminar lo pendiente:
 * con trabajo pendiente solo se para el vigilante del portapapeles y la pausa espera a que
 * acabe (la conexión dura lo que Android permita, spec §9). Con un selector abierto no se
 * hace nada: lo decide la comprobación diferida de `createPauseCheck` (R26).
 */
export function backgroundDecision(s: { appState: string; pickerOpen: boolean; busy: boolean }): BackgroundDecision {
  if (s.appState !== 'background' || s.pickerOpen) return 'none';
  return s.busy ? 'watcher_only' : 'pause';
}

// --- cierre de la sesión: reintentar o desemparejar (D8) ---

/** Handshakes fallidos seguidos, con el PC alcanzable, tras los que se da el emparejamiento por roto. */
export const MAX_HANDSHAKE_FAILURES = 3;

export type CloseOutcome = { kind: 'retry'; handshakeFailures: number } | { kind: 'unpair'; message: string };

/**
 * Qué hacer cuando se cierra la sesión. `ctx.handshakeFailures` son los fallos seguidos hasta
 * ahora (sin contar este cierre), `tokenSent` si esta sesión llevaba el token del QR y
 * `transport` por dónde se conectó.
 */
export function closeOutcome(
  reason: string,
  ctx: { tokenSent: boolean; handshakeFailures: number; transport: Transport },
): CloseOutcome {
  switch (reason) {
    case 'not_paired':
      return {
        kind: 'unpair',
        message: ctx.tokenSent ? 'El QR no es válido. Genera uno nuevo en el PC.' : 'Este PC no te reconoce. Vuelve a emparejar.',
      };
    case 'pairing_expired':
      return { kind: 'unpair', message: 'QR caducado. Genera uno nuevo en el PC.' };
    case 'handshake_failed': {
      // Con `adb reverse` activo, 127.0.0.1 siempre acepta la conexión (la acepta adbd) y la cierra
      // si la app del PC no está escuchando: eso no prueba que el PC sea alcanzable, así que por
      // USB un handshake fallido no cuenta (D8: solo «con el PC alcanzable»). Por Bluetooth tampoco:
      // fuera de alcance, con el PC suspendido o rechazando la autenticación, el enlace RFCOMM cae
      // en el handshake sin que el emparejamiento esté roto. Solo WiFi cuenta.
      if (ctx.transport !== 'wifi') return { kind: 'retry', handshakeFailures: ctx.handshakeFailures };
      const failures = ctx.handshakeFailures + 1;
      return failures >= MAX_HANDSHAKE_FAILURES
        ? { kind: 'unpair', message: 'No se pudo verificar el PC. Vuelve a emparejar.' }
        : { kind: 'retry', handshakeFailures: failures };
    }
    default:
      return { kind: 'retry', handshakeFailures: ctx.handshakeFailures };
  }
}
