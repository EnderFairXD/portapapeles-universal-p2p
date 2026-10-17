import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ProtocolError,
  decodeClientHello,
  decodeServerHello,
  encodeClientHello,
  encodeServerHello,
  type ClientHello,
  type ServerHello,
} from '../src/index';

interface Vector {
  name: string;
  side: 'client' | 'server';
  json: string;
  expect: ClientHello | ServerHello | { error: true };
}

const vectors: Vector[] = JSON.parse(readFileSync(new URL('../test-vectors/hello.json', import.meta.url), 'utf8'));

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';

describe('vectores compartidos', () => {
  test.each(vectors)('vector $name', ({ side, json, expect: exp }) => {
    const decode = side === 'client' ? decodeClientHello : decodeServerHello;
    if ('error' in exp) {
      expect(() => decode(bytes(json))).toThrow(ProtocolError);
    } else {
      expect(decode(bytes(json))).toEqual(exp);
    }
  });

  test('cubre cada campo inválido, los tokens de 21 y 23 y las dos variantes del servidor', () => {
    const names = vectors.map((v) => v.name);
    for (const n of [
      'cliente con v 1',
      'cliente sin deviceId',
      'cliente sin deviceName',
      'cliente con willSendClip texto',
      'cliente con pairingToken de 21 caracteres',
      'cliente con pairingToken de 23 caracteres',
      'servidor aceptado sin pcName',
      'servidor rechazado con reason otra',
      'servidor con accepted texto',
      'cliente con deviceName con sustituto alto suelto',
      'cliente con deviceName con sustituto bajo suelto',
      'cliente con deviceId con sustituto suelto',
      'servidor aceptado con pcName con sustituto suelto',
    ]) {
      expect(names).toContain(n);
    }
    expect(vectors.some((v) => v.side === 'server' && 'accepted' in v.expect && v.expect.accepted)).toBe(true);
    expect(vectors.some((v) => v.side === 'server' && 'accepted' in v.expect && !v.expect.accepted)).toBe(true);
  });
});

describe('ida y vuelta', () => {
  const clients: ClientHello[] = [
    { v: 2, deviceId: 'dev-1', deviceName: 'Pixel 8' },
    { v: 2, deviceId: 'dev-1', deviceName: 'Pixel 8', willSendClip: false },
    { v: 2, deviceId: 'dev-ñ', deviceName: 'Móvil 😀', willSendClip: true, pairingToken: TOKEN },
  ];
  test.each(clients)('ClientHello %#', (h) => {
    expect(decodeClientHello(encodeClientHello(h))).toEqual(h);
  });

  const servers: ServerHello[] = [
    { v: 2, accepted: true, deviceId: 'pc-1', pcName: 'PC de Javier' },
    { v: 2, accepted: false, reason: 'not_paired' },
    { v: 2, accepted: false, reason: 'pairing_expired' },
  ];
  test.each(servers)('ServerHello %#', (h) => {
    expect(decodeServerHello(encodeServerHello(h))).toEqual(h);
  });

  test('un ClientHello sin opcionales no lleva esas claves en el JSON', () => {
    const json = JSON.parse(text(encodeClientHello({ v: 2, deviceId: 'a', deviceName: 'b' })));
    expect(json).toEqual({ v: 2, deviceId: 'a', deviceName: 'b' });
  });

  test('encodeClientHello cambia un sustituto suelto de deviceName por U+FFFD y el resultado se decodifica', () => {
    const out = decodeClientHello(encodeClientHello({ v: 2, deviceId: 'a', deviceName: 'Pixel \ud83d' }));
    expect(out.deviceName).toBe('Pixel \ufffd');
  });

  test('encodeServerHello cambia un sustituto suelto de pcName por U+FFFD y el resultado se decodifica', () => {
    const out = decodeServerHello(encodeServerHello({ v: 2, accepted: true, deviceId: 'pc\ude00', pcName: 'PC \ud83d' }));
    expect(out).toEqual({ v: 2, accepted: true, deviceId: 'pc\ufffd', pcName: 'PC \ufffd' });
  });

  test('un ServerHello rechazado no lleva deviceId ni pcName en el JSON', () => {
    const json = JSON.parse(text(encodeServerHello({ v: 2, accepted: false, reason: 'not_paired' })));
    expect(json).toEqual({ v: 2, accepted: false, reason: 'not_paired' });
  });
});
