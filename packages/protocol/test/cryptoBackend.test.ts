import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type CryptoBackend,
  NoiseError,
  NoiseIK,
  createSha256,
  cryptoBackend,
  keyPairFromPrivate,
  nobleBackend,
  setCryptoBackend,
  sha256Hex,
} from '../src/index';

/** Otra implementación real (OpenSSL de Node), como hará el móvil con la de Android. */
const nodeBackend: CryptoBackend = {
  seal(key, nonce, ad, plaintext) {
    const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(ad, { plaintextLength: plaintext.length });
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
  },
  open(key, nonce, ad, ciphertext) {
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    d.setAAD(ad, { plaintextLength: ciphertext.length - 16 });
    return new Uint8Array(Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]));
  },
  sha256() {
    const h = createHash('sha256');
    return {
      update: (b) => void h.update(b),
      digest: () => new Uint8Array(h.digest()),
    };
  },
};

interface VectorCase {
  name: string;
  initStaticHex: string;
  initEphemeralHex: string;
  respStaticHex: string;
  messages: { from: 'initiator' | 'responder'; payloadHex: string; messageHex: string }[];
}
const vectors = JSON.parse(
  readFileSync(new URL('../test-vectors/noise-ik.json', import.meta.url), 'utf8'),
) as { cases: VectorCase[] };

afterEach(() => setCryptoBackend(null));

describe('backend criptográfico', () => {
  test('por defecto es @noble', () => {
    expect(cryptoBackend()).toBe(nobleBackend);
  });

  test.each(vectors.cases)('con otro backend el vector $name de snow da los mismos bytes', (c) => {
    setCryptoBackend(nodeBackend);
    expect(cryptoBackend()).toBe(nodeBackend);
    const init = NoiseIK.initiator({
      s: keyPairFromPrivate(hexToBytes(c.initStaticHex)),
      rs: keyPairFromPrivate(hexToBytes(c.respStaticHex)).publicKey,
      fixedEphemeral: keyPairFromPrivate(hexToBytes(c.initEphemeralHex)),
    });
    const [m1, m2, ...transport] = c.messages;
    expect(bytesToHex(init.writeMessage(hexToBytes(m1.payloadHex)))).toBe(m1.messageHex);
    expect(bytesToHex(init.readMessage(hexToBytes(m2.messageHex)))).toBe(m2.payloadHex);
    const { send, recv } = init.split();
    for (const m of transport) {
      if (m.from === 'initiator') expect(bytesToHex(send.encrypt(hexToBytes(m.payloadHex)))).toBe(m.messageHex);
      else expect(bytesToHex(recv.decrypt(hexToBytes(m.messageHex)))).toBe(m.payloadHex);
    }
  });

  test('CipherState y el hash de archivos usan el backend registrado', () => {
    const calls = { seal: 0, open: 0, sha256: 0 };
    setCryptoBackend({
      seal: (...a) => (calls.seal++, nodeBackend.seal(...a)),
      open: (...a) => (calls.open++, nodeBackend.open(...a)),
      sha256: () => (calls.sha256++, nodeBackend.sha256()),
    });
    Object.assign(calls, { seal: 0, open: 0, sha256: 0 }); // fuera lo que gastó la autoprueba
    const c = vectors.cases[0];
    const init = NoiseIK.initiator({
      s: keyPairFromPrivate(hexToBytes(c.initStaticHex)),
      rs: keyPairFromPrivate(hexToBytes(c.respStaticHex)).publicKey,
      fixedEphemeral: keyPairFromPrivate(hexToBytes(c.initEphemeralHex)),
    });
    init.writeMessage(new Uint8Array(0));
    init.readMessage(hexToBytes(c.messages[1].messageHex));
    expect(calls.seal).toBeGreaterThan(0);
    expect(calls.open).toBeGreaterThan(0);
    const h = createSha256();
    h.update(new TextEncoder().encode('abc'));
    expect(h.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(calls.sha256).toBe(2);
  });

  test('una etiqueta alterada sigue dando NoiseError con otro backend', () => {
    setCryptoBackend(nodeBackend);
    const c = vectors.cases[0];
    const init = NoiseIK.initiator({
      s: keyPairFromPrivate(hexToBytes(c.initStaticHex)),
      rs: keyPairFromPrivate(hexToBytes(c.respStaticHex)).publicKey,
      fixedEphemeral: keyPairFromPrivate(hexToBytes(c.initEphemeralHex)),
    });
    init.writeMessage(new Uint8Array(0));
    const m2 = hexToBytes(c.messages[1].messageHex);
    m2[m2.length - 1] ^= 1;
    expect(() => init.readMessage(m2)).toThrow(NoiseError);
  });

  const broken: [string, CryptoBackend][] = [
    [
      'seal con otros bytes',
      {
        ...nodeBackend,
        seal(k, n, ad, p) {
          const out = nodeBackend.seal(k, n, ad, p);
          out[0] ^= 1;
          return out;
        },
      },
    ],
    ['open que acepta cualquier etiqueta', { ...nodeBackend, open: (_k, _n, _ad, c) => c.slice(0, c.length - 16) }],
    [
      'sha256 que ignora la segunda actualización',
      {
        ...nodeBackend,
        sha256() {
          const h = createHash('sha256');
          let first = true;
          return {
            update: (b) => {
              if (first) h.update(b);
              first = false;
            },
            digest: () => new Uint8Array(h.digest()),
          };
        },
      },
    ],
    [
      'un backend que lanza',
      {
        ...nodeBackend,
        seal: () => {
          throw new Error('sin ChaCha20');
        },
      },
    ],
  ];

  test.each(broken)('se descarta %s y se queda @noble', (_name, backend) => {
    expect(() => setCryptoBackend(backend)).toThrow(/descartado/);
    expect(cryptoBackend()).toBe(nobleBackend);
  });
});
