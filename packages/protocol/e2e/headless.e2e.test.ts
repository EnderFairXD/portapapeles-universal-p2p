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
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  ClipboardSync,
  Session,
  generateKeyPair,
  sha256Hex,
  type FileMeta,
  type KeyPair,
  type PeerInfo,
  type TransferUpdate,
} from '../src/index';
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

/** Carpeta de datos (identidad y emparejados) del PC; no cuelga de la de descargas. */
async function freshDataDir(): Promise<string> {
  const d = join(base, `t${++dirs}`, 'datos');
  await mkdir(d, { recursive: true });
  return d;
}

async function startHeadless(opts: { localClip?: string; dataDir?: string } = {}) {
  const downloadDir = await freshDir();
  const imageDir = join(dirname(downloadDir), 'imagenes');
  const dataDir = opts.dataDir ?? (await freshDataDir());
  const args = ['--download-dir', downloadDir, '--image-dir', imageDir, '--data-dir', dataDir];
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
  const publicKeyHex = listening.publicKey as string;
  expect(publicKeyHex).toMatch(/^[0-9a-f]{64}$/);

  const command = (cmd: object) => {
    child.stdin!.write(JSON.stringify(cmd) + '\n');
  };

  return {
    port,
    downloadDir,
    imageDir,
    dataDir,
    /** Clave pública del PC en hex minúscula y en bytes (lo que el móvil lee del QR). */
    publicKeyHex,
    serverKey: hexToBytes(publicKeyHex),
    events,
    bad,
    command,
    /** Abre una ventana de emparejamiento y devuelve el token de la línea `pairing`. */
    async pair(): Promise<string> {
      const before = events.filter((e) => e.type === 'pairing').length;
      command({ cmd: 'pair' });
      const line = await waitUntil(
        () => events.filter((e) => e.type === 'pairing')[before],
        `línea pairing\nstderr: ${stderr}`,
      );
      expect(line.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(typeof line.expiresAtMs).toBe('number');
      return line.token as string;
    },
    /** Mata el proceso (SIGKILL) y espera a que salga. */
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
    waitEvent(pred: (e: HubLine) => boolean, what: string) {
      return waitUntil(() => events.find(pred), `${what}\nstderr: ${stderr}`);
    },
  };
}

interface ClientOptions {
  localClip?: string;
  identity?: KeyPair;
  /** Clave del PC; por defecto, la del PC real. */
  serverKey: Uint8Array;
  pairingToken?: string | null;
}

/** Abre la conexión y arranca la sesión, sin esperar a `ready`. */
async function connectClient(port: number, opts: ClientOptions) {
  const link = await connectNode(port);
  const sync = new ClipboardSync();
  const sinks: MemorySink[] = [];
  const metas: FileMeta[] = [];
  const clips: string[] = [];
  const transfers: TransferUpdate[] = [];
  const identity = opts.identity ?? generateKeyPair();
  let ready: PeerInfo | null = null;
  let closed: string | null = null;
  const session = new Session(link, {
    role: 'client',
    self: NODE,
    identity,
    serverKey: opts.serverKey,
    pairingToken: opts.pairingToken,
    clipSyncFor: () => sync,
    getLocalClip: async () => opts.localClip ?? null,
    openSink: async (meta) => {
      metas.push(meta);
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
  return {
    session,
    identity,
    identityHex: bytesToHex(identity.publicKey),
    sync,
    sinks,
    metas,
    clips,
    transfers,
    get ready() {
      return ready;
    },
    get closed() {
      return closed;
    },
    waitReady() {
      return waitUntil(() => ready ?? undefined, 'ready en el cliente');
    },
    waitClosed() {
      return waitUntil(() => closed ?? undefined, 'closed en el cliente');
    },
    waitTransfer(id: string, state: string) {
      return waitUntil(
        () => transfers.find((u) => u.transferId === id && u.state === state),
        `transferencia ${id} en ${state} (vistas: ${JSON.stringify(transfers.filter((u) => u.transferId === id).map((u) => u.state))})`,
      );
    },
  };
}

type PC = Awaited<ReturnType<typeof startHeadless>>;

/** Empareja un cliente nuevo (orden `pair` + `pairingToken`) y lo devuelve ya listo. */
async function pairedSession(pc: PC, local?: string) {
  const token = await pc.pair();
  const client = await connectClient(pc.port, {
    localClip: local,
    serverKey: pc.serverKey,
    pairingToken: token,
  });
  const peer = await client.waitReady();
  return { ...client, peer };
}

test('saludo → peerConnected con deviceName "Node e2e" y la clave del cliente como deviceId', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);

  const ev = await pc.waitEvent((e) => e.type === 'peerConnected', 'peerConnected');
  expect(ev).toMatchObject({ deviceId: client.identityHex, deviceName: 'Node e2e', transport: 'usb' });
  expect(typeof ev.sessionId).toBe('number');
  expect(client.peer.deviceName.length).toBeGreaterThan(0);
  expect(client.closed).toBeNull();
  expect(pc.bad).toEqual([]);
});

test('clip cliente → ClipReceived; clip "cmd" del PC → evento clip en el cliente', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);

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
  const client = await pairedSession(pc, 'móvil');

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
  const client = await pairedSession(pc);
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
  const client = await pairedSession(pc);
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
  const client = await pairedSession(pc);
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
  const client = await pairedSession(pc);
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
  const client = await pairedSession(pc);
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
  const client = await pairedSession(pc);

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
  const client = await pairedSession(pc);

  expect(client.session.sendClip('confirmado')).toBe('send');
  await waitUntil(
    () => (client.sync.lastConfirmedHash === sha256Hex('confirmado') ? true : undefined),
    'confirmación del clip',
  );
  await pc.waitEvent((e) => e.type === 'clipReceived' && e.text === 'confirmado', 'clipReceived');
});

// --- emparejamiento y cifrado (fase 2) ---

test('emparejar: ready, devicePaired con el deviceName y peerConnected con la clave del cliente en hex', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);

  expect(client.peer.deviceName.length).toBeGreaterThan(0);
  expect(client.closed).toBeNull();
  const paired = await pc.waitEvent((e) => e.type === 'devicePaired', 'devicePaired');
  expect(paired).toEqual({ type: 'devicePaired', deviceKey: client.identityHex, deviceName: 'Node e2e' });
  const conn = await pc.waitEvent((e) => e.type === 'peerConnected', 'peerConnected');
  expect(conn).toMatchObject({ deviceId: client.identityHex, deviceName: 'Node e2e' });
  expect(conn.deviceId).toMatch(/^[0-9a-f]{64}$/);
  // el emparejamiento se anuncia antes de la conexión
  expect(pc.events.indexOf(paired)).toBeLessThan(pc.events.indexOf(conn));
  expect(existsSync(join(pc.dataDir, 'identity.key'))).toBe(true);
  expect(existsSync(join(pc.dataDir, 'paired.json'))).toBe(true);
  expect(pc.bad).toEqual([]);
});

test('reconexión sin token tras emparejar → ready', async () => {
  const pc = await startHeadless();
  const first = await pairedSession(pc);
  first.session.close();
  await pc.waitEvent((e) => e.type === 'peerDisconnected', 'peerDisconnected del primero');

  const again = await connectClient(pc.port, { identity: first.identity, serverKey: pc.serverKey });
  await again.waitReady();
  expect(again.closed).toBeNull();
  await waitUntil(
    () => (pc.events.filter((e) => e.type === 'peerConnected').length === 2 ? true : undefined),
    'segundo peerConnected',
  );
  // ya estaba emparejado: no hay un segundo devicePaired
  expect(pc.events.filter((e) => e.type === 'devicePaired')).toHaveLength(1);
});

test('cliente no emparejado sin token → closed "not_paired" y ningún peerConnected', async () => {
  const pc = await startHeadless();
  const client = await connectClient(pc.port, { serverKey: pc.serverKey });

  expect(await client.waitClosed()).toBe('not_paired');
  expect(client.ready).toBeNull();
  await new Promise((r) => setTimeout(r, 200));
  expect(pc.events.some((e) => e.type === 'peerConnected' || e.type === 'devicePaired')).toBe(false);
});

test('el mismo token en un segundo cliente → "pairing_expired"', async () => {
  const pc = await startHeadless();
  const token = await pc.pair();
  const first = await connectClient(pc.port, { serverKey: pc.serverKey, pairingToken: token });
  await first.waitReady();

  const second = await connectClient(pc.port, { serverKey: pc.serverKey, pairingToken: token });
  expect(await second.waitClosed()).toBe('pairing_expired');
  expect(second.ready).toBeNull();
  await new Promise((r) => setTimeout(r, 200));
  expect(pc.events.filter((e) => e.type === 'devicePaired')).toHaveLength(1);
  expect(pc.events.filter((e) => e.type === 'peerConnected')).toHaveLength(1);
});

test('clave del PC equivocada → closed "handshake_failed"', async () => {
  const pc = await startHeadless();
  const token = await pc.pair();
  const client = await connectClient(pc.port, {
    serverKey: generateKeyPair().publicKey,
    pairingToken: token,
  });

  expect(await client.waitClosed()).toBe('handshake_failed');
  expect(client.ready).toBeNull();
  await new Promise((r) => setTimeout(r, 200));
  expect(pc.events.some((e) => e.type === 'peerConnected' || e.type === 'devicePaired')).toBe(false);
});

test('forget → peerDisconnected "forgotten" y la reconexión da "not_paired"', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);

  pc.command({ cmd: 'forget', deviceKey: client.identityHex });
  const gone = await pc.waitEvent((e) => e.type === 'peerDisconnected', 'peerDisconnected');
  expect(gone.reason).toBe('forgotten');
  await client.waitClosed();

  const again = await connectClient(pc.port, { identity: client.identity, serverKey: pc.serverKey });
  expect(await again.waitClosed()).toBe('not_paired');
  expect(pc.events.filter((e) => e.type === 'peerConnected')).toHaveLength(1);
});

test('reiniciar headless con el mismo --data-dir conserva publicKey y emparejados', async () => {
  const first = await startHeadless();
  const client = await pairedSession(first);
  await first.kill();
  await client.waitClosed();

  const second = await startHeadless({ dataDir: first.dataDir });
  expect(second.publicKeyHex).toBe(first.publicKeyHex);
  const again = await connectClient(second.port, { identity: client.identity, serverKey: second.serverKey });
  await again.waitReady();
  expect(again.closed).toBeNull();
  const conn = await second.waitEvent((e) => e.type === 'peerConnected', 'peerConnected tras reiniciar');
  expect(conn.deviceId).toBe(client.identityHex);
  expect(second.events.some((e) => e.type === 'devicePaired')).toBe(false);
});

// --- imágenes del portapapeles (fase 2b) ---

/** PNG de prueba: cabecera real y relleno aleatorio (el protocolo no valida el contenido). */
function fakePng(n: number): Uint8Array {
  const png = new Uint8Array(randomBytes(n));
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return png;
}

test('imagen de 3 MiB cliente → PC con purpose clipboard: clipImageReceived y archivo idéntico en image-dir', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);
  const png = fakePng(3 * MiB);

  const id = client.session.sendFile({ ...memorySource(png, 'captura.png', 'image/png'), purpose: 'clipboard' });
  const mine = await client.waitTransfer(id, 'done');
  expect(mine.purpose).toBe('clipboard');
  const ev = await pc.waitEvent((e) => e.type === 'clipImageReceived', 'clipImageReceived');
  const conn = await pc.waitEvent((e) => e.type === 'peerConnected', 'peerConnected');
  expect(ev.sessionId).toBe(conn.sessionId);
  expect(ev.location).toBe(join(pc.imageDir, 'captura.png'));
  const saved = new Uint8Array(await readFile(ev.location as string));
  expect(saved.length).toBe(png.length);
  expect(sha256Hex(saved)).toBe(sha256Hex(png));
  // el progreso del PC también lleva el purpose, y la imagen no cae en Descargas
  const done = await pc.waitEvent((e) => e.type === 'transfer' && e.transferId === id && e.state === 'done', 'done en el PC');
  expect(done).toMatchObject({ direction: 'in', purpose: 'clipboard' });
  expect(await listDir(pc.downloadDir)).toEqual([]);
  expect(pc.bad).toEqual([]);
});

test('imagen del PC (cmd image) → el memorySink del cliente la recibe con purpose clipboard', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);
  const png = fakePng(3 * MiB + 5);
  const src = join(dirname(pc.downloadDir), 'copia.png');
  await writeFile(src, png);

  pc.command({ cmd: 'image', path: src, hash: sha256Hex(png) });
  const queued = await pc.waitEvent((e) => e.type === 'transfer' && e.state === 'queued', 'queued en el PC');
  expect(queued).toMatchObject({ direction: 'out', name: 'copia.png', size: png.length, purpose: 'clipboard' });
  const id = queued.transferId as string;

  const done = await client.waitTransfer(id, 'done');
  expect(done).toMatchObject({ direction: 'in', name: 'copia.png', size: png.length, purpose: 'clipboard' });
  expect(client.metas).toHaveLength(1);
  expect(client.metas[0]).toMatchObject({ name: 'copia.png', mime: 'image/png', purpose: 'clipboard' });
  expect(sha256Hex(client.sinks[0].bytes())).toBe(sha256Hex(png));
  await pc.waitEvent((e) => e.type === 'transfer' && e.transferId === id && e.state === 'done', 'done en el PC');
});

test('imagen local del PC antes de conectar: se envía al iniciar la sesión', async () => {
  const pc = await startHeadless();
  const png = fakePng(200_000);
  const src = join(dirname(pc.downloadDir), 'inicial.png');
  await writeFile(src, png);
  pc.command({ cmd: 'image', path: src, hash: sha256Hex(png) });

  const client = await pairedSession(pc);
  await waitUntil(() => client.transfers.find((u) => u.state === 'done'), 'imagen de inicio en el cliente');
  expect(client.metas[0]).toMatchObject({ name: 'inicial.png', mime: 'image/png', purpose: 'clipboard' });
  expect(sha256Hex(client.sinks[0].bytes())).toBe(sha256Hex(png));
});

test('20 MiB + 1 con purpose clipboard: RangeError en el cliente y no sale nada', async () => {
  const pc = await startHeadless();
  const client = await pairedSession(pc);
  const big = new Uint8Array(20 * MiB + 1);

  expect(() =>
    client.session.sendFile({ ...memorySource(big, 'enorme.png', 'image/png'), purpose: 'clipboard' }),
  ).toThrow(RangeError);
  expect(client.transfers).toEqual([]);

  // el ping/pong del clip hace de barrera: si algo hubiera salido, ya habría llegado
  expect(client.session.sendClip('barrera')).toBe('send');
  await pc.waitEvent((e) => e.type === 'clipReceived' && e.text === 'barrera', 'clipReceived');
  expect(pc.events.some((e) => e.type === 'transfer' || e.type === 'clipImageReceived')).toBe(false);
  expect(existsSync(pc.imageDir) ? await listDir(pc.imageDir) : []).toEqual([]);
  expect(client.closed).toBeNull();
});
