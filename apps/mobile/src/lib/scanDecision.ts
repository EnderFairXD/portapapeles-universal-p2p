// Qué hacer con una lectura del escáner QR (puro, sin React Native).
import { parsePairingUri, type PairingInfo } from '@clipsync/protocol';

import { bytesToHex } from './pairing';

export type ScanDecision =
  | { kind: 'invalid' }
  /** Ya hay otro PC emparejado: hay que confirmar antes de sustituirlo. */
  | { kind: 'confirm'; info: PairingInfo; current: string }
  | { kind: 'pair'; info: PairingInfo };

/**
 * `current`: el PC ya emparejado (nombre y clave pública en hex), o null si no hay ninguno.
 * Escanear el QR del mismo PC (misma clave) empareja directamente: así se vuelve a emparejar
 * tras caducar el QR o si el PC olvidó este móvil.
 */
export function decideScan(text: string, current: { name: string; publicKeyHex: string } | null): ScanDecision {
  const info = parsePairingUri(text);
  if (!info) return { kind: 'invalid' };
  if (current !== null && current.publicKeyHex !== bytesToHex(info.publicKey)) {
    return { kind: 'confirm', info, current: current.name };
  }
  return { kind: 'pair', info };
}
