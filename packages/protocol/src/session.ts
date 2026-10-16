import { ClipboardSync, type ClipDecision } from './clipSync';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, MAX_CLIP_BYTES, PROTOCOL_VERSION } from './constants';
import { FrameDecoder, encodeFrame } from './framing';
import { sha256Hex } from './hash';
import {
  MessageDecoder,
  ProtocolError,
  encodeControl,
  type ClipMsg,
  type ControlMessage,
  type DecodedMessage,
  type HelloMsg,
} from './messages';

/** Flujo de bytes fiable (TCP, USB…); la sesión le aplica el framing. */
export interface Link {
  write(bytes: Uint8Array): void;
  close(): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (error?: Error) => void): void;
}

/** Inyectable para las pruebas; solo hace falta un intervalo. */
export interface Timers {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  now(): number;
}

export interface PeerInfo {
  deviceId: string;
  deviceName: string;
}

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

export interface FileSource extends FileMeta {
  /** Devuelve hasta maxBytes; un trozo vacío indica el final. */
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface FileSink {
  write(bytes: Uint8Array): Promise<void>;
  /** Cierra el archivo y devuelve dónde quedó guardado. */
  finish(): Promise<string>;
  /** Descarta el parcial. */
  abort(): Promise<void>;
}

export type TransferState = 'queued' | 'active' | 'done' | 'failed' | 'cancelled';

export interface TransferUpdate {
  transferId: string;
  direction: 'in' | 'out';
  name: string;
  size: number;
  bytes: number;
  state: TransferState;
  error?: string;
  location?: string;
}

export interface SessionOptions {
  role: 'client' | 'server';
  self: PeerInfo;
  /**
   * ClipboardSync con el que se compara y marca lo sincronizado con este par.
   * - Cliente: se llama con `null` en `start()`, antes de enviar su `hello`, para calcular
   *   `willSendClip` (aún no conoce al servidor; el móvil devuelve una única instancia).
   * - Servidor: se llama con los datos del cliente al recibir su `hello`.
   */
  clipSyncFor(peer: PeerInfo | null): ClipboardSync;
  getLocalClip(): Promise<string | null>;
  openSink(meta: FileMeta): Promise<FileSink>;
  /** 32 caracteres hex; también sirve de `id` para los `clip`. */
  newTransferId(): string;
  /** Por defecto, los temporizadores globales y Date.now. */
  timers?: Timers;
}

export type SessionEvents = {
  ready: (peer: PeerInfo) => void;
  /** Texto recibido, ya marcado como sincronizado. */
  clip: (text: string) => void;
  /** El texto local del servidor pierde frente al del cliente al empezar la sesión. */
  localClipSuperseded: (text: string) => void;
  transfer: (update: TransferUpdate) => void;
  closed: (reason: string) => void;
};

type Listeners = { [E in keyof SessionEvents]: SessionEvents[E][] };

const defaultTimers: Timers = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/**
 * Sesión del protocolo v2 sobre un enlace, independiente del transporte.
 * Los mensajes entrantes se atienden en orden, de uno en uno, aunque su manejo sea asíncrono.
 */
export class Session {
  private readonly timers: Timers;
  private readonly frames = new FrameDecoder();
  private readonly messages = new MessageDecoder();
  private readonly listeners: Listeners = { ready: [], clip: [], localClipSuperseded: [], transfer: [], closed: [] };

  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  private helloReceived = false;
  private ready = false;
  private remote: PeerInfo | null = null;
  private sync: ClipboardSync | null = null;
  /** Cliente: texto anunciado con willSendClip, que se envía al llegar el hello del servidor. */
  private startClip: string | null = null;
  private heartbeat: unknown = null;
  private lastRx = 0;

  constructor(
    private readonly link: Link,
    private readonly opts: SessionOptions,
  ) {
    this.timers = opts.timers ?? defaultTimers;
  }

  on<E extends keyof SessionEvents>(event: E, cb: SessionEvents[E]): () => void {
    const list = this.listeners[event] as SessionEvents[E][];
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  get peer(): PeerInfo | null {
    return this.remote;
  }

  start(): Promise<void> {
    if (this.started) throw new Error('La sesión ya se inició');
    this.started = true;

    this.link.onData((bytes) => this.onData(bytes));
    this.link.onClose(() => this.close('link_closed'));
    // el plazo del latido cuenta desde ya, también durante el saludo
    this.lastRx = this.timers.now();
    this.heartbeat = this.timers.setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);

    if (this.opts.role === 'client') return this.enqueue(() => this.sendClientHello());
    return Promise.resolve();
  }

  /**
   * 'send' significa que se ha enviado; el resto, que no hacía falta o no se puede.
   * Lanza si la sesión aún no está lista (antes de `ready`) o ya se cerró.
   */
  sendClip(text: string): ClipDecision {
    if (this.closed || !this.ready || !this.sync) throw new Error('La sesión no está lista');
    const decision = this.sync.check(text);
    if (decision === 'send') {
      this.send({ kind: 'clip', id: this.opts.newTransferId(), text, hash: sha256Hex(text) });
      this.sync.markSynced(text);
    }
    return decision;
  }

  sendFile(_src: FileSource): string {
    throw new Error('not implemented');
  }

  cancelTransfer(_transferId: string): void {
    throw new Error('not implemented');
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    try {
      this.link.close();
    } catch {
      // el enlace ya estaba cerrado
    }
    this.emit('closed', reason);
  }

  // --- entrada ---

  private onData(bytes: Uint8Array): void {
    if (this.closed) return;
    this.lastRx = this.timers.now();
    for (const frame of this.frames.push(bytes)) {
      let decoded: DecodedMessage | null;
      try {
        decoded = this.messages.push(frame);
      } catch (e) {
        this.fail(e);
        return;
      }
      if (decoded) {
        const m = decoded;
        void this.enqueue(() => this.dispatch(m));
      }
    }
  }

  /** Encadena una tarea; cualquier error cierra la sesión. */
  private enqueue(task: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(() => (this.closed ? undefined : task()))
      .catch((e) => this.fail(e));
    return this.queue;
  }

  private fail(e: unknown): void {
    this.close(e instanceof ProtocolError ? 'protocol_error' : 'internal_error');
  }

  private dispatch(m: DecodedMessage): void | Promise<void> {
    if (m.type === 'data') {
      if (!this.ready) throw new ProtocolError('datos de archivo antes del saludo');
      return this.onFileData(m.transferId, m.bytes);
    }
    const msg = m.msg;
    if (!this.helloReceived) {
      if (msg.kind !== 'hello') throw new ProtocolError(`'${msg.kind}' antes del hello`);
      this.helloReceived = true;
      return this.opts.role === 'server' ? this.onClientHello(msg) : this.onServerHello(msg);
    }
    switch (msg.kind) {
      case 'hello':
        throw new ProtocolError('hello repetido');
      case 'ping':
        this.send({ kind: 'pong' });
        return;
      case 'pong':
        return; // basta con haber recibido tráfico
      case 'clip':
        return this.onClip(msg);
      default:
        return this.onFileControl(msg);
    }
  }

  // --- saludo y regla de inicio (spec §3.5) ---

  private async sendClientHello(): Promise<void> {
    this.sync = this.opts.clipSyncFor(null);
    const local = await this.opts.getLocalClip();
    const willSendClip = local !== null && this.sync.check(local) === 'send';
    if (willSendClip) this.startClip = local;
    this.send({ kind: 'hello', v: PROTOCOL_VERSION, ...this.self(), willSendClip });
  }

  private onServerHello(msg: HelloMsg): void {
    this.becomeReady(msg);
    const text = this.startClip;
    this.startClip = null;
    if (text !== null) this.sendClip(text);
  }

  private async onClientHello(msg: HelloMsg): Promise<void> {
    const peer = { deviceId: msg.deviceId, deviceName: msg.deviceName };
    const sync = (this.sync = this.opts.clipSyncFor(peer));
    this.send({ kind: 'hello', v: PROTOCOL_VERSION, ...this.self() });
    this.becomeReady(msg);

    // la cola espera a esto, así que el clip del cliente aún no se ha procesado
    const local = await this.opts.getLocalClip();
    if (this.closed || local === null || sync.check(local) !== 'send') return;
    if (msg.willSendClip) this.emit('localClipSuperseded', local); // gana el móvil
    else this.sendClip(local);
  }

  private becomeReady(msg: HelloMsg): void {
    this.remote = { deviceId: msg.deviceId, deviceName: msg.deviceName };
    this.ready = true;
    this.emit('ready', this.remote);
  }

  private self(): PeerInfo {
    return { deviceId: this.opts.self.deviceId, deviceName: this.opts.self.deviceName };
  }

  // --- portapapeles ---

  private onClip(msg: ClipMsg): void {
    if (new TextEncoder().encode(msg.text).length > MAX_CLIP_BYTES) {
      throw new ProtocolError(`clip de más de ${MAX_CLIP_BYTES} bytes`);
    }
    if (sha256Hex(msg.text) !== msg.hash) throw new ProtocolError('el hash del clip no corresponde al texto');
    this.sync!.markSynced(msg.text);
    this.emit('clip', msg.text);
  }

  // --- archivos (Tarea 5) ---

  private onFileControl(msg: ControlMessage): void | Promise<void> {
    throw new ProtocolError(`'${msg.kind}' aún no está soportado`);
  }

  private onFileData(_transferId: string, _bytes: Uint8Array): void | Promise<void> {
    throw new ProtocolError('datos de archivo aún no soportados');
  }

  // --- latido ---

  private tick(): void {
    if (this.closed) return;
    if (this.timers.now() - this.lastRx >= HEARTBEAT_TIMEOUT_MS) this.close('heartbeat_timeout');
    else if (this.ready) this.send({ kind: 'ping' });
  }

  // --- salida ---

  private send(msg: ControlMessage): void {
    if (this.closed) return;
    try {
      for (const payload of encodeControl(msg)) this.link.write(encodeFrame(payload));
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      this.close('link_closed'); // fallo de escritura: el enlace está caído
    }
  }

  private emit<E extends keyof SessionEvents>(event: E, ...args: Parameters<SessionEvents[E]>): void {
    for (const cb of [...this.listeners[event]]) {
      try {
        (cb as (...a: Parameters<SessionEvents[E]>) => void)(...args);
      } catch (e) {
        // un oyente que falla no debe tumbar la sesión; el error se relanza aparte
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }
}
