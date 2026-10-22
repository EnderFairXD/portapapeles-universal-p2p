import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PROTOCOL_VERSION } from './constants';

/** Datos que lleva el QR `clipsync://pair?...` que muestra el PC. */
export interface PairingInfo {
  publicKey: Uint8Array;
  token: string;
  name: string;
  ips: string[];
  port: number;
  /** Dirección Bluetooth del adaptador del PC (`AA:BB:CC:DD:EE:FF`); ausente si el PC no tiene Bluetooth. */
  bt?: string;
}

const PAIR_PREFIX = 'clipsync://pair?';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const ALPHABET_INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_INDEX[ALPHABET[i]] = i;

/** Base64url sin relleno. */
export function bytesToBase64Url(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Base64url sin relleno → bytes. `null` si hay caracteres fuera del alfabeto (incluido `=`) o la longitud es imposible. */
export function base64UrlToBytes(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const vals: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const v = ALPHABET_INDEX[s[i]];
    if (v === undefined) return null;
    vals.push(v);
  }
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < vals.length; i += 4) {
    const n = (vals[i] << 18) | ((vals[i + 1] ?? 0) << 12) | ((vals[i + 2] ?? 0) << 6) | (vals[i + 3] ?? 0);
    if (o < out.length) out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Huella corta de la clave pública del PC: 16 hex minúscula (8 primeros bytes del SHA-256). */
export function fingerprint(publicKey: Uint8Array): string {
  return bytesToHex(sha256(publicKey).subarray(0, 8));
}

const IPV4_RE = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;

const BT_ADDRESS_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Lee el texto de un QR de emparejamiento. `null` si no es un QR de ClipSync válido.
 * No usa `URL` ni `URLSearchParams` (Hermes los implementa a medias): separa a mano.
 * Los parámetros desconocidos se ignoran; si uno se repite, gana el último.
 * `bt` es opcional: si no es una dirección `AA:BB:CC:DD:EE:FF` (mayúsculas), se ignora sin invalidar el QR.
 */
export function parsePairingUri(text: string): PairingInfo | null {
  if (!text.startsWith(PAIR_PREFIX)) return null;

  const params: Record<string, string> = {};
  for (const part of text.slice(PAIR_PREFIX.length).split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    params[part.slice(0, eq)] = part.slice(eq + 1);
  }

  if (params.v !== String(PROTOCOL_VERSION)) return null;

  const pk = params.pk;
  if (pk === undefined || pk.length !== 43) return null;
  const publicKey = base64UrlToBytes(pk);
  if (publicKey === null || publicKey.length !== 32) return null;

  const token = params.t;
  if (token === undefined || !/^[A-Za-z0-9_-]{22}$/.test(token)) return null;

  if (params.n === undefined) return null;
  let name: string;
  try {
    name = decodeURIComponent(params.n);
  } catch {
    return null;
  }
  if (name.length === 0) return null;

  if (params.ip === undefined) return null;
  const ips = params.ip === '' ? [] : params.ip.split(',');
  if (!ips.every(isIpv4)) return null;

  if (params.port === undefined || !/^[1-9][0-9]{0,4}$/.test(params.port)) return null;
  const port = Number(params.port);
  if (port > 65535) return null;

  const info: PairingInfo = { publicKey, token, name, ips, port };
  if (params.bt !== undefined && BT_ADDRESS_RE.test(params.bt)) info.bt = params.bt;
  return info;
}
