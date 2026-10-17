// Identidad Noise del móvil: clave privada de 32 bytes en el almacén seguro de Android.
import { keyPairFromPrivate, type KeyPair } from '@clipsync/protocol';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { bytesToHex, hexToBytes } from './pairing';

const IDENTITY_KEY = 'clipsync_identity';
const PRIVATE_HEX = /^[0-9a-f]{64}$/;

let cached: Promise<KeyPair> | null = null;

async function load(): Promise<KeyPair> {
  const stored = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (stored !== null && PRIVATE_HEX.test(stored)) return keyPairFromPrivate(hexToBytes(stored));
  // ausente (o ilegible): una identidad nueva; un fallo al leer sí se propaga para no cambiarla por error
  const privateKey = Crypto.getRandomBytes(32);
  await SecureStore.setItemAsync(IDENTITY_KEY, bytesToHex(privateKey));
  return keyPairFromPrivate(privateKey);
}

/** La identidad de este móvil; se crea la primera vez y queda en caché. */
export function loadIdentity(): Promise<KeyPair> {
  cached ??= load().catch((e) => {
    cached = null; // que el siguiente intento vuelva a probar
    throw e;
  });
  return cached;
}
