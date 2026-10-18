// Link de la Session sobre react-native-tcp-socket (mismo contrato que e2e/nodeLink.ts).
import type { Link } from '@clipsync/protocol';
import TcpSocket from 'react-native-tcp-socket';

import { nativeBase64 } from './nativeCrypto';

/** Tope para vaciar las escrituras pendientes al cerrar; después se corta. */
const FLUSH_TIMEOUT_MS = 5000;

const encoder = new TextEncoder();

/** Conecta por TCP y resuelve con el enlace abierto; rechaza si no conecta en `timeoutMs`. */
export function connectTcp(host: string, port: number, timeoutMs: number): Promise<Link> {
  // Con base64 nativo el socket trabaja en cadenas base64 (react-native-tcp-socket parcheado no
  // las pasa por Buffer, que en Hermes costaba ~35 ms por trama de 48 KiB); sin él, en bytes.
  const b64 = nativeBase64();
  return new Promise((resolve, reject) => {
    let connected = false;
    let failed = false;
    const socket = TcpSocket.createConnection({ host, port, connectTimeout: timeoutMs }, () => {
      if (failed) return;
      connected = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(link);
    });

    const fail = (error: Error) => {
      if (connected || failed) return;
      failed = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Tiempo de conexión agotado')), timeoutMs);
    if (b64) socket.setEncoding('base64');

    // --- estado del enlace ---
    let closing = false; // close() pedido: ya no se admite escribir
    let signalled = false; // onClose ya avisado
    let closeError: Error | undefined;
    let pendingWrites = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let dataCb: ((bytes: Uint8Array) => void) | null = null;
    const early: Uint8Array[] = []; // datos llegados antes de onData
    const closeCbs: ((error?: Error) => void)[] = [];

    const signalClose = (error?: Error) => {
      if (signalled) return;
      signalled = true;
      closing = true;
      if (flushTimer) clearTimeout(flushTimer);
      for (const cb of closeCbs) cb(error);
    };

    // En Android, end() cierra el socket enseguida aunque haya escrituras en cola:
    // se espera a que salgan para que lo escrito llegue antes del FIN.
    const endWhenFlushed = () => {
      if (pendingWrites > 0 || signalled) return;
      if (flushTimer) clearTimeout(flushTimer);
      socket.end();
    };

    socket.on('data', (data) => {
      let bytes: Uint8Array;
      if (typeof data !== 'string') {
        // el Buffer del polyfill es un Uint8Array: se pasa una vista simple, sin copiar
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        bytes = b64 ? b64.decode(data) : encoder.encode(data);
      }
      if (dataCb) dataCb(bytes);
      else early.push(bytes);
    });
    socket.on('error', (error) => {
      if (!connected) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // tras un error puede no llegar 'close' (socket nativo ya liberado): se avisa aquí
      closeError = error instanceof Error ? error : new Error(String(error));
      signalClose(closeError);
    });
    socket.on('close', () => {
      if (!connected) {
        fail(new Error('Conexión cerrada'));
        return;
      }
      signalClose(closeError);
    });

    const link: Link = {
      write(bytes) {
        // la Session trata la excepción como 'link_closed'
        if (closing || signalled) throw new Error('enlace cerrado');
        const onWritten = () => {
          pendingWrites -= 1;
          if (closing) endWhenFlushed();
        };
        if (b64) socket.write(b64.encode(bytes), 'base64', onWritten);
        else socket.write(bytes, undefined, onWritten);
        pendingWrites += 1;
      },
      close() {
        if (closing || signalled) return;
        closing = true;
        flushTimer = setTimeout(() => socket.destroy(), FLUSH_TIMEOUT_MS);
        endWhenFlushed();
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
  });
}
