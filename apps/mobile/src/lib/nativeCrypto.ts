// ChaCha20-Poly1305, SHA-256 y base64 nativos (modules/clipsync-native). En Hermes, @noble y el
// Buffer de react-native-tcp-socket dejaban los archivos en ~0,5 MiB/s (§9 de la spec). Si el
// módulo falta o no coincide con @noble, se sigue en JS: más lento, pero los mismos bytes.
import { setCryptoBackend } from '@clipsync/protocol';

import { clipsyncNative } from '../../modules/clipsync-native';

export interface Base64Codec {
  encode(bytes: Uint8Array): string;
  decode(text: string): Uint8Array;
}

let base64: Base64Codec | null = null;
let installed = false;

/** Codec base64 nativo para el socket, o null si no hay (el socket usa entonces bytes). */
export function nativeBase64(): Base64Codec | null {
  installNativeCrypto();
  return base64;
}

/** Registra el backend nativo una sola vez; si no supera la comparación con @noble, se queda @noble. */
export function installNativeCrypto(): void {
  if (installed) return;
  installed = true;
  const native = clipsyncNative;
  if (!native) return;
  try {
    setCryptoBackend({
      seal: (key, nonce, ad, plaintext) => native.chachaSeal(key, nonce, ad, plaintext),
      open: (key, nonce, ad, ciphertext) => native.chachaOpen(key, nonce, ad, ciphertext),
      sha256: () => new native.Sha256Hasher(),
    });
    console.log('[clipsync] cifrado y SHA-256 nativos');
  } catch (e) {
    console.warn(`[clipsync] cifrado nativo descartado, se usa @noble: ${String(e)}`);
  }
  try {
    const probe = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = native.base64Encode(probe);
    const back = native.base64Decode(text);
    if (text === 'AAEC+vv8/f7/' && back.length === probe.length && back.every((b, i) => b === probe[i])) {
      base64 = { encode: (bytes) => native.base64Encode(bytes), decode: (t) => native.base64Decode(t) };
    } else {
      console.warn('[clipsync] base64 nativo descartado: no coincide');
    }
  } catch (e) {
    console.warn(`[clipsync] base64 nativo descartado: ${String(e)}`);
  }
}
