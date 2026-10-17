// Utilidades de prueba para Session (no se exportan desde src/index.ts).
import {
  FrameDecoder,
  MessageDecoder,
  NoiseIK,
  decodeClientHello,
  decodeServerHello,
  encodeClientHello,
  encodeControl,
  encodeFrame,
  encodeServerHello,
  keyPairFromPrivate,
  type CipherState,
  type ClientHello,
  type ControlMessage,
  type DecodedMessage,
  type FileSink,
  type FileSource,
  type KeyPair,
  type Link,
  type ServerHello,
  type Timers,
} from '../src/index';

/**
 * Dos extremos de un enlace en memoria: entrega asíncrona y cerrar uno cierra el otro.
 * Como en TCP, lo escrito antes de close() llega antes del aviso de cierre.
 */
export function linkPair(): [Link, Link] {
  type End = {
    data: ((b: Uint8Array) => void)[];
    close: ((e?: Error) => void)[];
    /** ya no admite escrituras */
    closed: boolean;
    /** ya se avisó del cierre: no recibe nada más */
    gone: boolean;
  };
  const ends: [End, End] = [
    { data: [], close: [], closed: false, gone: false },
    { data: [], close: [], closed: false, gone: false },
  ];

  const closeBoth = () => {
    for (const end of ends) {
      if (end.closed) continue;
      end.closed = true;
      // las microtareas van en orden: las entregas pendientes salen antes que el aviso
      queueMicrotask(() => {
        end.gone = true;
        end.close.forEach((cb) => cb());
      });
    }
  };

  const make = (me: End, other: End): Link => ({
    write(bytes) {
      if (me.closed) throw new Error('enlace cerrado');
      const copy = bytes.slice();
      queueMicrotask(() => {
        if (!other.gone) other.data.forEach((cb) => cb(copy));
      });
    },
    close: closeBoth,
    onData(cb) {
      me.data.push(cb);
    },
    onClose(cb) {
      me.close.push(cb);
    },
  });

  return [make(ends[0], ends[1]), make(ends[1], ends[0])];
}

/** Temporizadores falsos: solo avanzan con advance(ms). */
export function fakeTimers(): Timers & { advance(ms: number): void } {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { cb: () => void; ms: number; due: number }>();

  return {
    setInterval(cb, ms) {
      const id = nextId++;
      intervals.set(id, { cb, ms, due: now + ms });
      return id;
    },
    clearInterval(h) {
      intervals.delete(h as number);
    },
    now: () => now,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next: { id: number; due: number } | null = null;
        for (const [id, it] of intervals) {
          if (it.due <= target && (!next || it.due < next.due)) next = { id, due: it.due };
        }
        if (!next) break;
        const it = intervals.get(next.id)!;
        now = it.due;
        it.due += it.ms;
        it.cb();
      }
      now = target;
    },
  };
}

/** Deja correr todas las tareas pendientes (microtareas y entregas del enlace). */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

export interface MemorySink extends FileSink {
  readonly name: string;
  bytes(): Uint8Array;
  finished: boolean;
  aborted: boolean;
}

/** Sink en memoria; finish() devuelve `mem://<nombre>`. */
export function memorySink(name = 'archivo'): MemorySink {
  const chunks: Uint8Array[] = [];
  const sink: MemorySink = {
    name,
    finished: false,
    aborted: false,
    async write(b) {
      chunks.push(b.slice());
    },
    async finish() {
      sink.finished = true;
      return `mem://${name}`;
    },
    async abort() {
      sink.aborted = true;
    },
    bytes() {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    },
  };
  return sink;
}

/** Origen en memoria; read() devuelve un trozo vacío al llegar al final. */
export function memorySource(
  bytes: Uint8Array,
  name: string,
  mime = 'application/octet-stream',
): FileSource & { closed: boolean } {
  let off = 0;
  const src = {
    name,
    size: bytes.length,
    mime,
    closed: false,
    async read(maxBytes: number) {
      const chunk = bytes.slice(off, off + maxBytes);
      off += chunk.length;
      return chunk;
    },
    async close() {
      src.closed = true;
    },
  };
  return src;
}

/** Claves estáticas de prueba, de bytes fijos. */
export const KEYS: { movil: KeyPair; pc: KeyPair; otro: KeyPair } = {
  movil: keyPairFromPrivate(new Uint8Array(32).fill(1)),
  pc: keyPairFromPrivate(new Uint8Array(32).fill(2)),
  otro: keyPairFromPrivate(new Uint8Array(32).fill(3)),
};

/** Payload (trama 0x01) de un `hello` de la fase 1, que ya no es un mensaje de control. */
export function phase1HelloPayload(peer: { deviceId: string; deviceName: string }): Uint8Array {
  const json = JSON.stringify({ kind: 'hello', v: 2, deviceId: peer.deviceId, deviceName: peer.deviceName });
  return Uint8Array.of(0x01, ...new TextEncoder().encode(json));
}

/** Par «a mano» ya saludado: envía y registra mensajes del protocolo, cifrados con Noise. */
export interface RawPeer {
  received: DecodedMessage[];
  readonly closed: boolean;
  /** Mensajes de control recibidos, en orden. */
  controls(): ControlMessage[];
  send(msg: ControlMessage): void;
  /** Cifra y enmarca un payload. */
  sendRaw(payload: Uint8Array): void;
  /** Escribe los bytes tal cual, sin cifrar ni enmarcar. */
  sendWire(bytes: Uint8Array): void;
  /** Cambia un bit del siguiente mensaje cifrado que se envía. */
  corruptNext(): void;
  onMessage(h: (m: DecodedMessage) => void): void;
  close(): void;
}

/**
 * Extremo «a mano» sobre un enlace. La primera trama que llega es del handshake y la atiende
 * `onHandshake`; las siguientes se descifran con lo que se pase a `setCiphers` y se registran.
 */
function rawEnd(link: Link, onHandshake: (frame: Uint8Array) => void) {
  const frames = new FrameDecoder();
  const messages = new MessageDecoder();
  const received: DecodedMessage[] = [];
  const handlers: ((m: DecodedMessage) => void)[] = [];
  let closed = false;
  let corrupt = false;
  let cs: { send: CipherState; recv: CipherState } | null = null;
  let handshakeDone = false;

  link.onData((bytes) => {
    for (const f of frames.push(bytes)) {
      if (!handshakeDone) {
        handshakeDone = true;
        onHandshake(f);
        continue;
      }
      const m = messages.push(cs!.recv.decrypt(f));
      if (!m) continue;
      received.push(m);
      handlers.forEach((h) => h(m));
    }
  });
  link.onClose(() => {
    closed = true;
  });

  const peer: RawPeer = {
    received,
    get closed() {
      return closed;
    },
    controls() {
      return received.flatMap((m) => (m.type === 'control' ? [m.msg] : []));
    },
    send(msg) {
      for (const p of encodeControl(msg)) peer.sendRaw(p);
    },
    sendRaw(payload) {
      const ct = cs!.send.encrypt(payload);
      if (corrupt) {
        corrupt = false;
        ct[ct.length >> 1] ^= 0x01;
      }
      link.write(encodeFrame(ct));
    },
    sendWire(bytes) {
      link.write(bytes);
    },
    corruptNext() {
      corrupt = true;
    },
    onMessage(h) {
      handlers.push(h);
    },
    close() {
      link.close();
    },
  };
  return {
    peer,
    setCiphers(c: { send: CipherState; recv: CipherState }) {
      cs = c;
    },
  };
}

/**
 * Servidor «a mano» (PC): lee el mensaje 1, contesta con `answer` (por defecto acepta como
 * pc-1 / «PC») y, si se acepta, contesta pong a los ping con `answerPings`. Si el mensaje 1 no
 * se puede leer, cierra el enlace como haría el PC.
 */
export function rawServer(
  link: Link,
  o: { keys?: KeyPair; answer?: (h: ClientHello, pk: Uint8Array) => ServerHello; answerPings?: boolean } = {},
): RawPeer & { clientHello(): ClientHello | null } {
  const hs = NoiseIK.responder({ s: o.keys ?? KEYS.pc });
  let hello: ClientHello | null = null;
  const end = rawEnd(link, (frame) => {
    let pk: Uint8Array;
    try {
      hello = decodeClientHello(hs.readMessage(frame));
      pk = hs.remoteStatic!;
    } catch {
      link.close();
      return;
    }
    const answer: ServerHello = o.answer
      ? o.answer(hello, pk)
      : { v: 2, accepted: true, deviceId: 'pc-1', pcName: 'PC' };
    const msg2 = hs.writeMessage(encodeServerHello(answer));
    end.setCiphers(hs.split());
    link.write(encodeFrame(msg2));
  });
  if (o.answerPings) {
    end.peer.onMessage((m) => {
      if (m.type === 'control' && m.msg.kind === 'ping') end.peer.send({ kind: 'pong' });
    });
  }
  return Object.assign(end.peer, { clientHello: () => hello });
}

/**
 * Cliente «a mano» (móvil): escribe el mensaje 1 al momento y se resuelve con la respuesta del
 * servidor. Se rechaza si el enlace se cierra antes o si el mensaje 2 no se puede leer.
 */
export function rawClient(
  link: Link,
  o: { keys?: KeyPair; serverKey?: Uint8Array; hello?: Partial<ClientHello> } = {},
): Promise<RawPeer & { serverHello: ServerHello }> {
  const hs = NoiseIK.initiator({ s: o.keys ?? KEYS.movil, rs: o.serverKey ?? KEYS.pc.publicKey });
  return new Promise((resolve, reject) => {
    const end = rawEnd(link, (frame) => {
      let serverHello: ServerHello;
      try {
        serverHello = decodeServerHello(hs.readMessage(frame));
      } catch (e) {
        reject(e);
        return;
      }
      end.setCiphers(hs.split());
      resolve(Object.assign(end.peer, { serverHello }));
    });
    link.onClose(() => reject(new Error('enlace cerrado antes del mensaje 2')));
    const hello: ClientHello = { v: 2, deviceId: 'movil-1', deviceName: 'Pixel', ...o.hello };
    link.write(encodeFrame(hs.writeMessage(encodeClientHello(hello))));
  });
}
