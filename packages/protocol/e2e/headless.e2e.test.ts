// Extremo a extremo: Hub de Rust (ejemplo headless) frente a la Session de TypeScript por TCP local.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { ClipboardSync, Session, sha256Hex, type PeerInfo, type TransferUpdate } from '../src/index';
import { memorySink, memorySource, type MemorySink } from '../test/helpers';
import { connectNode } from './nodeLink';

const MANIFEST = fileURLToPath(new URL('../../../apps/desktop/src-tauri/Cargo.toml', import.meta.url));
const NODE: PeerInfo = { deviceId: 'node-e2e', deviceName: 'Node e2e' };
const WAIT_MS = 20_000;

/** Evento del Hub tal como lo escribe headless (HubEvent en JSON, más la línea `listening`). */
type HubLine = { type: string; [k: string]: unknown };

let binary = '';
let base = '';
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  binary = await buildHeadless();
  base = await mkdtemp(join(tmpdir(), 'clipsync-e2e-'));
});

afterEach(async () => {
  // procesos hijos y sesiones fuera tras cada test
  for (const c of cleanups.splice(0).reverse()) await c();
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

/** Compila el ejemplo una sola vez y devuelve la ruta del ejecutable según cargo. */
function buildHeadless(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'cargo',
      ['build', '--example', 'headless', '--manifest-path', MANIFEST, '--message-format=json'],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`cargo build falló:\n${stderr}`));
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('{')) continue;
          const m = JSON.parse(line);
          if (m.reason === 'compiler-artifact' && m.target?.name === 'headless' && m.executable) {
            return resolve(m.executable as string);
          }
        }
        reject(new Error('cargo no informó del ejecutable de headless'));
      },
    );
  });
}

/** Sondea hasta que `cond` devuelva algo distinto de undefined. */
async function waitUntil<T>(cond: () => T | undefined, what: string, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`Tiempo agotado esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dirs = 0;

/** Carpeta nueva dentro de la base del test, anidada para que `../..` no salga de `base`. */
async function freshDir(): Promise<string> {
  const d = join(base, `t${++dirs}`, 'a', 'descargas');
  await mkdir(d, { recursive: true });
  return d;
}

async function startHeadless(opts: { localClip?: string } = {}) {
  const downloadDir = await freshDir();
  const args = ['--download-dir', downloadDir];
  if (opts.localClip !== undefined) args.push('--local-clip', opts.localClip);
  const child: ChildProcess = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });

  const events: HubLine[] = [];
  const bad: string[] = [];
  let stderr = '';
  child.stderr!.on('data', (b) => (stderr += b.toString()));
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      bad.push(line);
    }
  });

  const listening = await waitUntil(
    () => events.find((e) => e.type === 'listening'),
    'línea listening',
  ).catch((e) => {
    throw new Error(`${e.message}\nstderr: ${stderr}`);
  });
  expect(events[0]).toBe(listening); // la primera línea
  const port = listening.port as number;
  expect(Number.isInteger(port) && port > 0).toBe(true);

  return {
    port,
    downloadDir,
    events,
    bad,
    command(cmd: object) {
      child.stdin!.write(JSON.stringify(cmd) + '\n');
    },
    waitEvent(pred: (e: HubLine) => boolean, what: string) {
      return waitUntil(() => events.find(pred), `${what}\nstderr: ${stderr}`);
    },
  };
}

async function startClient(port: number, opts: { localClip?: string } = {}) {
  const link = await connectNode(port);
  const sync = new ClipboardSync();
  const sinks: MemorySink[] = [];
  const clips: string[] = [];
  const transfers: TransferUpdate[] = [];
  let ready: PeerInfo | null = null;
  let closed: string | null = null;
  const session = new Session(link, {
    role: 'client',
    self: NODE,
    clipSyncFor: () => sync,
    getLocalClip: async () => opts.localClip ?? null,
    openSink: async (meta) => {
      const s = memorySink(meta.name);
      sinks.push(s);
      return s;
    },
    newTransferId: () => randomBytes(16).toString('hex'),
  });
  session.on('ready', (p) => (ready = p));
  session.on('clip', (t) => clips.push(t));
  session.on('transfer', (u) => transfers.push(u));
  session.on('closed', (r) => (closed = r));
  cleanups.push(async () => session.close());
  await session.start();
  const peer = await waitUntil(() => ready ?? undefined, 'ready en el cliente');
  return {
    session,
    peer,
    sync,
    sinks,
    clips,
    transfers,
    get closed() {
      return closed;
    },
    waitTransfer(id: string, state: string) {
      return waitUntil(
        () => transfers.find((u) => u.transferId === id && u.state === state),
        `transferencia ${id} en ${state} (vistas: ${JSON.stringify(transfers.filter((u) => u.transferId === id).map((u) => u.state))})`,
      );
    },
  };
}

test('saludo → peerConnected con deviceName "Node e2e"', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);

  const ev = await pc.waitEvent((e) => e.type === 'peerConnected', 'peerConnected');
  expect(ev).toMatchObject({ deviceId: 'node-e2e', deviceName: 'Node e2e', transport: 'usb' });
  expect(typeof ev.sessionId).toBe('number');
  expect(client.peer.deviceName.length).toBeGreaterThan(0);
  expect(client.closed).toBeNull();
  expect(pc.bad).toEqual([]);
});

test('clip cliente → ClipReceived; clip "cmd" del PC → evento clip en el cliente', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);

  expect(client.session.sendClip('hola desde node ✓')).toBe('send');
  const got = await pc.waitEvent((e) => e.type === 'clipReceived', 'clipReceived');
  expect(got.text).toBe('hola desde node ✓');

  // lo recibido no rebota: el PC ya lo tiene por sincronizado con este móvil
  pc.command({ cmd: 'clip', text: 'hola desde node ✓' });
  pc.command({ cmd: 'clip', text: 'hola desde el PC ✓' });
  await waitUntil(() => (client.clips.length > 0 ? true : undefined), 'clip en el cliente');
  expect(client.clips).toEqual(['hola desde el PC ✓']);
  expect(pc.events.filter((e) => e.type === 'clipReceived')).toHaveLength(1);
});

test('inicio con ambos cambiados: gana el cliente y el PC emite localClipSuperseded', async () => {
  const pc = await startHeadless({ localClip: 'pc' });
  const client = await startClient(pc.port, { localClip: 'móvil' });

  const sup = await pc.waitEvent((e) => e.type === 'localClipSuperseded', 'localClipSuperseded');
  expect(sup.text).toBe('pc');
  const got = await pc.waitEvent((e) => e.type === 'clipReceived', 'clipReceived');
  expect(got.text).toBe('móvil');

  // el texto del PC no cruza: lo siguiente que llega al cliente es lo nuevo
  pc.command({ cmd: 'clip', text: 'después' });
  await waitUntil(() => (client.clips.length > 0 ? true : undefined), 'clip después');
  expect(client.clips).toEqual(['después']);
});

test.each([0, 49152 * 3, 5 * 1024 * 1024 + 7])('archivo de %i bytes cliente → PC llega idéntico', async (n) => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);
  const data = new Uint8Array(randomBytes(n));

  const id = client.session.sendFile(memorySource(data, `datos-${n}.bin`));
  await client.waitTransfer(id, 'done');
  const ev = await pc.waitEvent(
    (e) => e.type === 'transfer' && e.transferId === id && e.state === 'done',
    `transfer ${id} done en el PC`,
  );
  expect(ev).toMatchObject({ direction: 'in', name: `datos-${n}.bin`, size: n, bytes: n });
  expect(ev.location).toBe(join(pc.downloadDir, `datos-${n}.bin`));
  const saved = new Uint8Array(await readFile(ev.location as string));
  expect(saved.length).toBe(n);
  expect(sha256Hex(saved)).toBe(sha256Hex(data));
});

test('archivo PC → cliente llega idéntico al memorySink', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);
  const n = 3 * 1024 * 1024 + 5; // más que la ventana: hacen falta los file_ack
  const data = new Uint8Array(randomBytes(n));
  const src = join(dirname(pc.downloadDir), 'origen.bin');
  await writeFile(src, data);

  pc.command({ cmd: 'file', path: src });
  const queued = await pc.waitEvent((e) => e.type === 'transfer' && e.state === 'queued', 'queued en el PC');
  const id = queued.transferId as string;
  expect(queued).toMatchObject({ direction: 'out', name: 'origen.bin', size: n });

  const done = await client.waitTransfer(id, 'done');
  expect(done).toMatchObject({ direction: 'in', name: 'origen.bin', size: n, bytes: n, location: 'mem://origen.bin' });
  await pc.waitEvent((e) => e.type === 'transfer' && e.transferId === id && e.state === 'done', 'done en el PC');
  expect(client.sinks).toHaveLength(1);
  const got = client.sinks[0].bytes();
  expect(got.length).toBe(n);
  expect(sha256Hex(got)).toBe(sha256Hex(data));
});

test('nombre "../../fuera.txt" se guarda como fuera.txt dentro de download-dir', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);
  const data = new TextEncoder().encode('no debería salir de la carpeta');

  const id = client.session.sendFile(memorySource(data, '../../fuera.txt', 'text/plain'));
  await client.waitTransfer(id, 'done');
  const ev = await pc.waitEvent(
    (e) => e.type === 'transfer' && e.transferId === id && e.state === 'done',
    'done en el PC',
  );
  const inside = join(pc.downloadDir, 'fuera.txt');
  expect(ev.location).toBe(inside);
  expect(new Uint8Array(await readFile(inside))).toEqual(data);
  // ../../ desde la carpeta de descargas es t<n>/; ahí no puede haber nada
  expect(existsSync(join(pc.downloadDir, '..', '..', 'fuera.txt'))).toBe(false);
});

/** Origen que entrega `open` bytes y se detiene hasta release(); el resto sale después. */
function gatedSource(n: number, open: number, name: string) {
  const data = new Uint8Array(randomBytes(n));
  const inner = memorySource(data, name);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let off = 0;
  const src = {
    ...inner,
    async read(max: number) {
      if (off >= open) await gate;
      const chunk = await inner.read(Math.min(max, off < open ? open - off : max));
      off += chunk.length;
      return chunk;
    },
    close: () => inner.close(),
  };
  cleanups.push(async () => release());
  return { src, release };
}

const MiB = 1024 * 1024;

/** Archivos que quedan en la carpeta (incluido cualquier `.part`). */
async function listDir(d: string): Promise<string[]> {
  return (await readdir(d)).sort();
}

test('cancelar a mitad un archivo cliente → PC: ambos cancelled y no queda el .part', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);
  const { src, release } = gatedSource(4 * MiB, 2 * MiB, 'grande.bin');

  const id = client.session.sendFile(src);
  // el PC ya escribió al menos 1 MiB en el .part
  await pc.waitEvent(
    (e) => e.type === 'transfer' && e.transferId === id && e.state === 'active' && (e.bytes as number) >= MiB,
    'active ≥ 1 MiB en el PC',
  );
  expect(await listDir(pc.downloadDir)).toEqual(['grande.bin.part']);

  client.session.cancelTransfer(id);
  release();
  await client.waitTransfer(id, 'cancelled');
  const ev = await pc.waitEvent(
    (e) => e.type === 'transfer' && e.transferId === id && e.state === 'cancelled',
    'cancelled en el PC',
  );
  expect(ev.error ?? null).toBeNull();
  await waitUntil(() => (existsSync(join(pc.downloadDir, 'grande.bin.part')) ? undefined : true), 'borrado del .part');
  expect(await listDir(pc.downloadDir)).toEqual([]);
  expect(client.closed).toBeNull(); // la sesión sigue viva
});

test('el cliente corta la conexión a mitad de un archivo: failed en ambos lados y sin .part', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);
  const { src } = gatedSource(4 * MiB, 2 * MiB, 'cortado.bin');

  const id = client.session.sendFile(src);
  await pc.waitEvent(
    (e) => e.type === 'transfer' && e.transferId === id && e.state === 'active' && (e.bytes as number) >= MiB,
    'active ≥ 1 MiB en el PC',
  );

  client.session.close();
  const mine = await client.waitTransfer(id, 'failed');
  expect(mine.error).toBe('closed');
  const ev = await pc.waitEvent(
    (e) => e.type === 'transfer' && e.transferId === id && e.state === 'failed',
    'failed en el PC',
  );
  expect(ev.error).toBe('link_closed');
  const gone = await pc.waitEvent((e) => e.type === 'peerDisconnected', 'peerDisconnected');
  expect(gone.reason).toBe('link_closed');
  await waitUntil(() => (existsSync(join(pc.downloadDir, 'cortado.bin.part')) ? undefined : true), 'borrado del .part');
  expect(await listDir(pc.downloadDir)).toEqual([]);
});

test('texto con un sustituto suelto: el PC recibe U+FFFD y la sesión sigue abierta', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);

  expect(client.session.sendClip('roto \ud800 aquí')).toBe('send');
  const got = await pc.waitEvent((e) => e.type === 'clipReceived', 'clipReceived');
  expect(got.text).toBe('roto \ufffd aquí');
  expect(client.session.sendClip('después')).toBe('send');
  await pc.waitEvent((e) => e.type === 'clipReceived' && e.text === 'después', 'segundo clipReceived');
  expect(client.closed).toBeNull();
  expect(pc.events.some((e) => e.type === 'peerDisconnected')).toBe(false);
});

test('el pong del PC confirma el clip enviado (R29)', async () => {
  const pc = await startHeadless();
  const client = await startClient(pc.port);

  expect(client.session.sendClip('confirmado')).toBe('send');
  await waitUntil(
    () => (client.sync.lastConfirmedHash === sha256Hex('confirmado') ? true : undefined),
    'confirmación del clip',
  );
  await pc.waitEvent((e) => e.type === 'clipReceived' && e.text === 'confirmado', 'clipReceived');
});
