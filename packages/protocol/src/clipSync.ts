import { MAX_CLIP_BYTES } from './constants';
import { sha256Hex } from './hash';
import { ProtocolError, encodeControl } from './messages';
import { toWellFormed } from './text';

export type ClipDecision = 'send' | 'duplicate' | 'empty' | 'too_large';

/**
 * Anti-rebote de un par, en dos fases:
 * - `lastSyncedHash`: último texto enviado o recibido; un texto con ese hash no se envía.
 * - `lastConfirmedHash`: último texto que consta que el otro lado tiene. Un texto recibido
 *   se confirma al momento; uno enviado queda tentativo hasta `confirmSent()`.
 * Los textos se comparan ya bien formados (ver `toWellFormed`).
 */
export class ClipboardSync {
  private hash: string | null;
  private confirmed: string | null;
  /** enviado y aún sin confirmar */
  private tentative: string | null = null;

  constructor(
    lastConfirmedHash: string | null = null,
    private readonly onConfirmedChange?: (hash: string | null) => void,
  ) {
    this.hash = lastConfirmedHash;
    this.confirmed = lastConfirmedHash;
  }

  get lastSyncedHash(): string | null {
    return this.hash;
  }

  get lastConfirmedHash(): string | null {
    return this.confirmed;
  }

  check(text: string): ClipDecision {
    if (text.trim() === '') return 'empty';
    const wf = toWellFormed(text);
    if (new TextEncoder().encode(wf).length > MAX_CLIP_BYTES) return 'too_large';
    return sha256Hex(wf) === this.hash ? 'duplicate' : 'send';
  }

  /** Texto recibido (o dado por tratado): queda confirmado al momento. */
  markSynced(text: string): void {
    const h = sha256Hex(toWellFormed(text));
    this.hash = h;
    this.tentative = null;
    this.setConfirmed(h);
  }

  /** Texto enviado: evita el rebote, pero no se confirma hasta `confirmSent()`. */
  markSent(text: string): void {
    const h = sha256Hex(toWellFormed(text));
    this.hash = h;
    this.tentative = h;
  }

  /** El otro lado procesó lo último enviado. Si después se recibió otro texto, no hace nada. */
  confirmSent(): void {
    const h = this.tentative;
    this.tentative = null;
    if (h !== null) this.setConfirmed(h);
  }

  private setConfirmed(h: string): void {
    if (this.confirmed === h) return;
    this.confirmed = h;
    this.onConfirmedChange?.(h);
  }
}

/**
 * Decide si un texto se envía y, si es así, devuelve sus tramas. Si su JSON no cabe en un
 * mensaje de control es 'too_large'. El texto debe estar ya bien formado.
 */
export function prepareClip(sync: ClipboardSync, text: string, id: string): { decision: ClipDecision; frames?: Uint8Array[] } {
  const decision = sync.check(text);
  if (decision !== 'send') return { decision };
  try {
    return { decision, frames: encodeControl({ kind: 'clip', id, text, hash: sha256Hex(text) }) };
  } catch (e) {
    if (e instanceof ProtocolError) return { decision: 'too_large' }; // p. ej. 1 MiB de comillas
    throw e;
  }
}

/** La misma decisión que toma la Session antes de enviar un clip (sin quedarse con las tramas). */
export function decideClip(sync: ClipboardSync, text: string): ClipDecision {
  return prepareClip(sync, toWellFormed(text), '0'.repeat(32)).decision;
}
