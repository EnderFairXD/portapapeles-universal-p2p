// Anti-rebote del móvil a lo largo de las sesiones (R29), puro para poder probarlo.
import { ClipboardSync } from '@clipsync/protocol';

/** Dónde se guarda el último hash confirmado (settings.json en la app). */
export interface HashStore {
  load(): string | null;
  save(hash: string | null): void;
}

/**
 * Guarda el ClipboardSync de la sesión actual y persiste su hash confirmado en cada cambio.
 * Tras cerrar cualquier sesión se parte del último hash confirmado: lo enviado sin confirmar
 * se olvida (se volverá a anunciar) y nunca se vuelve a null.
 */
export class SyncKeeper {
  private sync: ClipboardSync;

  constructor(private readonly store: HashStore) {
    let initial: string | null = null;
    try {
      initial = store.load();
    } catch {
      // sin ajustes legibles: como la primera vez
    }
    this.sync = this.make(initial);
  }

  get current(): ClipboardSync {
    return this.sync;
  }

  /** Llamar tras cerrarse una sesión, por el motivo que sea. */
  renew(): ClipboardSync {
    this.sync = this.make(this.sync.lastConfirmedHash);
    return this.sync;
  }

  private make(hash: string | null): ClipboardSync {
    return new ClipboardSync(hash, (h) => {
      try {
        this.store.save(h);
      } catch {
        // sin persistir vale para esta ejecución
      }
    });
  }
}
