import { describe, expect, test } from 'vitest';
import {
  ClipboardSync,
  FILE_CHUNK_BYTES,
  FrameDecoder,
  MAX_CLIP_BYTES,
  Session,
  sha256Hex,
  type AuthDecision,
  type ClientHello,
  type Link,
  type PeerInfo,
  type SessionOptions,
  type TransferUpdate,
} from '../src/index';
import {
  KEYS,
  fakeTimers,
  flush,
  linkPair,
  memorySink,
  memorySource,
  rawClient,
  rawServer,
  type MemorySink,
} from './helpers';

const MOVIL: PeerInfo = { deviceId: 'movil-1', deviceName: 'Pixel de Javier' };
const PC: PeerInfo = { deviceId: 'pc-1', deviceName: 'PC' };
const TOKEN = 'AbCdEfGhIjKlMnOpQrSt_-';

let ids = 0;
function newId(): string {
  return (++ids).toString(16).padStart(32, '0');
}

interface Side {
  local?: string | null;
  timers?: ReturnType<typeof fakeTimers>;
  serverKey?: Uint8Array;
  pairingToken?: string | null;
  authorize?: SessionOptions['authorize'];
}

function makeSession(link: Link, role: 'client' | 'server', side: Side = {}) {
  const sinks: MemorySink[] = [];
  const session = new Session(link, {
    role,
    self: role === 'client' ? MOVIL : PC,
    identity: role === 'client' ? KEYS.movil : KEYS.pc,
    serverKey: side.serverKey ?? KEYS.pc.publicKey,
    pairingToken: side.pairingToken,
    authorize: side.authorize ?? (async () => ({ accepted: true })),
    clipSyncFor: () => new ClipboardSync(),
    getLocalClip: async () => side.local ?? null,
    openSink: async (meta) => {
      const s = memorySink(meta.name);
      sinks.push(s);
      return s;
    },
    newTransferId: newId,
    timers: side.timers ?? fakeTimers(),
  });
  const ev = {
    ready: [] as PeerInfo[],
    clip: [] as string[],
    closed: [] as string[],
    transfers: [] as TransferUpdate[],
  };
  session.on('ready', (p) => ev.ready.push(p));
  session.on('clip', (t) => ev.clip.push(t));
  session.on('closed', (r) => ev.closed.push(r));
  session.on('transfer', (u) => ev.transfers.push(u));
  return { session, ev, sinks };
}

/** Registra cada escritura de un extremo del enlace, tal como sale al cable. */
function recordWrites(link: Link, writes: Uint8Array[]): Link {
  return {
    ...link,
    write(bytes) {
      writes.push(bytes.slice());
      link.write(bytes);
    },
  };
}

async function connect(client: Side = {}, server: Side = {}, wrap: (l: Link) => Link = (l) => l) {
  const [a, b] = linkPair();
  const c = makeSession(wrap(a), 'client', client);
  const s = makeSession(wrap(b), 'server', server);
  await Promise.all([s.session.start(), c.session.start()]);
  await flush();
  return { c, s };
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

describe('handshake', () => {
  test('handshake: ready en ambos; el cliente ve { deviceId: "pc-1", deviceName: "PC" }', async () => {
    const { c, s } = await connect();
    expect(c.ev.ready).toEqual([{ deviceId: 'pc-1', deviceName: 'PC' }]);
    expect(s.ev.ready).toEqual([MOVIL]);
    expect(c.ev.closed).toEqual([]);
    expect(s.ev.closed).toEqual([]);
    // y el canal cifrado funciona en los dos sentidos
    c.session.sendClip('ida');
    s.session.sendClip('vuelta');
    await flush();
    expect(s.ev.clip).toEqual(['ida']);
    expect(c.ev.clip).toEqual(['vuelta']);
  });

  test('authorize recibe la clave pública del cliente y el hello con pairingToken y willSendClip', async () => {
    const seen: { publicKey: Uint8Array; hello: ClientHello }[] = [];
    await connect(
      { pairingToken: TOKEN, local: 'hola' },
      {
        authorize: async (req) => {
          seen.push(req);
          return { accepted: true };
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].publicKey).toEqual(KEYS.movil.publicKey);
    expect(seen[0].hello).toEqual({ v: 2, ...MOVIL, willSendClip: true, pairingToken: TOKEN });
  });

  test('sin pairingToken, el hello no lo lleva', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, 'client', { pairingToken: null });
    const raw = rawServer(b);
    await c.session.start();
    await flush();
    expect(raw.clientHello()).toEqual({ v: 2, ...MOVIL, willSendClip: false });
    expect(c.ev.ready).toEqual([PC]);
  });

  test('rechazo not_paired: el cliente cierra con "not_paired" sin ready; el servidor también', async () => {
    const reject = async (): Promise<AuthDecision> => ({ accepted: false, reason: 'not_paired' });
    const { c, s } = await connect({}, { authorize: reject });
    expect(c.ev.ready).toEqual([]);
    expect(s.ev.ready).toEqual([]);
    expect(c.ev.closed).toEqual(['not_paired']);
    expect(s.ev.closed).toEqual(['not_paired']);
  });

  test('rechazo pairing_expired llega como "pairing_expired"', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, 'client', { pairingToken: TOKEN });
    const raw = rawServer(b, { answer: () => ({ v: 2, accepted: false, reason: 'pairing_expired' }) });
    await c.session.start();
    await flush();
    expect(c.ev.ready).toEqual([]);
    expect(c.ev.closed).toEqual(['pairing_expired']);
    expect(raw.closed).toBe(true);
  });

  test('clave del servidor equivocada → el cliente acaba en "handshake_failed"', async () => {
    const { c, s } = await connect({ serverKey: KEYS.otro.publicKey });
    expect(c.ev.ready).toEqual([]);
    expect(s.ev.ready).toEqual([]);
    expect(c.ev.closed).toEqual(['handshake_failed']);
    expect(s.ev.closed).toEqual(['handshake_failed']);
  });

  test('enlace cerrado tras el mensaje 1 → "handshake_failed"', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, 'client');
    b.onData(() => b.close());
    await c.session.start();
    await flush();
    expect(c.ev.ready).toEqual([]);
    expect(c.ev.closed).toEqual(['handshake_failed']);
  });

  test('enlace cerrado antes del mensaje 1 → "link_closed"', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, 'client');
    b.close();
    await c.session.start();
    await flush();
    expect(c.ev.closed).toEqual(['link_closed']);
  });

  test('mensaje 2 que no se puede leer → "handshake_failed"', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, 'client');
    // contesta al mensaje 1 con 48 bytes de basura (la longitud mínima de un mensaje 2)
    b.onData(() => b.write(Uint8Array.of(0, 48, ...new Uint8Array(48).fill(7))));
    await c.session.start();
    await flush();
    expect(c.ev.ready).toEqual([]);
    expect(c.ev.closed).toEqual(['handshake_failed']);
  });

  test('trama extra antes de la respuesta del servidor → "protocol_error"', async () => {
    const [a, b] = linkPair();
    let asked = 0;
    const s = makeSession(b, 'server', {
      authorize: () => {
        asked++;
        return new Promise<AuthDecision>(() => {}); // la decisión aún no ha llegado
      },
    });
    await s.session.start();
    // se registra ya el resultado: la promesa se rechaza durante el flush
    const outcome = rawClient(a).then(
      () => 'aceptado',
      () => 'rechazado',
    );
    await flush();
    expect(asked).toBe(1);
    a.write(Uint8Array.of(0, 20, ...new Uint8Array(20)));
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
    expect(s.ev.ready).toEqual([]);
    expect(await outcome).toBe('rechazado'); // el enlace se cerró sin mensaje 2
  });

  test('si authorize falla, el servidor cierra con "internal_error"', async () => {
    const { c, s } = await connect({}, { authorize: async () => Promise.reject(new Error('disco')) });
    expect(s.ev.closed).toEqual(['internal_error']);
    expect(s.ev.ready).toEqual([]);
    expect(c.ev.closed).toEqual(['handshake_failed']);
  });

  test('constructor sin serverKey (cliente) o sin authorize (servidor) lanza', () => {
    const [a, b] = linkPair();
    const base: SessionOptions = {
      role: 'client',
      self: MOVIL,
      identity: KEYS.movil,
      clipSyncFor: () => new ClipboardSync(),
      getLocalClip: async () => null,
      openSink: async (meta) => memorySink(meta.name),
      newTransferId: newId,
      timers: fakeTimers(),
    };
    const server: SessionOptions = { ...base, role: 'server', self: PC, identity: KEYS.pc };
    expect(() => new Session(a, base)).toThrow(Error);
    expect(() => new Session(b, server)).toThrow(Error);
    // con lo que pide cada papel, no lanza
    expect(() => new Session(a, { ...base, serverKey: KEYS.pc.publicKey })).not.toThrow();
    expect(() => new Session(b, { ...server, authorize: async () => ({ accepted: true }) })).not.toThrow();
  });
});

describe('tramas cifradas', () => {
  test('nada viaja en claro: los bytes del enlace no contienen el texto del clip ni el deviceName', async () => {
    const writes: Uint8Array[] = [];
    const secret = 'contraseña del banco: 1234';
    const { c, s } = await connect({ local: 'texto de arranque del móvil' }, {}, (l) => recordWrites(l, writes));
    c.session.sendClip(secret);
    s.session.sendClip('respuesta secreta del PC');
    await flush();
    expect(s.ev.clip).toEqual(['texto de arranque del móvil', secret]);
    expect(c.ev.clip).toEqual(['respuesta secreta del PC']);
    const wire = concat(writes);
    const enc = new TextEncoder();
    const plains = [secret, 'respuesta secreta del PC', 'texto de arranque del móvil', MOVIL.deviceName, MOVIL.deviceId];
    for (const plain of plains) {
      expect(contains(wire, enc.encode(plain))).toBe(false);
    }
    // ni el hash del clip (va en el JSON del clip)
    expect(contains(wire, enc.encode(sha256Hex(secret)))).toBe(false);
  });

  test('un bit cambiado en una trama a mitad de un archivo → protocol_error, sink abortado, ambos failed', async () => {
    let big = 0;
    // el tercer trozo de datos que escribe el cliente llega con un bit cambiado
    const flip = (l: Link): Link => ({
      ...l,
      write(bytes) {
        if (bytes.length > FILE_CHUNK_BYTES && ++big === 3) {
          const copy = bytes.slice();
          copy[copy.length >> 1] ^= 0x10;
          return l.write(copy);
        }
        l.write(bytes);
      },
    });
    const [a, b] = linkPair();
    const c = makeSession(flip(a), 'client');
    const s = makeSession(b, 'server');
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    const src = memorySource(new Uint8Array(6 * FILE_CHUNK_BYTES).fill(5), 'mitad.bin');
    c.session.sendFile(src);
    await flush();
    expect(big).toBeGreaterThanOrEqual(3);
    expect(s.ev.closed).toEqual(['protocol_error']);
    expect(s.sinks[0].aborted).toBe(true);
    expect(s.sinks[0].finished).toBe(false);
    expect(s.ev.transfers.at(-1)).toMatchObject({ direction: 'in', state: 'failed', error: 'protocol_error' });
    expect(c.ev.transfers.at(-1)).toMatchObject({ direction: 'out', state: 'failed', error: 'link_closed' });
    expect(c.ev.closed).toEqual(['link_closed']);
    expect(src.closed).toBe(true);
  });

  test('hello como mensaje de control tras el handshake → "protocol_error"', async () => {
    const [a, b] = linkPair();
    const s = makeSession(b, 'server');
    await s.session.start();
    const raw = await rawClient(a, { hello: MOVIL });
    await flush();
    expect(s.ev.ready).toEqual([MOVIL]);
    raw.send({ kind: 'hello', v: 2, ...MOVIL });
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
    expect(raw.closed).toBe(true);

    // también en el cliente
    const [a2, b2] = linkPair();
    const c = makeSession(a2, 'client');
    const server = rawServer(b2);
    await c.session.start();
    await flush();
    expect(c.ev.ready).toEqual([PC]);
    server.send({ kind: 'hello', v: 2, ...PC });
    await flush();
    expect(c.ev.closed).toEqual(['protocol_error']);
  });

  test('clip de 1 MiB de emojis llega entero; ninguna trama del enlace pasa de 65537 bytes con su longitud', async () => {
    const writes: Uint8Array[] = [];
    const { c, s } = await connect({}, {}, (l) => recordWrites(l, writes));
    const text = '😀'.repeat(MAX_CLIP_BYTES / 4); // 4 bytes UTF-8 cada uno: 1 MiB justo
    expect(c.session.sendClip(text)).toBe('send');
    await flush();
    expect(s.ev.clip).toHaveLength(1);
    expect(s.ev.clip[0] === text).toBe(true);
    // cada escritura es una trama entera: longitud u16 + mensaje cifrado
    const frames = new FrameDecoder();
    let largest = 0;
    for (const w of writes) {
      const got = frames.push(w);
      expect(got).toHaveLength(1);
      largest = Math.max(largest, w.length);
    }
    expect(largest).toBe(65537); // los fragmentos llenos llegan justo al máximo
  });

  test('sin respuesta al mensaje 1 en 30 s → "heartbeat_timeout"', async () => {
    const [a] = linkPair();
    const timers = fakeTimers();
    const c = makeSession(a, 'client', { timers });
    await c.session.start();
    await flush();
    timers.advance(20_000);
    await flush();
    expect(c.ev.closed).toEqual([]);
    timers.advance(10_000);
    await flush();
    expect(c.ev.closed).toEqual(['heartbeat_timeout']);
    expect(c.ev.ready).toEqual([]);
  });
});
