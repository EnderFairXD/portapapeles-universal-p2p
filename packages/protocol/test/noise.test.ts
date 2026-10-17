import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import {
  CipherState,
  MAX_PAYLOAD_BYTES,
  NOISE_PROLOGUE,
  NOISE_PROTOCOL_NAME,
  NOISE_TAG_BYTES,
  NoiseError,
  NoiseIK,
  PAIRING_TTL_MS,
  ProtocolError,
  generateKeyPair,
  keyPairFromPrivate,
} from '../src/index';

interface VectorMessage {
  from: 'initiator' | 'responder';
  payloadHex: string;
  messageHex: string;
}
interface VectorCase {
  name: string;
  initStaticHex: string;
  initEphemeralHex: string;
  respStaticHex: string;
  respEphemeralHex: string;
  handshakeHashHex: string;
  messages: VectorMessage[];
}
interface Vectors {
  protocol: string;
  prologueHex: string;
  cases: VectorCase[];
}

// Vectores generados por snow (Rust); el archivo pesa ~267 KB, no se imprime.
const vectors = JSON.parse(
  readFileSync(new URL('../test-vectors/noise-ik.json', import.meta.url), 'utf8'),
) as Vectors;

const hex = hexToBytes;

/** Los dos primeros mensajes son el handshake; el resto, transporte. */
const HANDSHAKE_MESSAGES = 2;

describe('constantes', () => {
  test('coinciden con los vectores y con la decisión D6', () => {
    expect(NOISE_PROTOCOL_NAME).toBe(vectors.protocol);
    expect(bytesToHex(NOISE_PROLOGUE)).toBe(vectors.prologueHex);
    expect(NOISE_TAG_BYTES).toBe(16);
    expect(MAX_PAYLOAD_BYTES).toBe(65535 - 16);
    expect(PAIRING_TTL_MS).toBe(300000);
  });
});

describe('vectores de snow', () => {
  test.each(vectors.cases)('vector $name: el iniciador produce los mismos bytes', (c) => {
    const respStatic = keyPairFromPrivate(hex(c.respStaticHex));
    const init = NoiseIK.initiator({
      s: keyPairFromPrivate(hex(c.initStaticHex)),
      rs: respStatic.publicKey,
      fixedEphemeral: keyPairFromPrivate(hex(c.initEphemeralHex)),
    });
    for (const m of c.messages.slice(0, HANDSHAKE_MESSAGES)) {
      if (m.from === 'initiator') {
        expect(bytesToHex(init.writeMessage(hex(m.payloadHex)))).toBe(m.messageHex);
      } else {
        expect(bytesToHex(init.readMessage(hex(m.messageHex)))).toBe(m.payloadHex);
      }
    }
    expect(init.isFinished).toBe(true);
    expect(bytesToHex(init.handshakeHash)).toBe(c.handshakeHashHex);
    const { send, recv } = init.split();
    for (const m of c.messages.slice(HANDSHAKE_MESSAGES)) {
      if (m.from === 'initiator') {
        expect(bytesToHex(send.encrypt(hex(m.payloadHex)))).toBe(m.messageHex);
      } else {
        expect(bytesToHex(recv.decrypt(hex(m.messageHex)))).toBe(m.payloadHex);
      }
    }
  });

  test.each(vectors.cases)('vector $name: el respondedor produce los mismos bytes', (c) => {
    const initStatic = keyPairFromPrivate(hex(c.initStaticHex));
    const resp = NoiseIK.responder({
      s: keyPairFromPrivate(hex(c.respStaticHex)),
      fixedEphemeral: keyPairFromPrivate(hex(c.respEphemeralHex)),
    });
    expect(resp.remoteStatic).toBeNull();
    for (const m of c.messages.slice(0, HANDSHAKE_MESSAGES)) {
      if (m.from === 'responder') {
        expect(bytesToHex(resp.writeMessage(hex(m.payloadHex)))).toBe(m.messageHex);
      } else {
        expect(bytesToHex(resp.readMessage(hex(m.messageHex)))).toBe(m.payloadHex);
      }
    }
    expect(resp.isFinished).toBe(true);
    expect(bytesToHex(resp.remoteStatic!)).toBe(bytesToHex(initStatic.publicKey));
    expect(bytesToHex(resp.handshakeHash)).toBe(c.handshakeHashHex);
    const { send, recv } = resp.split();
    for (const m of c.messages.slice(HANDSHAKE_MESSAGES)) {
      if (m.from === 'responder') {
        expect(bytesToHex(send.encrypt(hex(m.payloadHex)))).toBe(m.messageHex);
      } else {
        expect(bytesToHex(recv.decrypt(hex(m.messageHex)))).toBe(m.payloadHex);
      }
    }
  });
});

/** Un par de extremos con claves aleatorias; devuelve el handshake a medias o completo. */
function pareja() {
  const sInit = generateKeyPair();
  const sResp = generateKeyPair();
  const init = NoiseIK.initiator({ s: sInit, rs: sResp.publicKey });
  const resp = NoiseIK.responder({ s: sResp });
  return { sInit, sResp, init, resp };
}

function completa() {
  const p = pareja();
  p.resp.readMessage(p.init.writeMessage(new Uint8Array([1, 2, 3])));
  p.init.readMessage(p.resp.writeMessage(new Uint8Array(0)));
  return { ...p, a: p.init.split(), b: p.resp.split() };
}

describe('handshake', () => {
  test('con claves aleatorias los dos extremos se entienden en ambos sentidos', () => {
    const { sInit, a, b, resp } = completa();
    expect(bytesToHex(resp.remoteStatic!)).toBe(bytesToHex(sInit.publicKey));
    const ida = new TextEncoder().encode('hola');
    expect(b.recv.decrypt(a.send.encrypt(ida))).toEqual(ida);
    const vuelta = new TextEncoder().encode('adiós');
    expect(a.recv.decrypt(b.send.encrypt(vuelta))).toEqual(vuelta);
  });

  test('clave de servidor equivocada → readMessage del mensaje 1 lanza NoiseError', () => {
    const init = NoiseIK.initiator({
      s: generateKeyPair(),
      rs: generateKeyPair().publicKey, // no es la del respondedor
    });
    const resp = NoiseIK.responder({ s: generateKeyPair() });
    const m1 = init.writeMessage(new Uint8Array([9]));
    expect(() => resp.readMessage(m1)).toThrow(NoiseError);
  });

  test('prólogo distinto → NoiseError', () => {
    const sResp = generateKeyPair();
    const init = NoiseIK.initiator({
      s: generateKeyPair(),
      rs: sResp.publicKey,
      prologue: new TextEncoder().encode('otro'),
    });
    const resp = NoiseIK.responder({ s: sResp });
    expect(() => resp.readMessage(init.writeMessage(new Uint8Array(0)))).toThrow(NoiseError);
  });

  test('mensaje 1 truncado o con un bit cambiado → NoiseError', () => {
    const { init, resp } = pareja();
    const m1 = init.writeMessage(new Uint8Array([1, 2, 3]));
    expect(() => resp.readMessage(m1.subarray(0, 40))).toThrow(NoiseError);
    const malo = m1.slice();
    malo[malo.length - 1] ^= 1;
    expect(() => resp.readMessage(malo)).toThrow(NoiseError);
  });

  test('NoiseError es un ProtocolError', () => {
    expect(new NoiseError('x')).toBeInstanceOf(ProtocolError);
  });

  test('writeMessage fuera de turno y split antes de terminar lanzan', () => {
    const { init, resp } = pareja();
    expect(() => resp.writeMessage(new Uint8Array(0))).toThrow(); // el respondedor lee primero
    expect(() => init.split()).toThrow();
    expect(() => init.readMessage(new Uint8Array(100))).toThrow(); // el iniciador escribe primero
    init.writeMessage(new Uint8Array(0));
    expect(() => init.writeMessage(new Uint8Array(0))).toThrow(); // ahora le toca leer
    expect(() => init.split()).toThrow();
    expect(() => init.handshakeHash).not.toThrow();
  });

  test('no se puede leer ni escribir tras terminar el handshake', () => {
    const { init } = completa();
    expect(() => init.writeMessage(new Uint8Array(0))).toThrow();
    expect(() => init.readMessage(new Uint8Array(64))).toThrow();
  });

  test('un handshake con fallo no deja continuar al respondedor', () => {
    const { init, resp } = pareja();
    const m1 = init.writeMessage(new Uint8Array(0)).slice();
    m1[m1.length - 1] ^= 1;
    expect(() => resp.readMessage(m1)).toThrow(NoiseError);
    expect(() => resp.writeMessage(new Uint8Array(0))).toThrow();
  });
});

describe('CipherState', () => {
  test('un bit cambiado en transporte → NoiseError y el nonce no avanza', () => {
    const { a, b } = completa();
    const c0 = a.send.encrypt(new Uint8Array([1, 2, 3]));
    const malo = c0.slice();
    malo[0] ^= 1;
    expect(() => b.recv.decrypt(malo)).toThrow(NoiseError);
    // el mismo nonce 0 sigue valiendo para el mensaje bueno
    expect(Array.from(b.recv.decrypt(c0))).toEqual([1, 2, 3]);
    // y el siguiente usa el nonce 1
    expect(Array.from(b.recv.decrypt(a.send.encrypt(new Uint8Array([4]))))).toEqual([4]);
  });

  test('un mensaje repetido o fuera de orden no autentica', () => {
    const { a, b } = completa();
    const c0 = a.send.encrypt(new Uint8Array([1]));
    a.send.encrypt(new Uint8Array([2]));
    const c2 = a.send.encrypt(new Uint8Array([3]));
    expect(() => b.recv.decrypt(c2)).toThrow(NoiseError);
    b.recv.decrypt(c0);
    expect(() => b.recv.decrypt(c0)).toThrow(NoiseError);
  });

  test('un texto cifrado más corto que la etiqueta → NoiseError', () => {
    const { b } = completa();
    expect(() => b.recv.decrypt(new Uint8Array(15))).toThrow(NoiseError);
  });

  test('encrypt de 65519 bytes da 65535; de 65520 lanza RangeError', () => {
    const { a } = completa();
    expect(a.send.encrypt(new Uint8Array(65519)).length).toBe(65535);
    expect(() => a.send.encrypt(new Uint8Array(65520))).toThrow(RangeError);
  });

  test('el nonce es 4 ceros + contador little-endian: el mensaje 257 sigue en orden', () => {
    const { a, b } = completa();
    for (let i = 0; i < 300; i++) {
      const m = new Uint8Array([i & 0xff]);
      expect(Array.from(b.recv.decrypt(a.send.encrypt(m)))).toEqual([i & 0xff]);
    }
  });

  test('es una clase exportada', () => {
    expect(CipherState).toBeTypeOf('function');
  });
});

describe('claves', () => {
  test('keyPairFromPrivate cumple el vector de RFC 7748 §6.1', () => {
    const alice = keyPairFromPrivate(
      hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
    );
    expect(bytesToHex(alice.publicKey)).toBe(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
    const bob = keyPairFromPrivate(
      hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'),
    );
    expect(bytesToHex(bob.publicKey)).toBe(
      'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    );
  });

  test('keyPairFromPrivate lanza RangeError si no son 32 bytes', () => {
    expect(() => keyPairFromPrivate(new Uint8Array(31))).toThrow(RangeError);
    expect(() => keyPairFromPrivate(new Uint8Array(33))).toThrow(RangeError);
  });

  test('generateKeyPair usa el randomBytes recibido', () => {
    const fijo = new Uint8Array(32).fill(7);
    let pedidos = 0;
    const kp = generateKeyPair((n) => {
      pedidos = n;
      return fijo;
    });
    expect(pedidos).toBe(32);
    expect(bytesToHex(kp.publicKey)).toBe(bytesToHex(keyPairFromPrivate(fijo).publicKey));
  });

  test('generateKeyPair sin argumentos da claves distintas', () => {
    expect(bytesToHex(generateKeyPair().privateKey)).not.toBe(bytesToHex(generateKeyPair().privateKey));
  });
});
