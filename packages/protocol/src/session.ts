import { ClipboardSync, type ClipDecision } from './clipSync';
import {
  FILE_ACK_EVERY_BYTES,
  FILE_CHUNK_BYTES,
  FILE_WINDOW_BYTES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CLIP_BYTES,
  PROTOCOL_VERSION,
} from './constants';
import { FrameDecoder, encodeFrame } from './framing';
import { createSha256, sha256Hex } from './hash';
import {
  MessageDecoder,
  ProtocolError,
  encodeControl,
  encodeFileData,
  type ClipMsg,
  type ControlMessage,
  type DecodedMessage,
  type FileAckMsg,
  type FileCancelMsg,
  type FileEndMsg,
  type FileResultMsg,
  type FileStartMsg,
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
  /**
   * Descarta el parcial. La sesión nunca lo llama a la vez que otra operación del sink, pero
   * puede llamarlo después de finish() si la sesión cae antes de confirmar: entonces borra el archivo.
   */
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

/** Motivo de file_cancel cuando lo pide el usuario; cualquier otro motivo es un fallo. */
const CANCEL_REASON = 'cancelled';

/** Archivo saliente: en cola o activo (solo uno activo a la vez). */
interface OutTransfer {
  id: string;
  src: FileSource;
  sent: number;
  acked: number;
  /** file_end enviado: ya solo falta file_result y no se puede cancelar */
  endSent: boolean;
  ended: boolean;
  /** despierta al emisor (ack, resultado o fin) */
  wake: (() => void) | null;
}

/** Archivo entrante activo. */
interface InTransfer {
  id: string;
  meta: FileMeta;
  received: number;
  hash: ReturnType<typeof createSha256>;
  sink: FileSink | null;
  /** cadena de operaciones del sink, para no solaparlas nunca */
  io: Promise<unknown>;
  /** file_end en proceso: ya no se puede cancelar */
  ending: boolean;
  ended: boolean;
}

const ignore = () => {};

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

  private outQueue: OutTransfer[] = [];
  private out: OutTransfer | null = null;
  private inc: InTransfer | null = null;
  /** transferId entrantes ya terminados: sus datos rezagados se descartan */
  private readonly endedIn = new Set<string>();

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
    // tras procesar lo que ya llegó, como haría un bucle de lectura sobre TCP
    this.link.onClose(() => void this.enqueue(() => this.close('link_closed')));
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
    if (this.closed || !this.ready) throw new Error('La sesión no está lista');
    return this.pushClip(text);
  }

  /**
   * Pone un archivo en la cola de salida y devuelve su transferId. Se emite 'queued' al momento;
   * si no hay otro en curso, también 'active'. Lanza si la sesión no está lista o ya se cerró.
   */
  sendFile(src: FileSource): string {
    if (this.closed || !this.ready) throw new Error('La sesión no está lista');
    if (!Number.isSafeInteger(src.size) || src.size < 0) throw new RangeError('Tamaño de archivo inválido');
    const t: OutTransfer = {
      id: this.opts.newTransferId(),
      src,
      sent: 0,
      acked: 0,
      endSent: false,
      ended: false,
      wake: null,
    };
    this.outQueue.push(t);
    this.emitOut(t, 'queued');
    this.pumpOut();
    return t.id;
  }

  /** Cancela un archivo en cola o en curso, en cualquier sentido; si no existe o ya acabó, no hace nada. */
  cancelTransfer(transferId: string): void {
    if (this.closed) return;
    const i = this.outQueue.findIndex((t) => t.id === transferId);
    if (i >= 0) {
      // aún no empezó: el otro lado no sabe nada de él
      const [t] = this.outQueue.splice(i, 1);
      t.ended = true;
      this.emitOut(t, 'cancelled');
      void t.src.close().catch(ignore);
      return;
    }
    const out = this.out;
    if (out && out.id === transferId && !out.endSent) {
      this.endOut(out, 'cancelled', undefined, CANCEL_REASON);
      return;
    }
    const inc = this.inc;
    if (inc && inc.id === transferId && !inc.ending) {
      this.endIn(inc, 'cancelled', { cancel: CANCEL_REASON, abort: true });
    }
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
    // las transferencias terminan antes de avisar del cierre
    if (this.out) this.endOut(this.out, 'failed', reason);
    for (const t of this.outQueue.splice(0)) {
      t.ended = true;
      this.emitOut(t, 'failed', reason);
      void t.src.close().catch(ignore);
    }
    if (this.inc) this.endIn(this.inc, 'failed', { error: reason, abort: true });
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
    // se anuncia solo lo que de verdad se podrá enviar (también si no cabe al codificarlo)
    const willSendClip = local !== null && this.prepareClip(local).decision === 'send';
    if (willSendClip) this.startClip = local;
    this.send({ kind: 'hello', v: PROTOCOL_VERSION, ...this.self(), willSendClip });
  }

  private onServerHello(msg: HelloMsg): void {
    const text = this.startClip;
    this.startClip = null;
    if (text !== null) this.pushClip(text); // antes de ready, igual que el servidor
    if (this.closed) return; // falló la escritura del clip
    this.becomeReady(msg);
  }

  private async onClientHello(msg: HelloMsg): Promise<void> {
    const peer = { deviceId: msg.deviceId, deviceName: msg.deviceName };
    const sync = (this.sync = this.opts.clipSyncFor(peer));
    this.send({ kind: 'hello', v: PROTOCOL_VERSION, ...this.self() });

    // La regla se resuelve antes de ready: hasta entonces la app no puede llamar a sendClip.
    // La cola espera a esto, así que el clip del cliente aún no se ha procesado.
    const local = await this.opts.getLocalClip();
    if (this.closed) return;
    let superseded: string | null = null;
    if (local !== null) {
      if (!msg.willSendClip) this.pushClip(local);
      else if (this.prepareClip(local).decision === 'send') {
        // gana el móvil: el texto del PC se da por tratado para que no salga después y cruce
        sync.markSynced(local);
        superseded = local;
      }
    }
    if (this.closed) return; // falló la escritura del clip
    this.becomeReady(msg);
    if (this.closed) return; // la app cerró desde ready
    if (superseded !== null) this.emit('localClipSuperseded', superseded);
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

  /** Decide si un texto se envía; si su JSON no cabe en un mensaje de control, es 'too_large'. */
  private prepareClip(text: string): { decision: ClipDecision; frames?: Uint8Array[] } {
    const decision = this.sync!.check(text);
    if (decision !== 'send') return { decision };
    try {
      const frames = encodeControl({ kind: 'clip', id: this.opts.newTransferId(), text, hash: sha256Hex(text) });
      return { decision, frames };
    } catch (e) {
      if (e instanceof ProtocolError) return { decision: 'too_large' }; // p. ej. 1 MiB de comillas
      throw e;
    }
  }

  /** Único camino de salida de un clip, para el arranque y para sendClip. */
  private pushClip(text: string): ClipDecision {
    const { decision, frames } = this.prepareClip(text);
    if (decision !== 'send') return decision;
    this.write(frames!);
    this.sync!.markSynced(text);
    return decision;
  }

  private onClip(msg: ClipMsg): void {
    if (new TextEncoder().encode(msg.text).length > MAX_CLIP_BYTES) {
      throw new ProtocolError(`clip de más de ${MAX_CLIP_BYTES} bytes`);
    }
    if (sha256Hex(msg.text) !== msg.hash) throw new ProtocolError('el hash del clip no corresponde al texto');
    this.sync!.markSynced(msg.text);
    this.emit('clip', msg.text);
  }

  // --- archivos: control ---

  private onFileControl(msg: ControlMessage): void | Promise<void> {
    switch (msg.kind) {
      case 'file_start':
        return this.onFileStart(msg);
      case 'file_end':
        return this.onFileEnd(msg);
      case 'file_ack':
        return this.onFileAck(msg);
      case 'file_result':
        return this.onFileResult(msg);
      case 'file_cancel':
        return this.onFileCancel(msg);
      default:
        throw new ProtocolError(`'${msg.kind}' inesperado`);
    }
  }

  /** Un file_cancel del otro lado: 'cancelled' si lo pidió el usuario; si no, fallo con ese motivo. */
  private onFileCancel(msg: FileCancelMsg): void {
    const cancelled = msg.reason === CANCEL_REASON;
    const state = cancelled ? 'cancelled' : 'failed';
    const error = cancelled ? undefined : msg.reason;
    const out = this.out;
    if (out && out.id === msg.transferId && !out.ended) {
      this.endOut(out, state, error);
      return;
    }
    const inc = this.inc;
    if (inc && inc.id === msg.transferId) this.endIn(inc, state, { error, abort: true });
    // si no, ya terminó aquí (los dos cancelaron a la vez): se ignora
  }

  // --- archivos: emisor ---

  private pumpOut(): void {
    if (this.closed || this.out) return;
    const t = this.outQueue.shift();
    if (!t) return;
    this.out = t;
    void this.runOut(t)
      .catch(() => this.endOut(t, 'failed', 'internal_error', 'internal_error'))
      .then(() => t.src.close())
      .catch(ignore)
      .then(() => {
        this.out = null;
        this.pumpOut();
      });
  }

  private async runOut(t: OutTransfer): Promise<void> {
    const { name, size, mime } = t.src;
    this.emitOut(t, 'active');
    this.send({ kind: 'file_start', transferId: t.id, name, size, mime });
    const hash = createSha256();
    for (;;) {
      let chunk: Uint8Array;
      try {
        chunk = await t.src.read(FILE_CHUNK_BYTES);
      } catch {
        this.endOut(t, 'failed', 'read_error', 'read_error');
        return;
      }
      if (t.ended) return;
      if (chunk.length === 0) break;
      if (t.sent + chunk.length > size) {
        // el archivo creció mientras se enviaba: nunca se manda más de lo anunciado
        this.endOut(t, 'failed', 'size_mismatch', 'size_mismatch');
        return;
      }
      // el trozo sale solo si cabe entero en la ventana (como mucho uno leído de más en memoria)
      while (!t.ended && t.sent - t.acked + chunk.length > FILE_WINDOW_BYTES) await this.waitOut(t);
      if (t.ended) return;
      hash.update(chunk);
      t.sent += chunk.length;
      this.write([encodeFileData(t.id, chunk)]);
    }
    if (t.sent !== size) {
      this.endOut(t, 'failed', 'size_mismatch', 'size_mismatch');
      return;
    }
    t.endSent = true;
    this.send({ kind: 'file_end', transferId: t.id, sha256: hash.digestHex() });
    while (!t.ended) await this.waitOut(t); // hasta file_result, file_cancel o cierre
  }

  private waitOut(t: OutTransfer): Promise<void> {
    return new Promise((resolve) => (t.wake = resolve));
  }

  private onFileAck(msg: FileAckMsg): void {
    const t = this.out;
    if (!t || t.id !== msg.transferId || t.ended) return; // rezagado
    if (msg.received > t.sent) throw new ProtocolError('file_ack de más bytes de los enviados');
    if (msg.received <= t.acked) return;
    const before = t.acked;
    t.acked = msg.received;
    if (crossesMiB(before, t.acked)) this.emitOut(t, 'active');
    this.wakeOut(t);
  }

  private onFileResult(msg: FileResultMsg): void {
    const t = this.out;
    if (!t || t.id !== msg.transferId || t.ended) return;
    if (!t.endSent) throw new ProtocolError('file_result antes de file_end');
    if (msg.ok) this.endOut(t, 'done');
    else this.endOut(t, 'failed', msg.error ?? 'remote_error');
  }

  /** Termina el saliente activo; con `cancel`, avisa al otro lado con ese motivo. El emisor cierra el origen. */
  private endOut(t: OutTransfer, state: TransferState, error?: string, cancel?: string): void {
    if (t.ended) return;
    t.ended = true;
    // se emite antes de escribir: si la escritura falla, 'closed' llega después
    this.emitOut(t, state, error);
    if (cancel) this.send({ kind: 'file_cancel', transferId: t.id, reason: cancel });
    this.wakeOut(t);
  }

  private wakeOut(t: OutTransfer): void {
    const wake = t.wake;
    t.wake = null;
    wake?.();
  }

  private emitOut(t: OutTransfer, state: TransferState, error?: string): void {
    const bytes = state === 'done' ? t.src.size : t.acked;
    this.emitTransfer({ transferId: t.id, direction: 'out', name: t.src.name, size: t.src.size, bytes, state }, error);
  }

  // --- archivos: receptor ---

  private async onFileStart(msg: FileStartMsg): Promise<void> {
    if (this.inc) throw new ProtocolError('file_start con otro archivo entrante en curso');
    if (this.endedIn.has(msg.transferId)) throw new ProtocolError('transferId repetido');
    const meta: FileMeta = { name: msg.name, size: msg.size, mime: msg.mime };
    const t: InTransfer = {
      id: msg.transferId,
      meta,
      received: 0,
      hash: createSha256(),
      sink: null,
      io: Promise.resolve(),
      ending: false,
      ended: false,
    };
    this.inc = t;
    t.io = this.opts.openSink(meta).then((sink) => {
      t.sink = sink;
    });
    try {
      await t.io;
    } catch {
      this.endIn(t, 'failed', { error: 'write_error', cancel: 'write_error' });
      return;
    }
    if (t.ended) return; // cancelado o cerrado mientras se abría; endIn ya encadenó abort()
    this.emitIn(t, 'active');
  }

  private async onFileData(transferId: string, bytes: Uint8Array): Promise<void> {
    const t = this.inc;
    if (!t || t.id !== transferId) {
      if (this.endedIn.has(transferId)) return; // en vuelo cuando terminó: se descarta
      throw new ProtocolError('datos de archivo para un transferId desconocido');
    }
    if (t.ending) throw new ProtocolError('datos de archivo después de file_end');
    if (t.received + bytes.length > t.meta.size) throw new ProtocolError('más datos de archivo de los anunciados');
    const sink = t.sink!;
    t.io = t.io.then(() => sink.write(bytes));
    try {
      await t.io;
    } catch {
      this.endIn(t, 'failed', { error: 'write_error', cancel: 'write_error', abort: true });
      return;
    }
    if (t.ended) return;
    const before = t.received;
    t.received += bytes.length;
    t.hash.update(bytes);
    if (crossesMiB(before, t.received)) {
      this.send({ kind: 'file_ack', transferId: t.id, received: t.received });
      if (t.ended) return; // la escritura falló y cerró la sesión
      this.emitIn(t, 'active');
    }
  }

  private async onFileEnd(msg: FileEndMsg): Promise<void> {
    const t = this.inc;
    if (!t || t.id !== msg.transferId) {
      if (this.endedIn.has(msg.transferId)) return;
      throw new ProtocolError('file_end para un transferId desconocido');
    }
    if (t.received !== t.meta.size) throw new ProtocolError('file_end con un tamaño distinto del anunciado');
    t.ending = true;
    // ack final: el emisor de un archivo pequeño no se queda esperando a la ventana
    this.send({ kind: 'file_ack', transferId: t.id, received: t.received });
    if (t.ended) return; // la escritura falló y cerró la sesión
    if (t.hash.digestHex() !== msg.sha256) {
      this.send({ kind: 'file_result', transferId: t.id, ok: false, error: 'checksum_mismatch' });
      this.endIn(t, 'failed', { error: 'checksum_mismatch', abort: true });
      return;
    }
    const sink = t.sink!;
    const finishing = t.io.then(() => sink.finish());
    t.io = finishing;
    let location: string;
    try {
      location = await finishing;
    } catch {
      if (t.ended) return;
      this.send({ kind: 'file_result', transferId: t.id, ok: false, error: 'write_error' });
      this.endIn(t, 'failed', { error: 'write_error', abort: true });
      return;
    }
    if (t.ended) return; // la sesión cayó durante finish(): endIn ya encadenó abort()
    this.send({ kind: 'file_result', transferId: t.id, ok: true });
    this.endIn(t, 'done', { location });
  }

  /** Termina el entrante activo; `abort` descarta el parcial tras la operación del sink en curso. */
  private endIn(
    t: InTransfer,
    state: TransferState,
    o: { error?: string; location?: string; cancel?: string; abort?: boolean } = {},
  ): void {
    if (t.ended) return;
    t.ended = true;
    if (this.inc === t) this.inc = null;
    this.endedIn.add(t.id);
    if (o.abort) {
      t.io = t.io
        .catch(ignore)
        .then(() => t.sink?.abort())
        .catch(ignore);
    }
    // se emite antes de escribir: si la escritura falla, 'closed' llega después
    this.emitIn(t, state, o.error, o.location);
    if (o.cancel) this.send({ kind: 'file_cancel', transferId: t.id, reason: o.cancel });
  }

  private emitIn(t: InTransfer, state: TransferState, error?: string, location?: string): void {
    const { name, size } = t.meta;
    this.emitTransfer({ transferId: t.id, direction: 'in', name, size, bytes: t.received, state }, error, location);
  }

  private emitTransfer(u: TransferUpdate, error?: string, location?: string): void {
    if (error !== undefined) u.error = error;
    if (location !== undefined) u.location = location;
    this.emit('transfer', u);
  }

  // --- latido ---

  private tick(): void {
    if (this.closed) return;
    if (this.timers.now() - this.lastRx >= HEARTBEAT_TIMEOUT_MS) this.close('heartbeat_timeout');
    else if (this.ready) this.send({ kind: 'ping' });
  }

  // --- salida ---

  private send(msg: ControlMessage): void {
    this.write(encodeControl(msg));
  }

  private write(payloads: Uint8Array[]): void {
    if (this.closed) return;
    try {
      for (const payload of payloads) this.link.write(encodeFrame(payload));
    } catch {
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

/** true si `after` alcanza otro múltiplo de 1 MiB que `before` no alcanzaba. */
function crossesMiB(before: number, after: number): boolean {
  return Math.floor(after / FILE_ACK_EVERY_BYTES) > Math.floor(before / FILE_ACK_EVERY_BYTES);
}
