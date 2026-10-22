// Qué medios probar y cuándo cambiar a uno mejor (puro, sin React Native). Spec §4.
import { CONNECT_TIMEOUT_MS } from '@clipsync/protocol';

export type Transport = 'wifi' | 'usb' | 'bluetooth';
export type TransportMode = 'auto' | Transport;

/** Plazo de conexión por Bluetooth: el enlace RFCOMM tarda bastante más que un TCP local. */
export const BT_CONNECT_TIMEOUT_MS = 8000;
/** Cada cuánto se mira, estando en un medio peor, si hay uno mejor. */
export const UPGRADE_INTERVAL_MS = 30_000;
/** Tras un intento fallido de Bluetooth en Auto, no se vuelve a intentar hasta pasado este plazo. */
export const BT_RETRY_COOLDOWN_MS = 30_000;

/** Orden de preferencia en Auto. */
const PRIORITY: readonly Transport[] = ['wifi', 'usb', 'bluetooth'];

export function transportTimeoutMs(t: Transport): number {
  return t === 'bluetooth' ? BT_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
}

/** Por qué Bluetooth no se puede usar ahora. */
export type BluetoothIssue = 'no_address' | 'no_permission' | 'off' | 'unavailable';

export const BLUETOOTH_ISSUE_MESSAGES: Record<BluetoothIssue, string> = {
  no_address: 'Empareja el móvil y el PC en los ajustes de Bluetooth del sistema',
  no_permission: 'Permite el acceso a Bluetooth para conectar sin WiFi',
  off: 'Bluetooth apagado',
  unavailable: 'Este móvil no tiene Bluetooth',
};

export interface PolicyCtx {
  /** Dirección Bluetooth del PC (del QR o elegida de la lista de emparejados). */
  btAddress: string | null;
  /** `undetermined`: aún no se ha pedido; se pedirá al primer uso. */
  btPermission: 'granted' | 'denied' | 'undetermined';
  btState: 'on' | 'off' | 'unavailable';
  /** Un intento de Bluetooth falló hace poco (solo frena el modo Auto). */
  btCoolingDown: boolean;
}

export interface Candidates {
  /** Medios a probar, por orden. */
  transports: Transport[];
  /** Motivo por el que Bluetooth no está disponible (aunque no se pida), para la interfaz. */
  issue: BluetoothIssue | null;
  /** Modo fijo Bluetooth que no puede ni intentarse: el aviso para `lastError`. */
  reason: string | null;
}

export function bluetoothIssue(ctx: Pick<PolicyCtx, 'btAddress' | 'btPermission' | 'btState'>): BluetoothIssue | null {
  if (ctx.btState === 'unavailable') return 'unavailable';
  if (ctx.btAddress === null) return 'no_address';
  if (ctx.btPermission === 'denied') return 'no_permission';
  if (ctx.btState === 'off') return 'off';
  return null;
}

export function candidates(mode: TransportMode, ctx: PolicyCtx): Candidates {
  const issue = bluetoothIssue(ctx);
  if (mode === 'bluetooth') {
    return issue
      ? { transports: [], issue, reason: BLUETOOTH_ISSUE_MESSAGES[issue] }
      : { transports: ['bluetooth'], issue: null, reason: null };
  }
  if (mode !== 'auto') return { transports: [mode], issue, reason: null };
  const transports: Transport[] = ['wifi', 'usb'];
  if (issue === null && !ctx.btCoolingDown) transports.push('bluetooth');
  return { transports, issue, reason: null };
}

/** Los medios que Auto prefiere a `current`, por orden. */
export function betterTransports(current: Transport): Transport[] {
  return PRIORITY.slice(0, PRIORITY.indexOf(current));
}

/** ¿Vale este medio con este modo? (Auto admite todos.) */
export function allowsTransport(mode: TransportMode, t: Transport): boolean {
  return mode === 'auto' || mode === t;
}

/** ¿La sesión actual va por un medio que el modo elegido ya no admite? (Cambio pendiente de aplicar.) */
export function modeChangePending(mode: TransportMode, current: Transport | null): boolean {
  return current !== null && !allowsTransport(mode, current);
}

/**
 * Qué hacer al cambiar de modo (o al terminar lo pendiente, cuando hay un cambio aplazado):
 * - `wake`: la sesión sirve (o no hay) y solo se despierta el bucle;
 * - `restart`: la sesión va por un medio no admitido y nada la ata: se reinicia;
 * - `defer`: lo mismo, pero hay transferencias en curso o en cola: no se corta la sesión (R2),
 *   se espera a que termine.
 */
export type ModeChangeAction = 'wake' | 'restart' | 'defer';

export function modeChangeAction(mode: TransportMode, current: Transport | null, busy: boolean): ModeChangeAction {
  if (!modeChangePending(mode, current)) return 'wake';
  return busy ? 'defer' : 'restart';
}

/**
 * ¿Toca buscar un medio mejor? Solo en Auto, estando en uno peor desde hace al menos
 * `UPGRADE_INTERVAL_MS` y sin transferencias en curso ni en cola.
 */
export function shouldUpgrade(
  current: Transport,
  mode: TransportMode,
  s: { connectedForMs: number; busy: boolean },
): boolean {
  return mode === 'auto' && !s.busy && s.connectedForMs >= UPGRADE_INTERVAL_MS && betterTransports(current).length > 0;
}

/** Espera tras un fallo de Bluetooth en Auto. Un reloj que retrocede no bloquea. */
export function btCoolingDown(lastFailAt: number | null, now: number): boolean {
  if (lastFailAt === null) return false;
  const elapsed = now - lastFailAt;
  return elapsed >= 0 && elapsed < BT_RETRY_COOLDOWN_MS;
}

// --- lo leído de settings.json ---

const MODES: readonly string[] = ['auto', 'wifi', 'usb', 'bluetooth'];
const BT_ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

export function parseTransportMode(raw: unknown): TransportMode {
  return typeof raw === 'string' && MODES.includes(raw) ? (raw as TransportMode) : 'auto';
}

export function parseBtAddress(raw: unknown): string | null {
  return typeof raw === 'string' && BT_ADDRESS.test(raw) ? raw : null;
}
