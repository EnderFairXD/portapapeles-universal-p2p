// Módulo nativo local (solo Android): ChaCha20-Poly1305, SHA-256 y base64. Sin él (tests, iOS)
// devuelve null y se sigue con @noble y el Buffer de react-native-tcp-socket.
import { requireOptionalNativeModule, type SharedObject } from 'expo';

export declare class Sha256Hasher extends SharedObject {
  constructor();
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

export interface ClipsyncNativeModule {
  chachaSeal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  chachaOpen(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  Sha256Hasher: typeof Sha256Hasher;
  base64Encode(data: Uint8Array): string;
  base64Decode(text: string): Uint8Array;
}

export const clipsyncNative = requireOptionalNativeModule<ClipsyncNativeModule>('ClipsyncNative');
