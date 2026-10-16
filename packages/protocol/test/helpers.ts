// Utilidades de prueba para Session (no se exportan desde src/index.ts).
import {
  FrameDecoder,
  MessageDecoder,
  encodeControl,
  encodeFrame,
  type ControlMessage,
  type DecodedMessage,
  type FileSink,
  type FileSource,
  type Link,
  type Timers,
} from '../src/index';

/** Dos extremos de un enlace en memoria: entrega asíncrona y cerrar uno cierra el otro. */
export function linkPair(): [Link, Link] {
  type End = { data: ((b: Uint8Array) => void)[]; close: ((e?: Error) => void)[]; closed: boolean };
  const ends: [End, End] = [
    { data: [], close: [], closed: false },
    { data: [], close: [], closed: false },
  ];

  const closeBoth = () => {
    for (const end of ends) {
      if (end.closed) continue;
      end.closed = true;
      queueMicrotask(() => end.close.forEach((cb) => cb()));
    }
  };

  const make = (me: End, other: End): Link => ({
    write(bytes) {
      if (me.closed) throw new Error('enlace cerrado');
      const copy = bytes.slice();
      queueMicrotask(() => {
        if (!other.closed) other.data.forEach((cb) => cb(copy));
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

/** Par «a mano» sobre un extremo de enlace: envía y registra mensajes del protocolo. */
export function rawPeer(link: Link) {
  const frames = new FrameDecoder();
  const messages = new MessageDecoder();
  const received: DecodedMessage[] = [];
  const handlers: ((m: DecodedMessage) => void)[] = [];
  let closed = false;

  link.onData((bytes) => {
    for (const f of frames.push(bytes)) {
      const m = messages.push(f);
      if (!m) continue;
      received.push(m);
      handlers.forEach((h) => h(m));
    }
  });
  link.onClose(() => {
    closed = true;
  });

  return {
    received,
    get closed() {
      return closed;
    },
    /** Mensajes de control recibidos, en orden. */
    controls(): ControlMessage[] {
      return received.flatMap((m) => (m.type === 'control' ? [m.msg] : []));
    },
    send(msg: ControlMessage) {
      for (const p of encodeControl(msg)) link.write(encodeFrame(p));
    },
    sendRaw(payload: Uint8Array) {
      link.write(encodeFrame(payload));
    },
    onMessage(h: (m: DecodedMessage) => void) {
      handlers.push(h);
    },
    close() {
      link.close();
    },
  };
}
