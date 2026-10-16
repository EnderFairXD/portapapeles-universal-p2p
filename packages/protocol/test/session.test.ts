import { describe, expect, test } from 'vitest';
import {
  ClipboardSync,
  MAX_CLIP_BYTES,
  Session,
  sha256Hex,
  type Link,
  type PeerInfo,
  type SessionOptions,
  type Timers,
} from '../src/index';
import { fakeTimers, flush, linkPair, memorySink, rawPeer } from './helpers';

const MOVIL: PeerInfo = { deviceId: 'movil-1', deviceName: 'Pixel' };
const PC: PeerInfo = { deviceId: 'pc-1', deviceName: 'PC' };

let ids = 0;
function newId(): string {
  return (++ids).toString(16).padStart(32, '0');
}

interface Side {
  role: 'client' | 'server';
  local?: string | null;
  sync?: ClipboardSync;
  timers?: Timers;
}

/** Crea una sesión y registra todo lo que emite. */
function makeSession(link: Link, side: Side) {
  const sync = side.sync ?? new ClipboardSync();
  const asked: (PeerInfo | null)[] = [];
  const opts: SessionOptions = {
    role: side.role,
    self: side.role === 'client' ? MOVIL : PC,
    clipSyncFor(peer) {
      asked.push(peer);
      return sync;
    },
    getLocalClip: async () => side.local ?? null,
    openSink: async (meta) => memorySink(meta.name),
    newTransferId: newId,
    // sin temporizadores reales: ningún test deja un intervalo vivo
    timers: side.timers ?? fakeTimers(),
  };
  const session = new Session(link, opts);
  const ev = { ready: [] as PeerInfo[], clip: [] as string[], superseded: [] as string[], closed: [] as string[] };
  session.on('ready', (p) => ev.ready.push(p));
  session.on('clip', (t) => ev.clip.push(t));
  session.on('localClipSuperseded', (t) => ev.superseded.push(t));
  session.on('closed', (r) => ev.closed.push(r));
  return { session, sync, ev, asked };
}

async function connect(client: Omit<Side, 'role'> = {}, server: Omit<Side, 'role'> = {}) {
  const [a, b] = linkPair();
  const c = makeSession(a, { role: 'client', ...client });
  const s = makeSession(b, { role: 'server', ...server });
  await Promise.all([s.session.start(), c.session.start()]);
  await flush();
  return { c, s };
}

/** Cliente de sesión real contra un servidor «a mano» que contesta al hello. */
async function clientAgainstRaw(opts: { answerHello?: boolean; answerPings?: boolean } = {}) {
  const [a, b] = linkPair();
  const timers = fakeTimers();
  const c = makeSession(a, { role: 'client', timers });
  const raw = rawPeer(b);
  raw.onMessage((m) => {
    if (m.type !== 'control') return;
    if (m.msg.kind === 'hello' && opts.answerHello) raw.send({ kind: 'hello', v: 2, ...PC });
    if (m.msg.kind === 'ping' && opts.answerPings) raw.send({ kind: 'pong' });
  });
  await c.session.start();
  await flush();
  return { c, raw, timers };
}

/** Enlace que lanza a partir de la escritura número `ok + 1`. */
function failAfter(link: Link, ok: number): Link {
  let n = 0;
  return {
    ...link,
    write(bytes) {
      if (++n > ok) throw new Error('enlace roto');
      link.write(bytes);
    },
  };
}

/** Servidor de sesión real contra un cliente «a mano». */
async function serverAgainstRaw(local: string | null = null) {
  const [a, b] = linkPair();
  const s = makeSession(b, { role: 'server', local });
  const raw = rawPeer(a);
  await s.session.start();
  return { s, raw };
}

describe('saludo y portapapeles', () => {
  test('saludo: ambos emiten ready con los datos del otro', async () => {
    const { c, s } = await connect();
    expect(c.ev.ready).toEqual([PC]);
    expect(s.ev.ready).toEqual([MOVIL]);
    expect(c.session.peer?.deviceName).toBe('PC');
    expect(s.session.peer?.deviceName).toBe('Pixel');
    // el cliente pide su ClipboardSync sin par; el servidor, con el del cliente
    expect(c.asked).toEqual([null]);
    expect(s.asked).toEqual([MOVIL]);
  });

  test('el hello del cliente lleva willSendClip y el del servidor no', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'hello', v: 2, ...MOVIL, willSendClip: false });
    await flush();
    expect(raw.controls()).toEqual([{ kind: 'hello', v: 2, ...PC }]);
    expect(s.ev.ready).toEqual([MOVIL]);

    const { raw: rawServer } = await clientAgainstRaw();
    expect(rawServer.controls()).toEqual([{ kind: 'hello', v: 2, ...MOVIL, willSendClip: false }]);
  });

  test('clip del cliente llega al servidor y no rebota', async () => {
    const { c, s } = await connect();
    expect(c.session.sendClip('hola')).toBe('send');
    await flush();
    expect(s.ev.clip).toEqual(['hola']);
    expect(s.session.sendClip('hola')).toBe('duplicate');
    expect(c.session.sendClip('hola')).toBe('duplicate');
  });

  test('clip del servidor llega al cliente', async () => {
    const { c, s } = await connect();
    expect(s.session.sendClip('desde el PC')).toBe('send');
    await flush();
    expect(c.ev.clip).toEqual(['desde el PC']);
    expect(c.session.sendClip('desde el PC')).toBe('duplicate');
  });

  test('sendClip informa de empty y too_large sin enviar nada', async () => {
    const { c, s } = await connect();
    expect(c.session.sendClip('  ')).toBe('empty');
    expect(c.session.sendClip('a'.repeat(MAX_CLIP_BYTES + 1))).toBe('too_large');
    await flush();
    expect(s.ev.clip).toEqual([]);
  });

  test('sendClip de un texto cuyo JSON supera 2 MiB → too_large, sin marcar ni cerrar', async () => {
    const { c, s } = await connect();
    expect(c.session.sendClip('"'.repeat(MAX_CLIP_BYTES))).toBe('too_large');
    expect(c.sync.lastSyncedHash).toBeNull();
    await flush();
    expect(s.ev.clip).toEqual([]);
    expect(c.ev.closed).toEqual([]);
    expect(c.session.sendClip('hola')).toBe('send');
    await flush();
    expect(s.ev.clip).toEqual(['hola']);
  });

  test('sendClip antes del saludo lanza un error', () => {
    const [a] = linkPair();
    const { session } = makeSession(a, { role: 'client' });
    expect(() => session.sendClip('hola')).toThrow();
  });

  test('clip recibido con un hash que no corresponde → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'hello', v: 2, ...MOVIL });
    await flush();
    raw.send({ kind: 'clip', id: 'x', text: 'hola', hash: sha256Hex('adiós') });
    await flush();
    expect(s.ev.clip).toEqual([]);
    expect(s.ev.closed).toEqual(['protocol_error']);
  });

  test('clip recibido de más de 1 MiB → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'hello', v: 2, ...MOVIL });
    await flush();
    const text = 'a'.repeat(MAX_CLIP_BYTES + 1);
    raw.send({ kind: 'clip', id: 'x', text, hash: sha256Hex(text) });
    await flush();
    expect(s.ev.clip).toEqual([]);
    expect(s.ev.closed).toEqual(['protocol_error']);
    expect(raw.closed).toBe(true);
  });
});

describe('regla de inicio', () => {
  test('inicio: solo cambió el móvil → el PC recibe el texto del móvil', async () => {
    const { c, s } = await connect({ local: 'móvil' }, { local: null });
    expect(s.ev.clip).toEqual(['móvil']);
    expect(c.ev.clip).toEqual([]);
    expect(s.ev.superseded).toEqual([]);
    expect(c.sync.lastSyncedHash).toBe(sha256Hex('móvil'));
    expect(s.sync.lastSyncedHash).toBe(sha256Hex('móvil'));
  });

  test('inicio: solo cambió el PC → el móvil recibe el texto del PC', async () => {
    const { c, s } = await connect({ local: null }, { local: 'pc' });
    expect(c.ev.clip).toEqual(['pc']);
    expect(s.ev.clip).toEqual([]);
    expect(s.ev.superseded).toEqual([]);
    expect(c.sync.lastSyncedHash).toBe(sha256Hex('pc'));
    expect(s.sync.lastSyncedHash).toBe(sha256Hex('pc'));
  });

  test('inicio: cambiaron los dos → gana el móvil y el PC emite localClipSuperseded("pc")', async () => {
    const { c, s } = await connect({ local: 'móvil' }, { local: 'pc' });
    expect(s.ev.clip).toEqual(['móvil']);
    expect(c.ev.clip).toEqual([]);
    expect(s.ev.superseded).toEqual(['pc']);
    expect(c.sync.lastSyncedHash).toBe(sha256Hex('móvil'));
    expect(s.sync.lastSyncedHash).toBe(sha256Hex('móvil'));
  });

  test('inicio: el servidor no está ready hasta aplicar la regla (sendClip en ready no cruza clips)', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, { role: 'client', local: 'móvil' });
    const s = makeSession(b, { role: 'server', local: 'pc' });
    const onReady: string[] = [];
    // la app del PC envía su portapapeles en cuanto ve ready
    s.session.on('ready', () => onReady.push(s.session.sendClip('pc')));
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    expect(onReady).toEqual(['duplicate']);
    expect(s.ev.superseded).toEqual(['pc']);
    expect(s.ev.clip).toEqual(['móvil']);
    expect(c.ev.clip).toEqual([]);
    expect(c.sync.lastSyncedHash).toBe(sha256Hex('móvil'));
    expect(s.sync.lastSyncedHash).toBe(sha256Hex('móvil'));
  });

  test('inicio: un clip que no cabe al codificarlo no se anuncia ni cierra la sesión', async () => {
    const big = '"'.repeat(MAX_CLIP_BYTES); // pasa check(), pero su JSON supera 2 MiB
    const movil = await connect({ local: big }, { local: 'pc' });
    expect(movil.c.ev.closed).toEqual([]);
    expect(movil.s.ev.closed).toEqual([]);
    expect(movil.s.ev.superseded).toEqual([]); // el cliente no anunció willSendClip
    expect(movil.c.ev.clip).toEqual(['pc']);

    const pc = await connect({ local: null }, { local: big });
    expect(pc.s.ev.closed).toEqual([]);
    expect(pc.c.ev.closed).toEqual([]);
    expect(pc.c.ev.clip).toEqual([]);
    expect(pc.s.sync.lastSyncedHash).toBeNull();
  });

  test('inicio: si falla el envío del clip del cliente, no emite ready tras closed', async () => {
    const [a, b] = linkPair();
    const c = makeSession(failAfter(a, 1), { role: 'client', local: 'móvil' }); // pasa el hello, falla el clip
    const s = makeSession(b, { role: 'server' });
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    expect(c.ev.closed).toEqual(['link_closed']);
    expect(c.ev.ready).toEqual([]);
  });

  test('inicio: si falla el envío del clip del servidor, no emite ready tras closed', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, { role: 'client' });
    const s = makeSession(failAfter(b, 1), { role: 'server', local: 'pc' });
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    expect(s.ev.closed).toEqual(['link_closed']);
    expect(s.ev.ready).toEqual([]);
  });

  test('inicio: si la app cierra en ready, no se emite localClipSuperseded', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, { role: 'client', local: 'móvil' });
    const s = makeSession(b, { role: 'server', local: 'pc' });
    s.session.on('ready', () => s.session.close());
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    expect(s.ev.closed).toEqual(['closed']);
    expect(s.ev.superseded).toEqual([]);
  });

  test('inicio: nada cambió desde la última sincronización → nadie envía', async () => {
    const h = sha256Hex('igual');
    const { c, s } = await connect(
      { local: 'igual', sync: new ClipboardSync(h) },
      { local: 'igual', sync: new ClipboardSync(h) },
    );
    expect(c.ev.clip).toEqual([]);
    expect(s.ev.clip).toEqual([]);
    expect(s.ev.superseded).toEqual([]);
  });
});

describe('latido', () => {
  test('latido: sin tráfico 30 s → closed("heartbeat_timeout")', async () => {
    const { c, raw, timers } = await clientAgainstRaw({ answerHello: true });
    expect(c.ev.ready).toEqual([PC]);
    timers.advance(10_000);
    timers.advance(10_000);
    await flush();
    expect(c.ev.closed).toEqual([]);
    expect(raw.controls().filter((m) => m.kind === 'ping')).toHaveLength(2);
    timers.advance(10_000);
    await flush();
    expect(c.ev.closed).toEqual(['heartbeat_timeout']);
    expect(raw.closed).toBe(true);
  });

  test('latido: el plazo también corre durante el saludo', async () => {
    const { c, raw, timers } = await clientAgainstRaw({ answerHello: false });
    timers.advance(20_000);
    await flush();
    // antes del saludo no se envían pings
    expect(raw.controls().map((m) => m.kind)).toEqual(['hello']);
    timers.advance(10_000);
    await flush();
    expect(c.ev.closed).toEqual(['heartbeat_timeout']);
  });

  test('latido: un ping cada 10 s mantiene viva la sesión', async () => {
    const { c, raw, timers } = await clientAgainstRaw({ answerHello: true, answerPings: true });
    for (let i = 0; i < 5; i++) {
      timers.advance(10_000);
      await flush();
    }
    expect(raw.controls().filter((m) => m.kind === 'ping')).toHaveLength(5);
    expect(c.ev.closed).toEqual([]);
    expect(raw.closed).toBe(false);
  });

  test('responde pong a cada ping', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'hello', v: 2, ...MOVIL });
    await flush();
    raw.send({ kind: 'ping' });
    await flush();
    expect(raw.controls().map((m) => m.kind)).toEqual(['hello', 'pong']);
    expect(s.ev.closed).toEqual([]);
  });
});

describe('errores y cierre', () => {
  test('mensaje antes del hello → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'ping' });
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
    expect(s.ev.ready).toEqual([]);
    expect(raw.closed).toBe(true);
  });

  test('un segundo hello → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.send({ kind: 'hello', v: 2, ...MOVIL });
    await flush();
    raw.send({ kind: 'hello', v: 2, ...MOVIL });
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
  });

  test('una trama inválida → closed("protocol_error")', async () => {
    const { s, raw } = await serverAgainstRaw();
    raw.sendRaw(Uint8Array.of(0x07));
    await flush();
    expect(s.ev.closed).toEqual(['protocol_error']);
  });

  test('enlace cerrado por el otro lado → closed("link_closed")', async () => {
    const { c, raw } = await clientAgainstRaw({ answerHello: true });
    raw.close();
    await flush();
    expect(c.ev.closed).toEqual(['link_closed']);
  });

  test('close() local emite closed("closed") una sola vez y el otro lado ve link_closed', async () => {
    const { c, s } = await connect();
    c.session.close();
    c.session.close('otra');
    await flush();
    expect(c.ev.closed).toEqual(['closed']);
    expect(s.ev.closed).toEqual(['link_closed']);
    expect(() => c.session.sendClip('hola')).toThrow();
  });

  test('lo enviado justo antes de close() llega y se procesa antes del cierre', async () => {
    const { c, s } = await connect();
    expect(c.session.sendClip('adiós')).toBe('send');
    c.session.close();
    await flush();
    expect(s.ev.clip).toEqual(['adiós']);
    expect(s.ev.closed).toEqual(['link_closed']);
  });

  test('on() devuelve una función para darse de baja', async () => {
    const [a, b] = linkPair();
    const c = makeSession(a, { role: 'client' });
    const s = makeSession(b, { role: 'server' });
    const seen: PeerInfo[] = [];
    const off = c.session.on('ready', (p) => seen.push(p));
    off();
    await Promise.all([s.session.start(), c.session.start()]);
    await flush();
    expect(seen).toEqual([]);
    expect(c.ev.ready).toEqual([PC]);
  });
});
