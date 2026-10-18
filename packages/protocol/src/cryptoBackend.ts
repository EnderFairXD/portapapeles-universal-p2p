// Quién calcula ChaCha20-Poly1305 y SHA-256. Por defecto @noble (JS puro); el móvil registra uno
// nativo porque en Hermes @noble no llega a 2 MB/s (§9 de la spec). El algoritmo y los bytes en el
// cable son los mismos: solo cambia la implementación, y antes de aceptarla se compara con @noble.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface Sha256Hasher {
  update(bytes: Uint8Array): void;
  digest(): Uint8Array;
}

export interface CryptoBackend {
  /** ChaCha20-Poly1305 de RFC 8439 (nonce de 12 bytes): devuelve texto cifrado ‖ etiqueta de 16 bytes. */
  seal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Inverso de seal; lanza si la etiqueta no autentica. */
  open(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  /** SHA-256 incremental. */
  sha256(): Sha256Hasher;
}

export const nobleBackend: CryptoBackend = {
  seal: (key, nonce, ad, plaintext) => chacha20poly1305(key, nonce, ad).encrypt(plaintext),
  open: (key, nonce, ad, ciphertext) => chacha20poly1305(key, nonce, ad).decrypt(ciphertext),
  sha256: () => sha256.create(),
};

let current: CryptoBackend = nobleBackend;

export function cryptoBackend(): CryptoBackend {
  return current;
}

/**
 * Cambia el backend (null vuelve a @noble). Antes lo compara con @noble: si da otros bytes, acepta
 * una etiqueta mala o falla, lanza y se queda el que había.
 */
export function setCryptoBackend(backend: CryptoBackend | null): void {
  if (backend === null) {
    current = nobleBackend;
    return;
  }
  const problem = selfTest(backend);
  if (problem) throw new Error(`Backend criptográfico descartado: ${problem}`);
  current = backend;
}

function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 167 + seed * 13 + 1) & 0xff;
  return out;
}

const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);

/** Devuelve qué falla, o null si el backend coincide con @noble. */
function selfTest(b: CryptoBackend): string | null {
  try {
    const key = pattern(32, 1);
    // un nonce distinto por caso: hay implementaciones que rechazan repetir clave y nonce al cifrar
    const lengths = [0, 1, 63, 64, 65, 1000, 49169];
    for (let i = 0; i < lengths.length; i++) {
      const nonce = pattern(12, 10 + i);
      const ad = pattern(i * 5, 20 + i);
      const plain = pattern(lengths[i], 30 + i);
      const expected = nobleBackend.seal(key, nonce, ad, plain);
      const sealed = b.seal(key, nonce, ad, plain);
      if (!same(sealed, expected)) return `seal distinto con ${lengths[i]} bytes`;
      if (!same(b.open(key, nonce, ad, expected), plain)) return `open distinto con ${lengths[i]} bytes`;
      const bad = expected.slice();
      bad[bad.length - 1] ^= 1;
      let accepted = true;
      try {
        b.open(key, nonce, ad, bad);
      } catch {
        accepted = false;
      }
      if (accepted) return 'open acepta una etiqueta alterada';
    }
    const data = pattern(100000, 40);
    const h = b.sha256();
    h.update(data.subarray(0, 333));
    h.update(data.subarray(333));
    if (!same(h.digest(), sha256(data))) return 'sha256 distinto';
    if (!same(b.sha256().digest(), sha256(new Uint8Array(0)))) return 'sha256 vacío distinto';
  } catch (e) {
    return `error en la prueba (${e instanceof Error ? e.message : String(e)})`;
  }
  return null;
}
