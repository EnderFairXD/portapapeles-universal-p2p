import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  FILE_CHUNK_BYTES,
  MAX_CONTROL_BYTES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  MessageDecoder,
  ProtocolError,
  createSha256,
  encodeControl,
  encodeFileData,
  sha256Hex,
  type ControlMessage,
  type DecodedMessage,
} from '../src/index';

type Expected = ControlMessage | { data: { transferId: string; bytesHex: string } } | { error: true };
interface Vector {
  name: string;
  framesHex: string[];
  expect: Expected;
}

const vectors: Vector[] = JSON.parse(
  readFileSync(new URL('../test-vectors/messages.json', import.meta.url), 'utf8'),
);

// Mismo formato que `expect` en los vectores: el control tal cual, o { data: { transferId, bytesHex } }.
function normalize(m: DecodedMessage | null | undefined) {
  if (!m) return m;
  if (m.type === 'control') return m.msg;
  return { data: { transferId: m.transferId, bytesHex: bytesToHex(m.bytes) } };
}

const TID = '00112233445566778899aabbccddeeff';
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function decodeAll(frames: Uint8Array[]): DecodedMessage[] {
  const d = new MessageDecoder();
  return frames.map((f) => d.push(f)).filter((m): m is DecodedMessage => m !== null);
}

describe('vectores compartidos', () => {
  test.each(vectors)('vector $name', ({ framesHex, expect: exp }) => {
    const d = new MessageDecoder();
    const run = () => framesHex.map(hexToBytes).map((f) => d.push(f));
    if ('kind' in exp || 'data' in exp) {
      const results = run();
      expect(results.slice(0, -1).every((r) => r === null)).toBe(true); // fragmentos pendientes
      expect(normalize(results.at(-1))).toEqual(exp);
    } else {
      expect(run).toThrow(ProtocolError);
    }
  });

  test('cubre cada kind y los casos de error exigidos', () => {
    const kinds = new Set<string>(vectors.flatMap((v) => ('kind' in v.expect ? [v.expect.kind] : [])));
    for (const k of ['hello', 'clip', 'file_start', 'file_ack', 'file_end', 'file_result', 'file_cancel', 'ping', 'pong']) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(vectors.some((v) => 'data' in v.expect)).toBe(true);
    expect(vectors.filter((v) => 'error' in v.expect && !('kind' in v.expect)).length).toBeGreaterThanOrEqual(5);
  });
});

describe('encodeControl / MessageDecoder', () => {
  const messages: ControlMessage[] = [
    { kind: 'hello', v: 2, deviceId: 'd1', deviceName: 'Pixel', willSendClip: false },
    { kind: 'hello', v: 2, deviceId: 'd1', deviceName: 'Pixel' },
    { kind: 'clip', id: 'a', text: 'hola 😀', hash: HASH },
    { kind: 'file_start', transferId: TID, name: 'a.txt', size: 0, mime: 'text/plain' },
    { kind: 'file_ack', transferId: TID, received: 1048576 },
    { kind: 'file_end', transferId: TID, sha256: HASH },
    { kind: 'file_result', transferId: TID, ok: true },
    { kind: 'file_result', transferId: TID, ok: false, error: 'hash_mismatch' },
    { kind: 'file_cancel', transferId: TID, reason: 'user' },
    { kind: 'ping' },
    { kind: 'pong' },
  ];

  test.each(messages)('ida y vuelta de $kind', (msg) => {
    const frames = encodeControl(msg);
    expect(frames).toHaveLength(1);
    expect(frames[0][0]).toBe(0x01);
    expect(decodeAll(frames)).toEqual([{ type: 'control', msg }]);
  });

  test('un clip de 1 MiB de emojis se fragmenta en tramas ≤ 65535 y se reensambla igual', () => {
    const text = '😀'.repeat(262144); // 1 MiB en UTF-8
    const frames = encodeControl({ kind: 'clip', id: 'a', text, hash: sha256Hex(text) });
    expect(frames.length).toBeGreaterThan(16);
    expect(frames.every((f) => f.length <= MAX_FRAME_BYTES)).toBe(true);
    expect(frames.slice(0, -1).every((f) => f[0] === 0x03) && frames.at(-1)![0] === 0x01).toBe(true);
    const out = decodeAll(frames);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.type === 'control' && m.msg.kind === 'clip' && m.msg.text === text).toBe(true);
  });

  test('un control de exactamente 65519 bytes de payload va en una trama y uno más se trocea', () => {
    // payload = byte de tipo + JSON: el JSON cabe hasta MAX_PAYLOAD_BYTES - 1
    const overhead = new TextEncoder().encode(JSON.stringify({ kind: 'clip', id: 'a', text: '', hash: HASH })).length;
    const exact = encodeControl({ kind: 'clip', id: 'a', text: 'x'.repeat(MAX_PAYLOAD_BYTES - 1 - overhead), hash: HASH });
    expect(exact).toHaveLength(1);
    expect(exact[0].length).toBe(MAX_PAYLOAD_BYTES);
    const over = encodeControl({ kind: 'clip', id: 'a', text: 'x'.repeat(MAX_PAYLOAD_BYTES - overhead), hash: HASH });
    expect(over.map((f) => f[0])).toEqual([0x03, 0x01]);
    expect(over.map((f) => f.length)).toEqual([MAX_PAYLOAD_BYTES, 2]);
  });

  test('ningún payload de encodeControl pasa de MAX_PAYLOAD_BYTES (clip de 1 MiB de emojis)', () => {
    const text = '😀'.repeat(262144);
    const frames = encodeControl({ kind: 'clip', id: 'a', text, hash: sha256Hex(text) });
    expect(frames.every((f) => f.length <= MAX_PAYLOAD_BYTES)).toBe(true);
    expect(frames.some((f) => f.length === MAX_PAYLOAD_BYTES)).toBe(true);
  });

  test('reensamblado de control > 2 MiB lanza ProtocolError', () => {
    const d = new MessageDecoder();
    const frame = new Uint8Array(65535).fill(0x61);
    frame[0] = 0x03; // 65534 bytes de contenido
    let n = 0;
    expect(() => {
      for (; n < 40; n++) d.push(frame);
    }).toThrow(ProtocolError);
    expect(n).toBe(Math.floor(MAX_CONTROL_BYTES / 65534)); // salta en la trama 33 (índice 32)
  });

  test('tras un error el decoder queda limpio para el siguiente mensaje', () => {
    const d = new MessageDecoder();
    d.push(Uint8Array.of(0x03, 0x7b));
    expect(() => d.push(Uint8Array.of(0x07))).toThrow(ProtocolError);
    expect(normalize(d.push(encodeControl({ kind: 'ping' })[0]))).toEqual({ kind: 'ping' });
  });

  test('encodeControl rechaza mensajes con forma inválida', () => {
    expect(() => encodeControl({ kind: 'file_ack', transferId: 'corto', received: 1 })).toThrow(ProtocolError);
    expect(() => encodeControl({ kind: 'hello', v: 1 as 2, deviceId: 'a', deviceName: 'b' })).toThrow(ProtocolError);
  });

  test('encodeControl rechaza un mensaje que supera el máximo reensamblado', () => {
    const text = 'x'.repeat(MAX_CONTROL_BYTES);
    expect(() => encodeControl({ kind: 'clip', id: 'a', text, hash: HASH })).toThrow(ProtocolError);
  });
});

describe('datos de archivo', () => {
  test('encodeFileData / MessageDecoder ida y vuelta', () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const frame = encodeFileData(TID, bytes);
    expect(frame.length).toBe(1 + 16 + 3);
    expect(frame[0]).toBe(0x02);
    expect(bytesToHex(frame.slice(1, 17))).toBe(TID);
    expect(decodeAll([frame])).toEqual([{ type: 'data', transferId: TID, bytes }]);
  });

  test('encodeFileData acepta 49152 bytes y rechaza 49153', () => {
    expect(encodeFileData(TID, new Uint8Array(FILE_CHUNK_BYTES)).length).toBe(1 + 16 + FILE_CHUNK_BYTES);
    expect(() => encodeFileData(TID, new Uint8Array(FILE_CHUNK_BYTES + 1))).toThrow(RangeError);
  });

  test('encodeFileData rechaza un transferId inválido', () => {
    expect(() => encodeFileData('xyz', new Uint8Array(1))).toThrow(ProtocolError);
  });

  test('el decoder rechaza datos de más de 49152 bytes', () => {
    const frame = new Uint8Array(1 + 16 + FILE_CHUNK_BYTES + 1);
    frame[0] = 0x02;
    expect(() => new MessageDecoder().push(frame)).toThrow(ProtocolError);
  });
});

describe('hash', () => {
  test('sha256Hex de "abc"', () => {
    expect(sha256Hex('abc')).toBe(HASH);
  });

  test('sha256Hex de bytes y de texto UTF-8 coinciden', () => {
    expect(sha256Hex(new TextEncoder().encode('añá 😀'))).toBe(sha256Hex('añá 😀'));
  });

  test('createSha256 acumula por partes igual que de una vez', () => {
    const h = createSha256();
    h.update(Uint8Array.of(0x61));
    h.update(Uint8Array.of(0x62, 0x63));
    expect(h.digestHex()).toBe(HASH);
  });
});
