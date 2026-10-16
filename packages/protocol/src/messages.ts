import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { FILE_CHUNK_BYTES, MAX_CONTROL_BYTES, MAX_FRAME_BYTES, PROTOCOL_VERSION } from './constants';

export type HelloMsg = { kind: 'hello'; v: 2; deviceId: string; deviceName: string; willSendClip?: boolean };
export type ClipMsg = { kind: 'clip'; id: string; text: string; hash: string };
export type FileStartMsg = { kind: 'file_start'; transferId: string; name: string; size: number; mime: string };
export type FileAckMsg = { kind: 'file_ack'; transferId: string; received: number };
export type FileEndMsg = { kind: 'file_end'; transferId: string; sha256: string };
export type FileResultMsg = { kind: 'file_result'; transferId: string; ok: boolean; error?: string };
export type FileCancelMsg = { kind: 'file_cancel'; transferId: string; reason: string };
export type ControlMessage =
  | HelloMsg
  | ClipMsg
  | FileStartMsg
  | FileAckMsg
  | FileEndMsg
  | FileResultMsg
  | FileCancelMsg
  | { kind: 'ping' }
  | { kind: 'pong' };

export type DecodedMessage =
  | { type: 'control'; msg: ControlMessage }
  | { type: 'data'; transferId: string; bytes: Uint8Array };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Byte de tipo de cada trama. */
const TYPE_CONTROL_LAST = 0x01;
const TYPE_FILE_DATA = 0x02;
const TYPE_CONTROL_MORE = 0x03;

const TRANSFER_ID_BYTES = 16;
const TRANSFER_ID_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

type Obj = Record<string, unknown>;

function fail(what: string): never {
  throw new ProtocolError(`Mensaje inválido: ${what}`);
}

function str(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') fail(`'${key}' debe ser texto`);
  return v;
}

function uint(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(`'${key}' debe ser un entero no negativo`);
  return v;
}

function transferId(o: Obj): string {
  const v = str(o, 'transferId');
  if (!TRANSFER_ID_RE.test(v)) fail("'transferId' debe ser 32 caracteres hex en minúscula");
  return v;
}

function hash(o: Obj, key: string): string {
  const v = str(o, key);
  if (!HASH_RE.test(v)) fail(`'${key}' debe ser 64 caracteres hex en minúscula`);
  return v;
}

/** Comprueba la forma del mensaje y devuelve una copia limpia, sin campos desconocidos. */
function validateControl(value: unknown): ControlMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('se esperaba un objeto');
  const o = value as Obj;
  switch (o.kind) {
    case 'hello': {
      if (o.v !== PROTOCOL_VERSION) fail(`'v' debe ser ${PROTOCOL_VERSION}`);
      const msg: HelloMsg = { kind: 'hello', v: 2, deviceId: str(o, 'deviceId'), deviceName: str(o, 'deviceName') };
      if (o.willSendClip !== undefined) {
        if (typeof o.willSendClip !== 'boolean') fail("'willSendClip' debe ser booleano");
        msg.willSendClip = o.willSendClip;
      }
      return msg;
    }
    case 'clip':
      return { kind: 'clip', id: str(o, 'id'), text: str(o, 'text'), hash: hash(o, 'hash') };
    case 'file_start':
      return {
        kind: 'file_start',
        transferId: transferId(o),
        name: str(o, 'name'),
        size: uint(o, 'size'),
        mime: str(o, 'mime'),
      };
    case 'file_ack':
      return { kind: 'file_ack', transferId: transferId(o), received: uint(o, 'received') };
    case 'file_end':
      return { kind: 'file_end', transferId: transferId(o), sha256: hash(o, 'sha256') };
    case 'file_result': {
      if (typeof o.ok !== 'boolean') fail("'ok' debe ser booleano");
      const msg: FileResultMsg = { kind: 'file_result', transferId: transferId(o), ok: o.ok };
      if (o.error !== undefined) msg.error = str(o, 'error');
      return msg;
    }
    case 'file_cancel':
      return { kind: 'file_cancel', transferId: transferId(o), reason: str(o, 'reason') };
    case 'ping':
      return { kind: 'ping' };
    case 'pong':
      return { kind: 'pong' };
    default:
      return fail(`kind desconocido (${String(o.kind)})`);
  }
}

function withType(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

/**
 * Codifica un mensaje de control en payloads de trama (sin la longitud u16).
 * El JSON se trocea en bytes: tramas 0x03 y una 0x01 final.
 */
export function encodeControl(msg: ControlMessage): Uint8Array[] {
  const json = new TextEncoder().encode(JSON.stringify(validateControl(msg)));
  if (json.length > MAX_CONTROL_BYTES) fail(`supera ${MAX_CONTROL_BYTES} bytes`);

  const maxBody = MAX_FRAME_BYTES - 1;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + maxBody < json.length; off += maxBody) {
    frames.push(withType(TYPE_CONTROL_MORE, json.subarray(off, off + maxBody)));
  }
  const lastOff = frames.length * maxBody;
  frames.push(withType(TYPE_CONTROL_LAST, json.subarray(lastOff)));
  return frames;
}

/** Payload de trama 0x02: transferId (16 bytes) + bytes de archivo (≤ 48 KiB). */
export function encodeFileData(transferId: string, bytes: Uint8Array): Uint8Array {
  if (!TRANSFER_ID_RE.test(transferId)) fail("'transferId' debe ser 32 caracteres hex en minúscula");
  if (bytes.length > FILE_CHUNK_BYTES) {
    throw new RangeError(`Datos de ${bytes.length} bytes: el máximo es ${FILE_CHUNK_BYTES}`);
  }
  const out = new Uint8Array(1 + TRANSFER_ID_BYTES + bytes.length);
  out[0] = TYPE_FILE_DATA;
  out.set(hexToBytes(transferId), 1);
  out.set(bytes, 1 + TRANSFER_ID_BYTES);
  return out;
}

/** Decodifica payloads de trama de uno en uno; devuelve null mientras falten fragmentos. */
export class MessageDecoder {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  push(payload: Uint8Array): DecodedMessage | null {
    try {
      return this.decode(payload);
    } catch (e) {
      this.reset(); // tras un error no se arrastran fragmentos a medias
      throw e;
    }
  }

  private reset(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  private decode(payload: Uint8Array): DecodedMessage | null {
    if (payload.length === 0) fail('trama vacía');
    const type = payload[0];
    const body = payload.subarray(1);

    switch (type) {
      case TYPE_FILE_DATA: {
        if (this.pending.length > 0) fail('datos de archivo en mitad de un mensaje fragmentado');
        if (body.length < TRANSFER_ID_BYTES) fail('datos de archivo sin transferId completo');
        const bytes = body.slice(TRANSFER_ID_BYTES);
        if (bytes.length > FILE_CHUNK_BYTES) fail(`datos de archivo de más de ${FILE_CHUNK_BYTES} bytes`);
        return { type: 'data', transferId: bytesToHex(body.subarray(0, TRANSFER_ID_BYTES)), bytes };
      }
      case TYPE_CONTROL_MORE:
      case TYPE_CONTROL_LAST: {
        // un 0x03 sin contenido no hace avanzar el mensaje: el emisor nunca lo genera
        if (type === TYPE_CONTROL_MORE && body.length === 0) fail('fragmento de control vacío');
        if (this.pendingBytes + body.length > MAX_CONTROL_BYTES) {
          fail(`mensaje de control de más de ${MAX_CONTROL_BYTES} bytes`);
        }
        this.pending.push(body);
        this.pendingBytes += body.length;
        if (type === TYPE_CONTROL_MORE) return null;

        const json = new Uint8Array(this.pendingBytes);
        let off = 0;
        for (const part of this.pending) {
          json.set(part, off);
          off += part.length;
        }
        this.reset();
        return { type: 'control', msg: parseControl(json) };
      }
      default:
        return fail(`tipo de trama desconocido (0x${type.toString(16).padStart(2, '0')})`);
    }
  }
}

function parseControl(json: Uint8Array): ControlMessage {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return fail('JSON o UTF-8 inválido');
  }
  return validateControl(value);
}
