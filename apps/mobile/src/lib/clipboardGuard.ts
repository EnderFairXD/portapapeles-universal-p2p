// Guardia del oyente del portapapeles durante las escrituras de la app. Pura, para probarla.

/**
 * Mientras la app escribe una imagen, el oyente calla. Lo que se descarte en ese rato (puede ser
 * una copia del usuario) se anota: al soltar, `exit()` dice si hay que revisar el portapapeles.
 */
export class SuppressGuard {
  private depth = 0;
  private missed = false;

  get active(): boolean {
    return this.depth > 0;
  }

  enter(): void {
    this.depth += 1;
  }

  /** true si al soltar (la última escritura) quedó algún aviso descartado por revisar. */
  exit(): boolean {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth > 0 || !this.missed) return false;
    this.missed = false;
    return true;
  }

  /** Un aviso a punto de entregarse: si hay escritura en curso se descarta y se anota (true). */
  swallow(): boolean {
    if (this.depth === 0) return false;
    this.missed = true;
    return true;
  }
}
