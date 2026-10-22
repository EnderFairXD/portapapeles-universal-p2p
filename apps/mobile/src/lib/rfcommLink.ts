// Link de la Session sobre un socket RFCOMM del módulo nativo (modules/clipsync-native).
import { RFCOMM_SERVICE_UUID, type Link } from '@clipsync/protocol';

import { clipsyncNative, type ClipsyncNativeModule } from '../../modules/clipsync-native';
import { createRfcommDispatcher, makeRfcommLink, type RfcommBridge } from './rfcommLinkCore';

/** Margen sobre el plazo nativo por si la promesa nativa tarda en llegar a JS. */
const PROMISE_SLACK_MS = 2000;

const dispatcher = createRfcommDispatcher();
let subscribed = false;

/** Una sola suscripción a los eventos globales del módulo; reparte por id. */
function subscribe(native: ClipsyncNativeModule): void {
  if (subscribed) return;
  subscribed = true;
  native.addListener('onData', (e) => dispatcher.data(e.id, e.base64));
  native.addListener('onClosed', (e) => dispatcher.closed(e.id, e.error));
}

/**
 * Conecta por Bluetooth (RFCOMM) con un PC ya emparejado en el sistema y resuelve con el enlace
 * abierto; rechaza si no conecta en `timeoutMs`, si falta el permiso o si Bluetooth está apagado.
 */
export async function connectRfcomm(address: string, timeoutMs: number): Promise<Link> {
  const native = clipsyncNative;
  if (!native) throw new Error('Bluetooth no disponible en este móvil');
  subscribe(native);
  const bridge: RfcommBridge = {
    register: dispatcher.register,
    encode: (bytes) => native.base64Encode(bytes),
    decode: (text) => native.base64Decode(text),
    write: (id, base64) => native.write(id, base64),
    close: (id) => native.close(id),
  };

  const pending = native.connect(address, RFCOMM_SERVICE_UUID, timeoutMs);
  let giveUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      giveUp = true;
      reject(new Error('Tiempo de conexión agotado'));
    }, timeoutMs + PROMISE_SLACK_MS);
  });
  let id: number;
  try {
    id = await Promise.race([pending, timeout]);
  } catch (e) {
    // si el socket llega tarde, nadie lo usará: se cierra
    if (giveUp) {
      void pending.then(
        (late) => native.close(late),
        () => {},
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
  // los manejadores se registran antes de que el hilo lector empiece a emitir
  const link = makeRfcommLink(id, bridge);
  native.startReading(id);
  return link;
}
