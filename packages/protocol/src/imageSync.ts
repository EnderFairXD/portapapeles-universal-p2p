/**
 * Anti-rebote de imágenes de un par, con el mismo esquema en dos fases que `ClipboardSync`
 * pero sobre hashes ya calculados (cada lado hashea lo que le devuelve su portapapeles):
 * - `lastSyncedHash`: última imagen enviada o recibida; una imagen con ese hash no se envía.
 * - `lastConfirmedHash`: última imagen que consta que el otro lado tiene. Una imagen recibida
 *   se confirma al momento; una enviada queda tentativa hasta `confirmSent()`.
 */
export class ImageSync {
  private hash: string | null;
  private confirmed: string | null;
  /** enviada y aún sin confirmar */
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

  isDuplicate(hash: string): boolean {
    return hash === this.hash;
  }

  /** Imagen enviada: evita el rebote, pero no se confirma hasta `confirmSent()`. */
  markSent(hash: string): void {
    this.hash = hash;
    this.tentative = hash;
  }

  /** El otro lado procesó lo último enviado. Si después se recibió otra imagen, no hace nada. */
  confirmSent(): void {
    const h = this.tentative;
    this.tentative = null;
    if (h !== null) this.setConfirmed(h);
  }

  /** El envío falló: se vuelve al último confirmado. Si después se recibió otra imagen, no hace nada. */
  revertSent(): void {
    if (this.tentative === null) return;
    this.tentative = null;
    this.hash = this.confirmed;
  }

  /** Imagen recibida y escrita (hash de la lectura de vuelta): queda confirmada al momento. */
  markSynced(hash: string): void {
    this.hash = hash;
    this.tentative = null;
    this.setConfirmed(hash);
  }

  private setConfirmed(h: string): void {
    if (this.confirmed === h) return;
    this.confirmed = h;
    this.onConfirmedChange?.(h);
  }
}
