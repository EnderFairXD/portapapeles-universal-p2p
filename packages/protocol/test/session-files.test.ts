import { describe, expect, test } from 'vitest';
import {
  ClipboardSync,
  FILE_ACK_EVERY_BYTES,
  FILE_CHUNK_BYTES,
  FILE_WINDOW_BYTES,
  FrameDecoder,
  MessageDecoder,
  Session,
  encodeFileData,
  sha256Hex,
  type ControlMessage,
  type DecodedMessage,
  type FileMeta,
  type FileSink,
  type Link,
  type PeerInfo,
  type TransferUpdate,
} from '../src/index';
import { fakeTimers, flush, linkPair, memorySink, memorySource, rawPeer, type MemorySink } from './helpers';

const MOVIL: PeerInfo = { deviceId: 'movil-1', deviceName: 'Pixel' };
const PC: PeerInfo = { deviceId: 'pc-1', deviceName: 'PC' };
const MiB = FILE_ACK_EVERY_BYTES;

let ids = 0;
function newId(): string {
  return (++ids).toString(16).padStart(32, '0');
}

/** Bytes deterministas, distintos en cada posición del ciclo. */
function pattern(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** Sink en memoria cuya escritura espera hasta release(). */
function gatedSink(name: string) {
  const sink = memorySink(name);
  const write = sink.write.bind(sink);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  sink.write = async (b) => {
    await gate;
    await write(b);
  };
  return { sink, release };
}

/** Enlace que decodifica lo que sale y lo que entra, sin alterarlo. */
function spyLink(inner: Link, onOut: (m: DecodedMessage) => void, onIn: (m: DecodedMessage) => void = () => {}): Link {
  const decode = (frames: FrameDecoder, messages: MessageDecoder, bytes: Uint8Array, cb: (m: DecodedMessage) => void) => {
    for (const f of frames.push(bytes)) {
      const m = messages.push(f);
      if (m) cb(m);
    }
  };
  const outF = new FrameDecoder();
  const outM = new MessageDecoder();
  const inF = new FrameDecoder();
  const inM = new MessageDecoder();
  return {
    write(bytes) {
      decode(outF, outM, bytes, onOut);
      inner.write(bytes);
    },
    close: () => inner.close(),
    onData(cb) {
      inner.onData((bytes) => {
        decode(inF, inM, bytes, onIn);
        cb(bytes);
      });
    },
    onClose: (cb) => inner.onClose(cb),
  };
}

function makeSession(link: Link, role: 'client' | 'server', openSink?: (meta: FileMeta) => Promise<FileSink>) {
  const sinks: MemorySink[] = [];
  const timers = fakeTimers();
  const session = new Session(link, {
    role,
    self: role === 'client' ? MOVIL : PC,
    clipSyncFor: () => new ClipboardSync(),
    getLocalClip: async () => null,
    openSink:
      openSink ??
      (async (meta) => {
        const s = memorySink(meta.name);
        sinks.push(s);
        return s;
      }),
    newTransferId: newId,
    timers,
  });
  const ev = { transfers: [] as TransferUpdate[], closed: [] as string[], clip: [] as string[], order: [] as string[] };
  session.on('transfer', (u) => {
    ev.transfers.push(u);
    ev.order.push(`transfer:${u.state}`);
  });
  session.on('closed', (r) => {
    ev.closed.push(r);
    ev.order.push(`closed:${r}`);
  });
  session.on('clip', (t) => ev.clip.push(t));
  return { session, sinks, ev, timers, link };
}

type Made = ReturnType<typeof makeSession>;

async function connect(
  opts: { wrapClient?: (l: Link) => Link; serverSink?: (meta: FileMeta) => Promise<FileSink> } = {},
): Promise<{ c: Made; s: Made }> {
  const [a, b] = linkPair();
  const c = makeSession(opts.wrapClient ? opts.wrapClient(a) : a, 'client');
  const s = makeSession(b, 'server', opts.serverSink);
  await Promise.all([s.session.start(), c.session.start()]);
  await flush();
  return { c, s };
}

function last(m: Made): TransferUpdate {
  return m.ev.transfers[m.ev.transfers.length - 1];
}

/** Servidor real contra un cliente «a mano» ya saludado. */
async function serverAgainstRaw() {
  const [a, b] = linkPair();
  const s = makeSession(b, 'server');
  const raw = rawPeer(a);
  await s.session.start();
  raw.send({ kind: 'hello', v: 2, ...MOVIL });
  await flush();
  return { s, raw };
}

/** Cliente real contra un servidor «a mano» que contesta al hello. */
async function clientAgainstRaw() {
  const [a, b] = linkPair();
  const c = makeSession(a, 'client');
  const raw = rawPeer(b);
  raw.onMessage((m) => {
    if (m.type === 'control' && m.msg.kind === 'hello') raw.send({ kind: 'hello', v: 2, ...PC });
  });
  await c.session.start();
  await flush();
  return { c, raw };
}

describe('envío y recepción', () => {
  test.each([0, 1, 49152, 49152 * 3, 5 * 1024 * 1024 + 7])('archivo de %i bytes llega idéntico', async (n) => {
    const { c, s } = await connect();
    const data = pattern(n);
    const src = memorySource(data, 'f.bin');
    const id = c.session.sendFile(src);
    await flush();

    expect(s.sinks).toHaveLength(1);
    const got = s.sinks[0].bytes();
    expect(got.length).toBe(n);
    expect(sha256Hex(got)).toBe(sha256Hex(data));
    expect(s.sinks[0].finished).toBe(true);
    expect(s.sinks[0].aborted).toBe(false);
    expect(src.closed).toBe(true);

    expect(last(c)).toEqual({ transferId: id, direction: 'out', name: 'f.bin', size: n, bytes: n, state: 'done' });
    expect(last(s)).toEqual({
      transferId: id,
      direction: 'in',
      name: 'f.bin',
      size: n,
      bytes: n,
      state: 'done',
      location: 'mem://f.bin',
    });
    expect(c.ev.closed).toEqual([]);
    expect(s.ev.closed).toEqual([]);
  });

  test('el servidor también puede enviar al cliente', async () => {
    const { c, s } = await connect();
    const data = pattern(3 * MiB + 5);
    const id = s.session.sendFile(memorySource(data, 'del-pc.zip'));
    await flush();
    expect(sha256Hex(c.sinks[0].bytes())).toBe(sha256Hex(data));
    expect(last(s)).toMatchObject({ transferId: id, direction: 'out', state: 'done' });
    expect(last(c)).toMatchObject({ transferId: id, direction: 'in', state: 'done', location: 'mem://del-pc.zip' });
  });

  test('progreso: un aviso por estado y como mucho uno por cada MiB', async () => {
    const { c, s } = await connect();
    const n = 5 * MiB + 7;
    c.session.sendFile(memorySource(pattern(n), 'p'));
    await flush();
    const view = (m: Made) => m.ev.transfers.map((u) => [u.state, u.bytes]);
    expect(view(c)).toEqual([
      ['queued', 0],
      ['active', 0],
      ['active', 1 * MiB + 32768], // 22 trozos de 48 KiB cruzan el primer MiB
      ['active', 2 * MiB + 16384],
      ['active', 3 * MiB],
      ['active', 4 * MiB + 32768],
      ['active', n], // el último trozo, incompleto, cruza el quinto
      ['done', n],
    ]);
    expect(view(s)).toEqual(view(c).slice(1));
  });

  test('el receptor confirma cada MiB y otra vez en file_end; contesta file_result', async () => {
    const { s, raw } = await serverAgainstRaw();
    const id = newId();
    const data = pattern(2 * MiB + 50000);
    raw.send({ kind: 'file_start', transferId: id, name: 'r', size: data.length, mime: 'x' });
    for (let off = 0; off < data.length; off += FILE_CHUNK_BYTES) {
      raw.sendRaw(encodeFileData(id, data.subarray(off, off + FILE_CHUNK_BYTES)));
    }
    raw.send({ kind: 'file_end', transferId: id, sha256: sha256Hex(data) });
    await flush();
    const files = raw.controls().filter((m) => m.kind.startsWith('file_'));
    expect(files).toEqual([
      { kind: 'file_ack', transferId: id, received: 22 * FILE_CHUNK_BYTES },
      { kind: 'file_ack', transferId: id, received: 43 * FILE_CHUNK_BYTES },
      { kind: 'file_ack', transferId: id, received: data.length },
      { kind: 'file_result', transferId: id, ok: true },
    ]);
    expect(last(s).state).toBe('done');
  });
});

describe('control de flujo', () => {
  test('control de flujo: nunca más de 2 MiB sin confirmar', async () => {
    const g = gatedSink('grande');
    let sent = 0;
    let acked = 0;
    let maxUnacked = 0;
    const { c } = await connect({
      serverSink: async () => g.sink,
      wrapClient: (l) =>
        spyLink(
          l,
          (m) => {
            if (m.type !== 'data') return;
            sent += m.bytes.length;
            maxUnacked = Math.max(maxUnacked, sent - acked);
          },
          (m) => {
            if (m.type === 'control' && m.msg.kind === 'file_ack') acked = m.msg.received;
          },
        ),
    });
    const data = pattern(5 * MiB + 7);
    c.session.sendFile(memorySource(data, 'grande'));
    await flush();
    // el receptor está parado: el emisor llena la ventana y se detiene
    expect(sent).toBeLessThanOrEqual(FILE_WINDOW_BYTES);
    expect(sent).toBeGreaterThan(FILE_WINDOW_BYTES - FILE_CHUNK_BYTES);

    g.release();
    await flush();
    expect(maxUnacked).toBeLessThanOrEqual(FILE_WINDOW_BYTES);
    expect(sha256Hex(g.sink.bytes())).toBe(sha256Hex(data));
    expect(last(c).state).toBe('done');
  });

  test('sin file_ack el emisor espera; cada ack abre la ventana; espera file_result', async () => {
    const { c, raw } = await clientAgainstRaw();
    const n = 3 * MiB;
    const id = c.session.sendFile(memorySource(pattern(n), 'v'));
    await flush();
    const dataBytes = () => raw.received.reduce((t, m) => t + (m.type === 'data' ? m.bytes.length : 0), 0);
    expect(dataBytes()).toBe(42 * FILE_CHUNK_BYTES); // el siguiente trozo pasaría de 2 MiB

    raw.send({ kind: 'file_ack', transferId: id, received: 22 * FILE_CHUNK_BYTES });
    await flush();
    expect(dataBytes()).toBe(n); // quedaban menos de 2 MiB
    const kinds = raw.controls().map((m) => m.kind);
    expect(kinds).toEqual(['hello', 'file_start', 'file_end']);
    expect(last(c).state).toBe('active');

    raw.send({ kind: 'file_result', transferId: id, ok: true });
    await flush();
    expect(last(c)).toMatchObject({ state: 'done', bytes: n });
  });
});

describe('cola', () => {
  test('dos archivos se envían en orden, el segundo queda queued mientras tanto', async () => {
    const { c, s } = await connect();
    const id1 = c.session.sendFile(memorySource(pattern(100), 'uno'));
    const id2 = c.session.sendFile(memorySource(pattern(200), 'dos'));
    expect(id1).not.toBe(id2);
    const seq = () => c.ev.transfers.map((u) => `${u.name}:${u.state}`);
    expect(seq()).toEqual(['uno:queued', 'uno:active', 'dos:queued']);
    await flush();
    expect(seq()).toEqual(['uno:queued', 'uno:active', 'dos:queued', 'uno:done', 'dos:active', 'dos:done']);
    expect(s.sinks.map((k) => k.name)).toEqual(['uno', 'dos']);
    expect(s.sinks[1].bytes()).toEqual(pattern(200));
  });

  test('sendFile con un tamaño inválido lanza RangeError sin emitir nada', async () => {
    const { c } = await connect();
    for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const src = memorySource(pattern(1), 'x');
      src.size = size;
      expect(() => c.session.sendFile(src)).toThrow(RangeError);
    }
    expect(c.ev.transfers).toEqual([]);
  });

  test('sendFile antes de ready o tras cerrar lanza un error', async () => {
    const [a] = linkPair();
    const { session } = makeSession(a, 'client');
    expect(() => session.sendFile(memorySource(pattern(1), 'x'))).toThrow();
    const { c } = await connect();
    c.session.close();
    expect(() => c.session.sendFile(memorySource(pattern(1), 'x'))).toThrow();
  });
});

describe('errores', () => {
  test('hash distinto → receptor aborta el sink y ambos lados terminan failed/checksum_mismatch', async () => {
    let corrupted = false;
    const corrupt = (l: Link): Link => ({
      ...l,
      write(bytes) {
        if (!corrupted && bytes[2] === 0x02) {
          corrupted = true;
          const copy = bytes.slice();
          copy[copy.length - 1] ^= 0xff;
          return l.write(copy);
        }
        l.write(bytes);
      },
    });
    const { c, s } = await connect({ wrapClient: corrupt });
    const src = memorySource(pattern(3 * FILE_CHUNK_BYTES), 'roto');
    c.session.sendFile(src);
    await flush();
    expect(corrupted).toBe(true);
    expect(s.sinks[0].aborted).toBe(true);
    expect(s.sinks[0].finished).toBe(false);
    expect(last(s)).toMatchObject({ state: 'failed', error: 'checksum_mismatch' });
    expect(last(c)).toMatchObject({ state: 'failed', error: 'checksum_mismatch' });
    expect(src.closed).toBe(true);
    expect(c.ev.closed).toEqual([]);
    expect(s.ev.closed).toEqual([]);
  });

  test('origen que da más bytes de los anunciados → size_mismatch en ambos lados, sin cerrar', async () => {
    const { c, s } = await connect();
    const src = memorySource(pattern(FILE_CHUNK_BYTES * 2), 'crece');
    src.size = FILE_CHUNK_BYTES + 10;
    c.session.sendFile(src);
    await flush();
    expect(last(c)).toMatchObject({ state: 'failed', error: 'size_mismatch' });
    expect(last(s)).toMatchObject({ state: 'failed', error: 'size_mismatch' });
    expect(s.sinks[0].aborted).toBe(true);
    expect(s.sinks[0].bytes().length).toBeLessThanOrEqual(src.size);
    expect(src.closed).toBe(true);
    expect(c.ev.closed).toEqual([]);
  });

  test('origen que da menos bytes de los anunciados → size_mismatch en ambos lados', async () => {
    const { c, s } = await connect();
    const src = memorySource(pattern(100), 'mengua');
    src.size = 200;
    c.session.sendFile(src);
    await flush();
    expect(last(c)).toMatchObject({ state: 'failed', error: 'size_mismatch' });
    expect(last(s)).toMatchObject({ state: 'failed', error: 'size_mismatch' });
    expect(s.sinks[0].aborted).toBe(true);
  });

  test('error al leer el origen → read_error en ambos lados', async () => {
    const { c, s } = await connect();
    const src = memorySource(pattern(3 * FILE_CHUNK_BYTES), 'ilegible');
    let reads = 0;
    const read = src.read.bind(src);
    src.read = async (n) => {
      if (++reads === 2) throw new Error('E/S');
      return read(n);
    };
    c.session.sendFile(src);
    await flush();
    expect(last(c)).toMatchObject({ state: 'failed', error: 'read_error' });
    expect(last(s)).toMatchObject({ state: 'failed', error: 'read_error' });
    expect(s.sinks[0].aborted).toBe(true);
    expect(src.closed).toBe(true);
  });

  test('error al escribir el sink → write_error en ambos lados y los datos restantes se descartan', async () => {
    const sink = memorySink('lleno');
    let writes = 0;
    const write = sink.write.bind(sink);
    sink.write = async (b) => {
      if (++writes === 2) throw new Error('disco lleno');
      return write(b);
    };
    const { c, s } = await connect({ serverSink: async () => sink });
    c.session.sendFile(memorySource(pattern(10 * FILE_CHUNK_BYTES), 'lleno'));
    await flush();
    expect(last(s)).toMatchObject({ state: 'failed', error: 'write_error' });
    expect(last(c)).toMatchObject({ state: 'failed', error: 'write_error' });
    expect(sink.aborted).toBe(true);
    expect(s.ev.closed).toEqual([]);
    expect(c.ev.closed).toEqual([]);
  });

  test('datos 0x02 para un transferId desconocido → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.sendRaw(encodeFileData(newId(), pattern(10)));
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
  });

  test('más datos de los anunciados en file_start → closed("protocol_error") y sink abortado', async () => {
    const { s, raw } = await serverAgainstRaw();
    const id = newId();
    raw.send({ kind: 'file_start', transferId: id, name: 'x', size: 5, mime: 'x' });
    raw.sendRaw(encodeFileData(id, pattern(6)));
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
    expect(s.sinks[0].aborted).toBe(true);
    expect(last(s)).toMatchObject({ state: 'failed', error: 'protocol_error' });
  });

  test('file_start con otro archivo entrante en curso → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'file_start', transferId: newId(), name: 'a', size: 5, mime: 'x' });
    raw.send({ kind: 'file_start', transferId: newId(), name: 'b', size: 5, mime: 'x' });
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
  });
});

describe('cancelar', () => {
  test('cancelar desde el emisor → file_cancel, sink abortado, ambos cancelled', async () => {
    const g = gatedSink('c');
    const outgoing: ControlMessage[] = [];
    const { c, s } = await connect({
      serverSink: async () => g.sink,
      wrapClient: (l) => spyLink(l, (m) => m.type === 'control' && outgoing.push(m.msg)),
    });
    const src = memorySource(pattern(4 * MiB), 'c');
    const id = c.session.sendFile(src);
    await flush();
    c.session.cancelTransfer(id);
    expect(last(c)).toMatchObject({ transferId: id, state: 'cancelled' });
    g.release();
    await flush();
    expect(outgoing.filter((m) => m.kind === 'file_cancel')).toEqual([
      { kind: 'file_cancel', transferId: id, reason: 'cancelled' },
    ]);
    expect(g.sink.aborted).toBe(true);
    expect(g.sink.finished).toBe(false);
    expect(last(s)).toMatchObject({ transferId: id, state: 'cancelled' });
    expect(src.closed).toBe(true);
    expect(c.ev.closed).toEqual([]);
    expect(s.ev.closed).toEqual([]);
  });

  test('cancelar desde el receptor → el emisor para y ambos cancelled; los datos en vuelo se descartan', async () => {
    const g = gatedSink('r');
    const { c, s } = await connect({ serverSink: async () => g.sink });
    const src = memorySource(pattern(4 * MiB), 'r');
    const id = c.session.sendFile(src);
    await flush();
    s.session.cancelTransfer(id);
    expect(last(s)).toMatchObject({ transferId: id, direction: 'in', state: 'cancelled' });
    g.release();
    await flush();
    expect(g.sink.aborted).toBe(true);
    expect(last(c)).toMatchObject({ transferId: id, direction: 'out', state: 'cancelled' });
    expect(src.closed).toBe(true);
    expect(s.ev.closed).toEqual([]);
    expect(c.ev.closed).toEqual([]);
    // la sesión sigue sirviendo
    const data = pattern(1000);
    c.session.sendFile(memorySource(data, 'otro'));
    await flush();
    expect(last(s)).toMatchObject({ name: 'otro', state: 'done' });
  });

  test('cancelar uno en cola: se quita, cancelled, origen cerrado y sin file_cancel', async () => {
    const g = gatedSink('a');
    const outgoing: ControlMessage[] = [];
    const { c, s } = await connect({
      serverSink: async (meta) => (meta.name === 'a' ? g.sink : memorySink(meta.name)),
      wrapClient: (l) => spyLink(l, (m) => m.type === 'control' && outgoing.push(m.msg)),
    });
    c.session.sendFile(memorySource(pattern(3 * MiB), 'a'));
    const srcB = memorySource(pattern(10), 'b');
    const idB = c.session.sendFile(srcB);
    c.session.cancelTransfer(idB);
    expect(last(c)).toMatchObject({ transferId: idB, state: 'cancelled', bytes: 0 });
    g.release();
    await flush();
    expect(srcB.closed).toBe(true);
    expect(outgoing.some((m) => 'transferId' in m && m.transferId === idB)).toBe(false);
    expect(c.ev.transfers.filter((u) => u.transferId === idB).map((u) => u.state)).toEqual(['queued', 'cancelled']);
    expect(last(c)).toMatchObject({ name: 'a', state: 'done' });
    expect(s.ev.transfers.some((u) => u.name === 'b')).toBe(false);
  });

  test('cancelar desde el evento active no desincroniza: file_start + file_cancel y la sesión sigue', async () => {
    const outgoing: ControlMessage[] = [];
    const { c, s } = await connect({
      wrapClient: (l) => spyLink(l, (m) => m.type === 'control' && outgoing.push(m.msg)),
    });
    const off = c.session.on('transfer', (u) => {
      if (u.direction === 'out' && u.state === 'active' && u.bytes === 0) c.session.cancelTransfer(u.transferId);
    });
    const src = memorySource(pattern(1000), 'reentrante');
    const id = c.session.sendFile(src);
    await flush();
    off();
    const forId = outgoing.filter((m) => 'transferId' in m && m.transferId === id).map((m) => m.kind);
    expect(forId).toEqual(['file_start', 'file_cancel']);
    expect(last(c)).toMatchObject({ transferId: id, state: 'cancelled' });
    expect(src.closed).toBe(true);
    expect(s.sinks[0].aborted).toBe(true);
    expect(last(s)).toMatchObject({ transferId: id, state: 'cancelled' });

    const data = pattern(2000);
    c.session.sendFile(memorySource(data, 'siguiente'));
    await flush();
    expect(last(c)).toMatchObject({ name: 'siguiente', state: 'done' });
    expect(s.sinks[1].bytes()).toEqual(data);
    expect(c.ev.closed).toEqual([]);
    expect(s.ev.closed).toEqual([]);
  });

  test('cancelar un id desconocido o ya terminado no hace nada', async () => {
    const { c } = await connect();
    const id = c.session.sendFile(memorySource(pattern(10), 'x'));
    await flush();
    const before = c.ev.transfers.length;
    c.session.cancelTransfer(id);
    c.session.cancelTransfer('f'.repeat(32));
    await flush();
    expect(c.ev.transfers).toHaveLength(before);
    expect(c.ev.closed).toEqual([]);
  });
});

describe('cierre y convivencia', () => {
  test('enlace cerrado a mitad → sink abortado, ambos failed, closed emitido', async () => {
    const { c, s } = await connect();
    s.session.on('transfer', (u) => {
      if (u.state === 'active' && u.bytes >= MiB) s.link.close();
    });
    const src = memorySource(pattern(5 * MiB), 'corte');
    c.session.sendFile(src);
    await flush();
    expect(s.sinks[0].aborted).toBe(true);
    expect(s.sinks[0].finished).toBe(false);
    expect(last(s)).toMatchObject({ state: 'failed', error: 'link_closed' });
    expect(last(c)).toMatchObject({ state: 'failed', error: 'link_closed' });
    expect(c.ev.closed).toEqual(['link_closed']);
    expect(s.ev.closed).toEqual(['link_closed']);
    // el estado final de la transferencia llega antes de closed
    expect(c.ev.order.slice(-2)).toEqual(['transfer:failed', 'closed:link_closed']);
    expect(src.closed).toBe(true);
  });

  test('close() falla la activa y las de la cola con el motivo y cierra sus orígenes', async () => {
    const g = gatedSink('a');
    const { c, s } = await connect({ serverSink: async () => g.sink });
    const srcA = memorySource(pattern(3 * MiB), 'a');
    const srcB = memorySource(pattern(10), 'b');
    const idA = c.session.sendFile(srcA);
    const idB = c.session.sendFile(srcB);
    await flush();
    c.session.close();
    await flush();
    const final = (id: string) => c.ev.transfers.filter((u) => u.transferId === id).pop();
    expect(final(idA)).toMatchObject({ state: 'failed', error: 'closed' });
    expect(final(idB)).toMatchObject({ state: 'failed', error: 'closed' });
    expect(srcA.closed).toBe(true);
    expect(srcB.closed).toBe(true);
    g.release();
    await flush();
    expect(g.sink.aborted).toBe(true);
    expect(last(s)).toMatchObject({ state: 'failed', error: 'link_closed' });
  });

  test('si falla el ack final de file_end, el sink se aborta y nunca se llama a finish()', async () => {
    const [a, b] = linkPair();
    let writes = 0;
    // el servidor solo consigue escribir su hello
    const failing: Link = {
      ...b,
      write(bytes) {
        if (++writes > 1) throw new Error('enlace roto');
        b.write(bytes);
      },
    };
    const c = makeSession(a, 'client');
    const s = makeSession(failing, 'server');
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    c.session.sendFile(memorySource(pattern(100), 'final'));
    await flush();
    expect(s.ev.closed).toEqual(['link_closed']);
    expect(s.sinks[0].aborted).toBe(true);
    expect(s.sinks[0].finished).toBe(false);
    expect(last(s)).toMatchObject({ state: 'failed', error: 'link_closed' });
    expect(last(c)).toMatchObject({ state: 'failed', error: 'link_closed' });
  });

  test('durante una transferencia siguen llegando clip y ping, y los datos cuentan como tráfico', async () => {
    const { s, raw } = await serverAgainstRaw();
    const id = newId();
    const data = pattern(4 * FILE_CHUNK_BYTES);
    raw.send({ kind: 'file_start', transferId: id, name: 'lento', size: data.length, mime: 'x' });
    for (let i = 0; i < 4; i++) {
      raw.sendRaw(encodeFileData(id, data.subarray(i * FILE_CHUNK_BYTES, (i + 1) * FILE_CHUNK_BYTES)));
      if (i === 1) {
        raw.send({ kind: 'clip', id: 'c1', text: 'hola', hash: sha256Hex('hola') });
        raw.send({ kind: 'ping' });
      }
      await flush();
      s.timers.advance(10_000); // el par no contesta a los ping: solo llegan datos
      await flush();
    }
    expect(s.ev.closed).toEqual([]);
    expect(s.ev.clip).toEqual(['hola']);
    expect(raw.controls().some((m) => m.kind === 'pong')).toBe(true);
    raw.send({ kind: 'file_end', transferId: id, sha256: sha256Hex(data) });
    await flush();
    expect(last(s)).toMatchObject({ state: 'done', bytes: data.length });
    s.session.close();
  });
});
