import { PROTOCOL_VERSION } from './constants';
import { ProtocolError } from './messages';
import { toWellFormed } from './text';

/** Carga JSON del primer mensaje Noise (móvil → PC). Sustituye al `hello` en claro de la fase 1. */
export interface ClientHello {
  v: 2;
  deviceId: string;
  deviceName: string;
  willSendClip?: boolean;
  pairingToken?: string;
}

export type RejectReason = 'not_paired' | 'pairing_expired';

/** Carga JSON del segundo mensaje Noise (PC → móvil). */
export type ServerHello =
  | { v: 2; accepted: true; deviceId: string; pcName: string }
  | { v: 2; accepted: false; reason: RejectReason };

const REJECT_REASONS: readonly string[] = ['not_paired', 'pairing_expired'];
/** 128 bits en base64url sin relleno. */
const PAIRING_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

type Obj = Record<string, unknown>;

function fail(what: string): never {
  throw new ProtocolError(`Mensaje inválido: ${what}`);
}

function parseObject(bytes: Uint8Array): Obj {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('JSON o UTF-8 inválido');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('se esperaba un objeto');
  return value as Obj;
}

function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`'${key}' debe ser texto`);
  // JSON.parse acepta `\ud800` suelto; serde_json (el PC) no: los dos lados lo rechazan.
  if (toWellFormed(v) !== v) fail(`'${key}' tiene un sustituto UTF-16 suelto`);
  return v;
}

function checkVersion(o: Obj): void {
  if (o.v !== PROTOCOL_VERSION) fail(`'v' debe ser ${PROTOCOL_VERSION}`);
}

export function decodeClientHello(bytes: Uint8Array): ClientHello {
  const o = parseObject(bytes);
  checkVersion(o);
  const hello: ClientHello = { v: 2, deviceId: str(o, 'deviceId'), deviceName: str(o, 'deviceName') };
  if (o.willSendClip !== undefined) {
    if (typeof o.willSendClip !== 'boolean') fail("'willSendClip' debe ser booleano");
    hello.willSendClip = o.willSendClip;
  }
  if (o.pairingToken !== undefined) {
    const token = str(o, 'pairingToken');
    if (!PAIRING_TOKEN_RE.test(token)) fail("'pairingToken' debe ser 22 caracteres base64url");
    hello.pairingToken = token;
  }
  return hello;
}

export function decodeServerHello(bytes: Uint8Array): ServerHello {
  const o = parseObject(bytes);
  checkVersion(o);
  if (typeof o.accepted !== 'boolean') fail("'accepted' debe ser booleano");
  if (o.accepted) {
    return { v: 2, accepted: true, deviceId: str(o, 'deviceId'), pcName: str(o, 'pcName') };
  }
  const reason = str(o, 'reason');
  if (!REJECT_REASONS.includes(reason)) fail(`'reason' desconocido (${reason})`);
  return { v: 2, accepted: false, reason: reason as RejectReason };
}

/** Solo serializa (sin campos de más); la validación está en `decode*`. Los sustitutos sueltos pasan a U+FFFD. */
export function encodeClientHello(h: ClientHello): Uint8Array {
  const out: ClientHello = { v: 2, deviceId: toWellFormed(h.deviceId), deviceName: toWellFormed(h.deviceName) };
  if (h.willSendClip !== undefined) out.willSendClip = h.willSendClip;
  if (h.pairingToken !== undefined) out.pairingToken = h.pairingToken;
  return new TextEncoder().encode(JSON.stringify(out));
}

export function encodeServerHello(h: ServerHello): Uint8Array {
  const out: ServerHello = h.accepted
    ? { v: 2, accepted: true, deviceId: toWellFormed(h.deviceId), pcName: toWellFormed(h.pcName) }
    : { v: 2, accepted: false, reason: h.reason };
  return new TextEncoder().encode(JSON.stringify(out));
}
