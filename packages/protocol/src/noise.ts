// Noise_IK_25519_ChaChaPoly_SHA256 (https://noiseprotocol.org/noise.html, revisión 34) sobre @noble.
// El móvil es el iniciador y el PC el respondedor. Se sigue el §5 de la especificación paso a
// paso (SymmetricState, CipherState, HandshakeState) y se valida byte a byte con los vectores
// de test-vectors/noise-ik.json, generados con `snow` en el escritorio.
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes as defaultRandomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, NOISE_TAG_BYTES } from './constants';
import { ProtocolError } from './messages';

export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
/** Prólogo: ata el handshake a esta versión del protocolo (decisión D1). */
export const NOISE_PROLOGUE: Uint8Array = utf8ToBytes('clipsync/2');

const KEY_BYTES = 32;
const HASH_BYTES = 32;
const EMPTY = new Uint8Array(0);

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Fuente de bytes aleatorios. El móvil pasa la de expo-crypto; por defecto, la de @noble. */
export type RandomBytes = (n: number) => Uint8Array;

export class NoiseError extends ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = 'NoiseError';
  }
}

/** x25519 aplica por dentro el recorte (clamp) del escalar de RFC 7748, así que vale una clave privada cruda. */
export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  if (privateKey.length !== KEY_BYTES) {
    throw new RangeError(`La clave privada debe tener ${KEY_BYTES} bytes`);
  }
  const priv = privateKey.slice();
  return { privateKey: priv, publicKey: x25519.getPublicKey(priv) };
}

export function generateKeyPair(randomBytes: RandomBytes = defaultRandomBytes): KeyPair {
  return keyPairFromPrivate(randomBytes(KEY_BYTES));
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    // noble rechaza los puntos de orden bajo (resultado todo ceros).
    return x25519.getSharedSecret(privateKey, publicKey);
  } catch {
    throw new NoiseError('Clave pública inválida en el handshake');
  }
}

/** HKDF de Noise con dos salidas: HKDF(ck, ikm, 2). Equivale a la definición con HMAC-SHA256. */
function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, ikm, chainingKey, EMPTY, 2 * HASH_BYTES);
  return [out.slice(0, HASH_BYTES), out.slice(HASH_BYTES)];
}

/** Nonce de ChaChaPoly en Noise: 4 bytes a cero + contador u64 little-endian. */
function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, n % 0x100000000, true);
  view.setUint32(8, Math.floor(n / 0x100000000), true);
  return nonce;
}

export class CipherState {
  private k: Uint8Array | null;
  private n = 0;

  /** @internal Solo lo crean el handshake (sin clave) y split(). */
  constructor(key: Uint8Array | null = null) {
    this.k = key;
  }

  /** EncryptWithAd del §5.1; sin clave devuelve el texto tal cual. */
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext;
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError('Contador de nonce agotado');
    const out = chacha20poly1305(this.k, nonceBytes(this.n), ad).encrypt(plaintext);
    this.n++;
    return out;
  }

  /** DecryptWithAd del §5.1; el nonce solo avanza si el mensaje autentica. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext;
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new NoiseError('Contador de nonce agotado');
    if (ciphertext.length < NOISE_TAG_BYTES) throw new NoiseError('Mensaje cifrado demasiado corto');
    let out: Uint8Array;
    try {
      out = chacha20poly1305(this.k, nonceBytes(this.n), ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError('El mensaje no autentica');
    }
    this.n++;
    return out;
  }

  /** Cifra una trama de transporte (AD vacío). */
  encrypt(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_PAYLOAD_BYTES) {
      throw new RangeError(`El texto en claro supera ${MAX_PAYLOAD_BYTES} bytes`);
    }
    return this.encryptWithAd(EMPTY, plaintext);
  }

  /** Descifra una trama de transporte (AD vacío). */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.decryptWithAd(EMPTY, ciphertext);
  }
}

export interface HandshakeOptions {
  /** Clave estática propia. */
  s: KeyPair;
  prologue?: Uint8Array;
  randomBytes?: RandomBytes;
  /** Solo para pruebas con vectores: sustituye a la clave efímera aleatoria. */
  fixedEphemeral?: KeyPair;
}

// Mensaje 1 (iniciador → respondedor): e, es, s, ss. Mensaje 2 (respondedor → iniciador): e, ee, se.
const MSG1_MIN_BYTES = KEY_BYTES + (KEY_BYTES + NOISE_TAG_BYTES) + NOISE_TAG_BYTES;
const MSG2_MIN_BYTES = KEY_BYTES + NOISE_TAG_BYTES;

export class NoiseIK {
  private cs = new CipherState();
  private ck: Uint8Array;
  private h: Uint8Array;
  private readonly s: KeyPair;
  private e: KeyPair | null = null;
  private rs: Uint8Array | null;
  private re: Uint8Array | null = null;
  private step = 0; // 0 y 1 son los dos mensajes del handshake; 2 = terminado
  private failed = false;
  private splitDone = false;

  private constructor(
    private readonly initiator: boolean,
    o: HandshakeOptions,
    rs: Uint8Array | null,
    private readonly randomBytes: RandomBytes,
    private readonly fixedEphemeral: KeyPair | undefined,
  ) {
    this.s = o.s;
    this.rs = rs;
    // Initialize del §5.3: h = nombre del protocolo (cabe en 32 bytes, se rellena con ceros).
    const name = utf8ToBytes(NOISE_PROTOCOL_NAME);
    this.h = name.length <= HASH_BYTES ? concatBytes(name, new Uint8Array(HASH_BYTES - name.length)) : sha256(name);
    this.ck = this.h;
    this.mixHash(o.prologue ?? NOISE_PROLOGUE);
    // Premensaje «<- s»: la estática del respondedor la conocen los dos extremos.
    this.mixHash(initiator ? rs! : o.s.publicKey);
  }

  static initiator(o: HandshakeOptions & { rs: Uint8Array }): NoiseIK {
    if (o.rs.length !== KEY_BYTES) throw new RangeError(`La clave pública remota debe tener ${KEY_BYTES} bytes`);
    return new NoiseIK(true, o, o.rs.slice(), o.randomBytes ?? defaultRandomBytes, o.fixedEphemeral);
  }

  static responder(o: HandshakeOptions): NoiseIK {
    return new NoiseIK(false, o, null, o.randomBytes ?? defaultRandomBytes, o.fixedEphemeral);
  }

  /** Estática remota: la del iniciador solo se conoce tras leer el mensaje 1. */
  get remoteStatic(): Uint8Array | null {
    return this.rs === null ? null : this.rs.slice();
  }

  get handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  get isFinished(): boolean {
    return this.step === 2 && !this.failed;
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    this.checkTurn(true);
    const parts: Uint8Array[] = [];
    const e = this.fixedEphemeral ?? generateKeyPair(this.randomBytes);
    this.e = e;
    parts.push(e.publicKey);
    this.mixHash(e.publicKey);
    if (this.initiator) {
      this.mixKey(dh(e.privateKey, this.rs!)); // es
      parts.push(this.encryptAndHash(this.s.publicKey)); // s
      this.mixKey(dh(this.s.privateKey, this.rs!)); // ss
    } else {
      this.mixKey(dh(e.privateKey, this.re!)); // ee
      this.mixKey(dh(e.privateKey, this.rs!)); // se
    }
    parts.push(this.encryptAndHash(payload));
    const message = concatBytes(...parts);
    if (message.length > MAX_FRAME_BYTES) {
      throw new RangeError(`El mensaje de handshake supera ${MAX_FRAME_BYTES} bytes`);
    }
    this.step++;
    return message;
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.checkTurn(false);
    try {
      const payload = this.initiator ? this.readMessage2(message) : this.readMessage1(message);
      this.step++;
      return payload;
    } catch (err) {
      // El estado ya se ha mezclado a medias: el handshake no se puede reanudar.
      this.failed = true;
      throw err;
    }
  }

  /** Cierra el handshake y entrega los dos sentidos del transporte (una sola vez). */
  split(): { send: CipherState; recv: CipherState } {
    if (!this.isFinished) throw new Error('El handshake no ha terminado');
    if (this.splitDone) throw new Error('split() ya se ha llamado');
    this.splitDone = true;
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    this.ck.fill(0);
    const c1 = new CipherState(k1);
    const c2 = new CipherState(k2);
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }

  private readMessage1(message: Uint8Array): Uint8Array {
    if (message.length < MSG1_MIN_BYTES) throw new NoiseError('Mensaje 1 demasiado corto');
    this.re = message.slice(0, KEY_BYTES); // e
    this.mixHash(this.re);
    this.mixKey(dh(this.s.privateKey, this.re)); // es
    const sEnc = message.subarray(KEY_BYTES, KEY_BYTES + KEY_BYTES + NOISE_TAG_BYTES);
    this.rs = this.decryptAndHash(sEnc); // s
    this.mixKey(dh(this.s.privateKey, this.rs)); // ss
    return this.decryptAndHash(message.subarray(KEY_BYTES + KEY_BYTES + NOISE_TAG_BYTES));
  }

  private readMessage2(message: Uint8Array): Uint8Array {
    if (message.length < MSG2_MIN_BYTES) throw new NoiseError('Mensaje 2 demasiado corto');
    this.re = message.slice(0, KEY_BYTES); // e
    this.mixHash(this.re);
    this.mixKey(dh(this.e!.privateKey, this.re)); // ee
    this.mixKey(dh(this.s.privateKey, this.re)); // se
    return this.decryptAndHash(message.subarray(KEY_BYTES));
  }

  /** Comprueba que es el turno de escribir (write) o de leer (!write). */
  private checkTurn(write: boolean): void {
    if (this.failed) throw new NoiseError('El handshake falló y no se puede continuar');
    if (this.step >= 2) throw new Error('El handshake ya ha terminado');
    const myTurn = this.initiator === (this.step === 0);
    if (myTurn !== write) throw new Error(write ? 'No es el turno de escribir' : 'No es el turno de leer');
  }

  // SymmetricState (§5.2).

  private mixHash(data: Uint8Array): void {
    this.h = sha256(concatBytes(this.h, data));
  }

  private mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.cs = new CipherState(tempK); // InitializeKey: n = 0
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }
}
