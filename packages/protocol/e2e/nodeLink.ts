// Link de la Session sobre un socket TCP de Node (solo para el e2e).
import { connect } from 'node:net';
import type { Link } from '../src/index';

/** Conecta a 127.0.0.1:port y resuelve cuando el socket está abierto. */
export function connectNode(port: number, host = '127.0.0.1'): Promise<Link> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host, noDelay: true });
    let closed = false;
    let lastError: Error | undefined;
    const closeCbs: ((error?: Error) => void)[] = [];

    socket.on('error', (e) => {
      lastError = e; // 'close' llega después con el aviso
    });
    socket.on('close', () => {
      closed = true;
      for (const cb of closeCbs) cb(lastError);
    });
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve({
        write(bytes) {
          // la Session trata la excepción como 'link_closed'
          if (closed || socket.destroyed || socket.writableEnded) throw new Error('enlace cerrado');
          socket.write(bytes);
        },
        close() {
          closed = true;
          socket.end(); // lo ya escrito sale antes del FIN
        },
        onData(cb) {
          socket.on('data', (b: Buffer) => cb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
        },
        onClose(cb) {
          closeCbs.push(cb);
        },
      });
    });
    socket.once('error', reject);
  });
}
