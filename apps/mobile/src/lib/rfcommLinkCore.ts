// Link de la Session sobre un socket RFCOMM nativo (puro: el puente nativo se inyecta).
// Mismo contrato que tcpLink.ts: `write` lanza tras el cierre y los bytes recibidos se entregan
// antes de avisar del cierre. El módulo nativo emite los eventos en orden desde un solo hilo.
import type { Link } from '@clipsync/protocol';

export interface RfcommHandlers {
  data(base64: string): void;
  closed(error?: string): void;
}

export interface RfcommBridge {
  /** Registra los manejadores del enlace `id`; devuelve cómo quitarlos. */
  register(id: number, handlers: RfcommHandlers): () => void;
  encode(bytes: Uint8Array): string;
  decode(base64: string): Uint8Array;
  /** Encola la escritura (no bloquea); lanza si el módulo nativo no puede recibirla. */
  write(id: number, base64: string): void;
  /** Pide cerrar tras vaciar lo escrito (idempotente). */
  close(id: number): void;
}

/** Reparte los eventos globales `onData`/`onClosed` del módulo nativo entre los enlaces por id. */
export function createRfcommDispatcher() {
  const handlers = new Map<number, RfcommHandlers>();
  return {
    register(id: number, h: RfcommHandlers): () => void {
      handlers.set(id, h);
      return () => {
        if (handlers.get(id) === h) handlers.delete(id);
      };
    },
    data(id: number, base64: string): void {
      handlers.get(id)?.data(base64);
    },
    closed(id: number, error?: string): void {
      handlers.get(id)?.closed(error);
    },
  };
}

export function makeRfcommLink(id: number, bridge: RfcommBridge): Link {
  let closing = false; // close() pedido o enlace caído: ya no se admite escribir
  let signalled = false; // onClose ya avisado
  let closeError: Error | undefined;
  let dataCb: ((bytes: Uint8Array) => void) | null = null;
  const early: Uint8Array[] = []; // llegados antes de onData
  const closeCbs: ((error?: Error) => void)[] = [];
  let unregister: () => void = () => {};

  const signalClose = (error?: Error) => {
    if (signalled) return;
    signalled = true;
    closing = true;
    closeError = error;
    unregister();
    for (const cb of closeCbs) cb(error);
  };

  unregister = bridge.register(id, {
    data(base64) {
      if (signalled) return;
      let bytes: Uint8Array;
      try {
        bytes = bridge.decode(base64);
      } catch (e) {
        // un trozo ilegible no se puede saltar sin romper el flujo: se corta el enlace
        bridge.close(id);
        signalClose(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (dataCb) dataCb(bytes);
      else early.push(bytes);
    },
    closed(error) {
      signalClose(error ? new Error(error) : undefined);
    },
  });

  return {
    write(bytes) {
      // la Session trata la excepción como 'link_closed'
      if (closing || signalled) throw new Error('enlace cerrado');
      try {
        bridge.write(id, bridge.encode(bytes));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        signalClose(error);
        throw error;
      }
    },
    close() {
      if (closing || signalled) return;
      closing = true;
      try {
        bridge.close(id);
      } catch (e) {
        signalClose(e instanceof Error ? e : new Error(String(e)));
      }
    },
    onData(cb) {
      dataCb = cb;
      for (const bytes of early.splice(0)) cb(bytes);
    },
    onClose(cb) {
      if (signalled) cb(closeError);
      else closeCbs.push(cb);
    },
  };
}
