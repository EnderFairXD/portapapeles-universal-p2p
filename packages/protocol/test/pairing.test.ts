import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base64UrlToBytes, bytesToBase64Url, fingerprint, parsePairingUri } from '../src/index';

interface Expected {
  publicKeyHex: string;
  token: string;
  name: string;
  ips: string[];
  port: number;
}
interface ParseVector {
  name: string;
  uri: string;
  expect: Expected | { error: true };
}
interface BuildVector {
  publicKeyHex: string;
  token: string;
  pcName: string;
  ips: string[];
  port: number;
  uri: string;
}
interface FingerprintVector {
  publicKeyHex: string;
  fp: string;
}

const vectors: { build: BuildVector[]; parse: ParseVector[]; fingerprints: FingerprintVector[] } = JSON.parse(
  readFileSync(new URL('../test-vectors/pairing.json', import.meta.url), 'utf8'),
);

const VALID_URI = vectors.parse[0].uri;

describe('parsePairingUri con los vectores de Rust', () => {
  for (const v of vectors.parse) {
    test(v.name, () => {
      const info = parsePairingUri(v.uri);
      if ('error' in v.expect) {
        expect(info).toBeNull();
        return;
      }
      expect(info).not.toBeNull();
      expect(bytesToHex(info!.publicKey)).toBe(v.expect.publicKeyHex);
      expect(info!.token).toBe(v.expect.token);
      expect(info!.name).toBe(v.expect.name);
      expect(info!.ips).toEqual(v.expect.ips);
      expect(info!.port).toBe(v.expect.port);
    });
  }

  for (const [i, b] of vectors.build.entries()) {
    test(`acepta la uri de build[${i}] y devuelve sus entradas`, () => {
      const info = parsePairingUri(b.uri);
      expect(info).not.toBeNull();
      expect(bytesToHex(info!.publicKey)).toBe(b.publicKeyHex);
      expect(info!.token).toBe(b.token);
      // El PC trunca el nombre a 64 puntos de código Unicode.
      expect(info!.name).toBe(Array.from(b.pcName).slice(0, 64).join(''));
      expect(info!.ips).toEqual(b.ips);
      expect(info!.port).toBe(b.port);
    });
  }
});

describe('fingerprint', () => {
  for (const f of vectors.fingerprints) {
    test(`huella de ${f.publicKeyHex.slice(0, 8)}…`, () => {
      expect(fingerprint(hexToBytes(f.publicKeyHex))).toBe(f.fp);
    });
  }
});

describe('base64url', () => {
  test('ida y vuelta para 0..40 bytes', () => {
    for (let n = 0; n <= 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n * 11 + 250) & 0xff);
      const s = bytesToBase64Url(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64UrlToBytes(s)).toEqual(b);
    }
  });

  test('usa el alfabeto URL y no deja relleno', () => {
    expect(bytesToBase64Url(Uint8Array.of(0xfb, 0xff, 0xfe))).toBe('-__-');
    expect(bytesToBase64Url(Uint8Array.of(0xff))).toBe('_w');
  });

  test('rechaza caracteres fuera del alfabeto, relleno y longitudes imposibles', () => {
    expect(base64UrlToBytes('ab+d')).toBeNull();
    expect(base64UrlToBytes('ab/d')).toBeNull();
    expect(base64UrlToBytes('ab d')).toBeNull();
    expect(base64UrlToBytes('_w==')).toBeNull();
    expect(base64UrlToBytes('_w=')).toBeNull();
    expect(base64UrlToBytes('a')).toBeNull();
    expect(base64UrlToBytes('abcde')).toBeNull();
  });

  test('cadena vacía → 0 bytes', () => {
    expect(base64UrlToBytes('')).toEqual(new Uint8Array(0));
  });
});

describe('parsePairingUri: casos de borde', () => {
  test('texto que no es una URI (p. ej. "hola") → null', () => {
    expect(parsePairingUri('hola')).toBeNull();
    expect(parsePairingUri('')).toBeNull();
  });

  test('%ZZ en el nombre → null, sin lanzar', () => {
    const uri = VALID_URI.replace(/n=[^&]*/, 'n=%ZZ');
    expect(() => parsePairingUri(uri)).not.toThrow();
    expect(parsePairingUri(uri)).toBeNull();
  });

  test('UTF-8 inválido en el nombre → null', () => {
    expect(parsePairingUri(VALID_URI.replace(/n=[^&]*/, 'n=%C3'))).toBeNull();
  });

  test('nombre vacío tras decodificar → null', () => {
    expect(parsePairingUri(VALID_URI.replace(/n=[^&]*/, 'n='))).toBeNull();
  });

  test('host distinto de pair → null', () => {
    expect(parsePairingUri(VALID_URI.replace('clipsync://pair', 'clipsync://other'))).toBeNull();
    expect(parsePairingUri(VALID_URI.replace('clipsync://pair?', 'clipsync://pair/x?'))).toBeNull();
  });

  test('pk con relleno o con 44 caracteres → null', () => {
    expect(parsePairingUri(VALID_URI.replace(/pk=[^&]*/, (m) => `${m}=`))).toBeNull();
  });

  test('puerto no decimal → null', () => {
    for (const p of ['80a', '+80', '0x50', '', '8.0', '052847']) {
      expect(parsePairingUri(VALID_URI.replace(/port=[^&]*/, `port=${p}`))).toBeNull();
    }
    expect(parsePairingUri(VALID_URI.replace(/port=[^&]*/, 'port=65535'))?.port).toBe(65535);
    expect(parsePairingUri(VALID_URI.replace(/port=[^&]*/, 'port=1'))?.port).toBe(1);
  });

  test('IP mal formada → null', () => {
    for (const ip of ['1.2.3', '1.2.3.4.5', '1.2.3.256', '01.2.3.4', 'a.b.c.d', '1.2.3.4,', ',1.2.3.4']) {
      expect(parsePairingUri(VALID_URI.replace(/ip=[^&]*/, `ip=${ip}`))).toBeNull();
    }
  });

  test('parámetro repetido: gana el último', () => {
    const info = parsePairingUri(`${VALID_URI}&port=1234`);
    expect(info?.port).toBe(1234);
  });

  test('sin parámetros → null', () => {
    expect(parsePairingUri('clipsync://pair')).toBeNull();
    expect(parsePairingUri('clipsync://pair?')).toBeNull();
  });
});
