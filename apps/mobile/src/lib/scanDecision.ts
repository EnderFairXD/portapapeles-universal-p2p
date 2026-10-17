// Qué hacer con una lectura del escáner QR (puro, sin React Native).
import { parsePairingUri, type PairingInfo } from '@clipsync/protocol';

export type ScanDecision =
  | { kind: 'invalid' }
  /** Ya hay otro PC emparejado: hay que confirmar antes de sustituirlo. */
  | { kind: 'confirm'; info: PairingInfo; current: string }
  | { kind: 'pair'; info: PairingInfo };

/** `currentPcName`: nombre del PC ya emparejado, o null si no hay ninguno. */
export function decideScan(text: string, currentPcName: string | null): ScanDecision {
  const info = parsePairingUri(text);
  if (!info) return { kind: 'invalid' };
  if (currentPcName !== null) return { kind: 'confirm', info, current: currentPcName };
  return { kind: 'pair', info };
}
