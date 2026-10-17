import { describe, expect, it } from 'vitest';

import type { PairingInfo } from '@clipsync/protocol';

import { bytesToHex, hexToBytes, pairedPcFromInfo, parsePairedPc } from '../src/lib/pairing';

const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';

function validRaw(): Record<string, unknown> {
  return { publicKeyHex: KEY_HEX, name: 'Mi PC', ips: ['192.168.1.5'], port: 52847, token: TOKEN };
}

describe('hex', () => {
  it('bytes ↔ hex en minúscula', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
    expect(Array.from(hexToBytes('000fff'))).toEqual([0, 15, 255]);
    expect(bytesToHex(hexToBytes(KEY_HEX))).toBe(KEY_HEX);
  });
});

describe('pairedPcFromInfo', () => {
  it('pasa la clave a hex y conserva token, ips y port', () => {
    const info: PairingInfo = {
      publicKey: hexToBytes(KEY_HEX),
      token: TOKEN,
      name: 'Mi PC',
      ips: ['192.168.1.5', '10.0.0.2'],
      port: 52847,
    };
    expect(pairedPcFromInfo(info)).toEqual({
      publicKeyHex: KEY_HEX,
      name: 'Mi PC',
      ips: ['192.168.1.5', '10.0.0.2'],
      port: 52847,
      token: TOKEN,
    });
  });

  it('recorta el nombre a 64 caracteres Unicode', () => {
    const info: PairingInfo = { publicKey: hexToBytes(KEY_HEX), token: TOKEN, name: '😀'.repeat(70), ips: [], port: 1 };
    expect(Array.from(pairedPcFromInfo(info).name)).toHaveLength(64);
  });
});

describe('parsePairedPc', () => {
  it('acepta un valor válido', () => {
    expect(parsePairedPc(validRaw())).toEqual(validRaw());
  });

  it('el token es opcional: ausente o null queda en null', () => {
    const { token: _t, ...sinToken } = validRaw();
    expect(parsePairedPc(sinToken)?.token).toBeNull();
    expect(parsePairedPc({ ...validRaw(), token: null })?.token).toBeNull();
  });

  it('rechaza una clave que no son 64 hex en minúscula', () => {
    expect(parsePairedPc({ ...validRaw(), publicKeyHex: KEY_HEX.slice(1) })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), publicKeyHex: KEY_HEX.toUpperCase() })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), publicKeyHex: 'zz'.repeat(32) })).toBeNull();
  });

  it('rechaza un puerto fuera de rango o no entero', () => {
    expect(parsePairedPc({ ...validRaw(), port: 0 })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), port: 65536 })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), port: 1.5 })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), port: '52847' })).toBeNull();
  });

  it('rechaza nombre, ips o token con tipo incorrecto, y lo que no es un objeto', () => {
    expect(parsePairedPc({ ...validRaw(), name: 5 })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), ips: '192.168.1.5' })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), ips: [1] })).toBeNull();
    expect(parsePairedPc({ ...validRaw(), token: 7 })).toBeNull();
    expect(parsePairedPc(null)).toBeNull();
    expect(parsePairedPc('x')).toBeNull();
  });
});
