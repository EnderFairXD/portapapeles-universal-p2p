// Datos del PC emparejado y su validación (puro, sin React Native).
import type { PairingInfo } from '@clipsync/protocol';

/** El PC con el que está emparejado este móvil, tal como se guarda en settings.json. */
export interface PairedPc {
  /** Clave pública Noise del PC: 64 hex en minúscula. */
  publicKeyHex: string;
  name: string;
  /** IPv4 del PC que llevaba el QR. */
  ips: string[];
  port: number;
  /** Token del QR mientras el emparejamiento no se ha completado; después, null. */
  token: string | null;
}

const KEY_HEX = /^[0-9a-f]{64}$/;
const MAX_NAME_CODE_POINTS = 64;

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Hex (longitud par, minúscula o mayúscula) → bytes. Solo para texto ya validado. */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** El PC ya recorta el nombre; aquí se vuelve a hacer por si el QR no viene de él. */
function capName(name: string): string {
  const points = Array.from(name);
  return points.length > MAX_NAME_CODE_POINTS ? points.slice(0, MAX_NAME_CODE_POINTS).join('') : name;
}

export function pairedPcFromInfo(info: PairingInfo): PairedPc {
  return {
    publicKeyHex: bytesToHex(info.publicKey),
    name: capName(info.name),
    ips: [...info.ips],
    port: info.port,
    token: info.token,
  };
}

/** Valida lo leído de settings.json. */
export function parsePairedPc(raw: unknown): PairedPc | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { publicKeyHex, name, ips, port, token } = raw as Record<string, unknown>;
  if (typeof publicKeyHex !== 'string' || !KEY_HEX.test(publicKeyHex)) return null;
  if (typeof name !== 'string') return null;
  if (!Array.isArray(ips) || !ips.every((ip) => typeof ip === 'string')) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (token !== undefined && token !== null && typeof token !== 'string') return null;
  return { publicKeyHex, name: capName(name), ips: [...(ips as string[])], port, token: token ?? null };
}
