// Textos de la interfaz: puros y sin React Native, para poder probarlos.
import type { TransferUpdate } from '@clipsync/protocol';

/** Mismos códigos y textos que ERROR_TEXT del PC (apps/desktop/src/render.ts). */
const ERROR_TEXT = new Map([
  ['link_closed', 'se perdió la conexión'],
  ['heartbeat_timeout', 'el PC dejó de responder'],
  ['replaced', 'la conexión se reemplazó por una nueva'],
  ['closed', 'se cerró la conexión'],
  ['no_peer', 'no hay PC conectado'],
  ['cancelled', 'se canceló'],
  ['read_error', 'no se pudo leer el archivo'],
  ['write_error', 'no se pudo guardar el archivo'],
  ['io_error', 'no se pudo guardar el archivo'],
  ['size_mismatch', 'el tamaño no coincide'],
  ['checksum_mismatch', 'el archivo llegó dañado'],
  ['hash_mismatch', 'el archivo llegó dañado'],
  ['protocol_error', 'error de protocolo'],
  ['internal_error', 'error interno'],
  ['remote_error', 'el PC informó de un error'],
]);

/** «Falló: motivo» para los códigos conocidos; «Falló» para el resto (nunca se muestra texto de la red). */
export function failureText(code: string | null | undefined): string {
  const reason = typeof code === 'string' ? ERROR_TEXT.get(code) : undefined;
  return reason ? `Falló: ${reason}` : 'Falló';
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** «2,5 MB de 5,0 MB»: coma decimal, múltiplos de 1024 y la unidad del tamaño total. */
export function formatProgress(bytes: number, size: number): string {
  let unit = 0;
  while (unit < UNITS.length - 1 && size >= 1024 ** (unit + 1)) unit++;
  const fmt = (n: number) => {
    const v = Number.isFinite(n) ? Math.max(0, n) : 0;
    return unit === 0 ? String(Math.round(v)) : (v / 1024 ** unit).toFixed(1).replace('.', ',');
  };
  return `${fmt(bytes)} ${UNITS[unit]} de ${fmt(size)} ${UNITS[unit]}`;
}

/** Porcentaje entero 0-100; un archivo de 0 bytes cuenta como 0 hasta que termine. */
export function percent(bytes: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(bytes)) return 0;
  return Math.min(100, Math.max(0, Math.floor((bytes / size) * 100)));
}

/** Línea de estado de una transferencia. */
export function transferDetail(t: Pick<TransferUpdate, 'state' | 'bytes' | 'size' | 'error'>): string {
  switch (t.state) {
    case 'queued':
      return 'En cola';
    case 'cancelled':
      return 'Cancelado';
    case 'failed':
      return failureText(t.error);
    default:
      return formatProgress(t.bytes, t.size);
  }
}

/** Una transferencia se puede cancelar mientras siga viva. */
export function isAlive(state: TransferUpdate['state']): boolean {
  return state === 'queued' || state === 'active';
}

/** «14:05» */
export function formatClock(atMs: number): string | null {
  if (!Number.isFinite(atMs) || atMs <= 0) return null;
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Recorta un texto largo sin partir un par sustituto. */
export function preview(text: string, max = 300): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/** Ruta legible de una carpeta SAF: content://…/tree/primary%3ADownload%2FClipSync → «Download/ClipSync». */
export function readableDir(uri: string | null | undefined): string {
  if (!uri) return 'Sin elegir';
  let id = uri;
  const tree = uri.indexOf('/tree/');
  if (tree >= 0) id = uri.slice(tree + '/tree/'.length);
  id = id.split('/document/')[0];
  try {
    id = decodeURIComponent(id);
  } catch {
    // se deja tal cual
  }
  const colon = id.indexOf(':');
  const volume = colon >= 0 ? id.slice(0, colon) : '';
  const path = (colon >= 0 ? id.slice(colon + 1) : id).replace(/^\/+|\/+$/g, '');
  if (path) return path;
  return volume === 'primary' ? 'Almacenamiento interno' : volume || 'Sin elegir';
}

/** «1 archivo» / «3 archivos» */
export function filesLabel(n: number): string {
  return n === 1 ? '1 archivo' : `${n} archivos`;
}
