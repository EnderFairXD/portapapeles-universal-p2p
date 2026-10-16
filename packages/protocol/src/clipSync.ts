import { MAX_CLIP_BYTES } from './constants';
import { sha256Hex } from './hash';

export type ClipDecision = 'send' | 'duplicate' | 'empty' | 'too_large';

/** Anti-rebote: recuerda el hash del último texto enviado o recibido por un par. */
export class ClipboardSync {
  private hash: string | null;

  constructor(lastSyncedHash: string | null = null) {
    this.hash = lastSyncedHash;
  }

  get lastSyncedHash(): string | null {
    return this.hash;
  }

  check(text: string): ClipDecision {
    if (text.trim() === '') return 'empty';
    if (new TextEncoder().encode(text).length > MAX_CLIP_BYTES) return 'too_large';
    return sha256Hex(text) === this.hash ? 'duplicate' : 'send';
  }

  /** Llamar tras enviar un texto o tras recibirlo y escribirlo en el portapapeles. */
  markSynced(text: string): void {
    this.hash = sha256Hex(text);
  }
}
