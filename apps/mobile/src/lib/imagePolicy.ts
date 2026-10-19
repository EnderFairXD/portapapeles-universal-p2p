// Decisiones de imágenes del portapapeles, puras para poder probarlas (sin React Native).
import { ImageSync } from '@clipsync/protocol';

import type { HashStore } from './syncKeeper';

export type { HashStore } from './syncKeeper';

/** Qué ofrece el portapapeles según el listener del sistema. Imagen y texto a la vez: solo la imagen. */
export function clipboardKind(contentTypes: string[]): 'image' | 'text' | 'none' {
  if (contentTypes.includes('image')) return 'image';
  if (contentTypes.includes('plain-text')) return 'text';
  return 'none';
}

/** Extensión de archivo para un mime de imagen admitido (png si no se conoce). */
export function imageExtension(mime: string): 'png' | 'jpg' | 'webp' {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

/** Nombre con que llega al PC una imagen copiada en el móvil: imagen-AAAAMMDD-hhmmss.png (hora local). */
export function outgoingImageName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `imagen-${day}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`;
}

/**
 * Copias del historial que sobran: los nombres empiezan por una marca de tiempo de ancho fijo,
 * así que el orden alfabético es el cronológico. Se conservan las `keep` más recientes.
 */
export function pruneImageNames(names: string[], keep: number): string[] {
  const sorted = [...names].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/** La imagen leída es la que acaba de escribir la propia app (hash de su lectura de vuelta). */
export function isOwnWrite(hash: string, lastWritten: string | null): boolean {
  return lastWritten !== null && hash === lastWritten;
}

/**
 * El ImageSync de la sesión actual, con su hash confirmado persistido (R29): tras cerrar
 * cualquier sesión se parte del último confirmado, y nunca se vuelve a null.
 */
export class ImageKeeper {
  private sync: ImageSync;

  constructor(private readonly store: HashStore) {
    let initial: string | null = null;
    try {
      initial = store.load();
    } catch {
      // sin ajustes legibles: como la primera vez
    }
    this.sync = this.make(initial);
  }

  get current(): ImageSync {
    return this.sync;
  }

  /** Llamar tras cerrarse una sesión, por el motivo que sea. */
  renew(): ImageSync {
    this.sync = this.make(this.sync.lastConfirmedHash);
    return this.sync;
  }

  private make(hash: string | null): ImageSync {
    return new ImageSync(hash, (h) => {
      try {
        this.store.save(h);
      } catch {
        // sin persistir vale para esta ejecución
      }
    });
  }
}

export type ImageOffer = { send: true; cancel: null } | { send: false; cancel: string | null };

/**
 * R7: como mucho una imagen del portapapeles en cola y otra en vuelo. Una nueva sustituye a la
 * que espera en cola; la que está en vuelo termina. `markSent` siempre lleva el hash de la que
 * de verdad está en cola o en curso, y el fin de una imagen solo confirma o revierte si sigue
 * siendo la última marcada (si no, la sustituyó otra o llegó una del PC).
 */
export class ImageOutbox {
  private readonly slots = new Map<string, { hash: string; active: boolean }>();

  constructor(private readonly sync: () => ImageSync) {}

  /**
   * Qué hacer con una imagen local. `send: true`: el llamante quita la de la cola
   * (`dropQueued`), la envía y llama a `sent`. Si no, `cancel` es la de la cola que sobra
   * (ya olvidada aquí: su 'cancelled' no revierte nada).
   */
  offer(hash: string): ImageOffer {
    const sync = this.sync();
    if (this.queued()?.hash === hash) {
      // ya espera en cola; si después se marcó otra, vuelve a ser la última
      if (!sync.isDuplicate(hash)) sync.markSent(hash);
      return { send: false, cancel: null };
    }
    const dup = sync.isDuplicate(hash);
    if (dup || this.inFlight()?.hash === hash) {
      // el PC ya la tiene o la está recibiendo: lo que espera en cola sobra
      const dropped = this.dropQueued();
      if (!dup) sync.markSent(hash);
      return { send: false, cancel: dropped?.id ?? null };
    }
    return { send: true, cancel: null };
  }

  /** Quita (sin revertir) la que espera en cola; el llamante la cancela en la sesión. */
  dropQueued(): { id: string; hash: string } | null {
    const q = this.queued();
    if (!q) return null;
    this.slots.delete(q.id);
    return q;
  }

  /** Encolada en la sesión (`active` si ya salió su file_start). */
  sent(id: string, hash: string, active: boolean): void {
    this.slots.set(id, { hash, active });
    this.sync().markSent(hash);
  }

  /** Su 'active': ya está en vuelo. */
  started(id: string): void {
    const s = this.slots.get(id);
    if (s) s.active = true;
  }

  /** 'done' (ok) o 'failed'/'cancelled'. Las que no se siguen (sustituidas) se ignoran. */
  finished(id: string, ok: boolean): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    this.settle(s.hash, ok);
  }

  /** Confirma o revierte `hash` solo si sigue siendo la última imagen marcada. */
  settle(hash: string, ok: boolean): void {
    const sync = this.sync();
    if (sync.lastSyncedHash !== hash) return;
    if (ok) sync.confirmSent();
    else sync.revertSent();
  }

  /** La sesión se cerró: lo pendiente ya no llegará (el ImageSync se renueva aparte). */
  clear(): void {
    this.slots.clear();
  }

  private queued(): { id: string; hash: string } | null {
    for (const [id, s] of this.slots) if (!s.active) return { id, hash: s.hash };
    return null;
  }

  private inFlight(): { id: string; hash: string } | null {
    for (const [id, s] of this.slots) if (s.active) return { id, hash: s.hash };
    return null;
  }
}

/**
 * Regla de inicio del texto: si el portapapeles tiene una imagen, solo se envía la imagen
 * (spec §3: imagen y texto en la misma copia), así que el texto que la acompaña ni se lee ni se anuncia.
 */
export async function startClipText(hasImage: boolean, readText: () => Promise<string | null>): Promise<string | null> {
  return hasImage ? null : readText();
}

/** En segundo plano Android no deja leer el portapapeles: la lectura de vuelta fallaría. */
export function canWriteClipboard(appState: string): boolean {
  return appState === 'active';
}

/** Una imagen recibida que aún no está en el portapapeles. */
export interface PendingImage {
  /** Archivo que se pondrá en el portapapeles (la copia del historial, o el de la caché). */
  uri: string;
  /** Archivo de la caché que borrar al terminar (si no se pudo mover al historial). */
  temp: string | null;
  /** Date.now() de cuando se difirió. */
  at: number;
}

/** Una imagen diferida más vieja que esto ya no se escribe: el usuario habrá copiado otra cosa. */
export const PENDING_IMAGE_MAX_AGE_MS = 120_000;

export function pendingExpired(image: Pick<PendingImage, 'at'>, now: number): boolean {
  return now - image.at > PENDING_IMAGE_MAX_AGE_MS;
}

/** Vigencia de una escritura sin lectura de vuelta: la primera imagen distinta que se lea es la suya. */
export const UNVERIFIED_WRITE_TTL_MS = 10_000;

/**
 * Tras escribir una imagen sin poder leerla de vuelta (hash del archivo de repuesto), el
 * portapapeles puede devolverla recodificada. Mientras dure el plazo, la primera imagen
 * distinta que se lea se adopta como propia (`take` = true) en vez de enviarla al PC.
 */
export class UnverifiedWrite {
  private armedAt: number | null = null;

  arm(now: number): void {
    this.armedAt = now;
  }

  /** true una sola vez, dentro del plazo; pasado el plazo se desarma sin adoptar. */
  take(now: number): boolean {
    const at = this.armedAt;
    this.armedAt = null;
    return at !== null && now - at <= UNVERIFIED_WRITE_TTL_MS;
  }

  clear(): void {
    this.armedAt = null;
  }
}

/** Lee y, si no da nada, reintenta `retries` veces con `delayMs` de espera entre intentos. */
export async function readWithRetries<T>(
  read: () => Promise<T | null>,
  retries: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | null> {
  let value = await read();
  for (let i = 0; i < retries && value === null; i++) {
    await sleep(delayMs);
    value = await read();
  }
  return value;
}

/** La imagen recibida en segundo plano, a la espera de poder escribirla (solo la más reciente). */
export class PendingImageWrite {
  private item: PendingImage | null = null;

  /** Guarda la imagen; devuelve la que sustituye para que el llamante limpie su temporal. */
  set(image: PendingImage): PendingImage | null {
    const old = this.item;
    this.item = image;
    return old;
  }

  take(): PendingImage | null {
    return this.clear();
  }

  clear(): PendingImage | null {
    const old = this.item;
    this.item = null;
    return old;
  }
}
