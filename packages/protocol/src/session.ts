import { ClipboardSync, prepareClip, type ClipDecision } from './clipSync';
import {
  FILE_ACK_EVERY_BYTES,
  FILE_CHUNK_BYTES,
  FILE_WINDOW_BYTES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_CLIP_BYTES,
  MAX_CLIP_IMAGE_BYTES,
  PURPOSE_CLIPBOARD,
} from './constants';
import { FrameDecoder, encodeFrame } from './framing';
import { createSha256, sha256Hex } from './hash';
import {
  decodeClientHello,
  decodeServerHello,
  encodeClientHello,
  encodeServerHello,
  type ClientHello,
  type RejectReason,
} from './hello';
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
  type FilePurpose,
  type FileStartMsg,
} from './messages';
import { NoiseIK, type CipherState, type KeyPair, type RandomBytes } from './noise';
import { toWellFormed } from './text';

/** Flujo de bytes fiable (TCP, USB…); la sesión le aplica el framing. */
export interface Link {
  /** Debe lanzar si el enlace ya está cerrado: la sesión lo trata como 'link_closed'. */
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
  /** 'clipboard': imagen para el portapapeles; ausente: archivo normal. */
  purpose?: FilePurpose;
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
  purpose?: FilePurpose;
}

/** Respuesta de `authorize` (servidor): se acepta al cliente o se rechaza con un motivo. */
export type AuthDecision = { accepted: true } | { accepted: false; reason: RejectReason };

export interface SessionOptions {
  role: 'client' | 'server';
  self: PeerInfo;
  /** Clave estática Noise propia. */
  identity: KeyPair;
  /** Por defecto, la de @noble; el móvil pasa la de expo-crypto. */
  randomBytes?: RandomBytes;
  /** Cliente: clave pública del PC (del QR). Obligatoria con role 'client'. */
  serverKey?: Uint8Array;
  /** Cliente: token del QR mientras el emparejamiento no se ha completado. */
  pairingToken?: string | null;
  /** Servidor (solo pruebas en TS; el servidor real es Rust). Obligatoria con role 'server'. */
  authorize?(req: { publicKey: Uint8Array; hello: ClientHello }): Promise<AuthDecision>;
  /**
   * ClipboardSync con el que se compara y marca lo sincronizado con este par.
   * - Cliente: se llama con `null` en `start()`, antes del mensaje 1 del handshake, para calcular
   *   `willSendClip` (aún no conoce al servidor; el móvil devuelve una única instancia).
   * - Servidor: se llama con los datos del cliente al leer su mensaje 1.
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
  /** La regla de inicio envió de verdad este texto (ya bien formado), antes de `ready`. */
  startClipSent: (text: string) => void;
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
 * Empieza con un handshake Noise IK cuyos dos mensajes llevan el saludo (el móvil es el
 * iniciador); después, cada trama es un mensaje Noise de transporte.
 * Los mensajes entrantes se atienden en orden, de uno en uno, aunque su manejo sea asíncrono.
 */
export class Session {
  private readonly timers: Timers;
  private readonly frames = new FrameDecoder();
  private readonly messages = new MessageDecoder();
  private readonly listeners: Listeners = {
    ready: [],
    clip: [],
    localClipSuperseded: [],
    startClipSent: [],
    transfer: [],
    closed: [],
  };

  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  private readonly hs: NoiseIK;
  /** Mensajes del handshake escritos o leídos (0, 1 o 2). */
  private hsStep = 0;
  /** Cifrado de transporte, tras split(). */
  private cipher: { send: CipherState; recv: CipherState } | null = null;
  private ready = false;
  private remote: PeerInfo | null = null;
  private sync: ClipboardSync | null = null;
  /** Cliente: texto anunciado con willSendClip, que se envía al llegar el hello del servidor. */
  private startClip: string | null = null;
  private heartbeat: unknown = null;
  private lastRx = 0;
  /**
   * Confirmación de lo enviado (R29): tras cada clip sale un ping; el pong número `confirmAt`
   * prueba que el otro lado ya procesó el clip, porque el PC contesta en orden.
   */
  private pingsSent = 0;
  private pongsReceived = 0;
  private confirmAt: number | null = null;

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
    const { identity: s, randomBytes } = opts;
    if (opts.role === 'client') {
      if (!opts.serverKey) throw new Error('El cliente necesita serverKey');
      this.hs = NoiseIK.initiator({ s, rs: opts.serverKey, randomBytes });
    } else {
      if (!opts.authorize) throw new Error('El servidor necesita authorize');
      this.hs = NoiseIK.responder({ s, randomBytes });
    }
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
    this.link.onClose(
      () => void this.enqueue(() => this.close(this.awaitingServer() ? 'handshake_failed' : 'link_closed')),
    );
    // el plazo del latido cuenta desde ya, también durante el handshake
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
    return this.pushClip(toWellFormed(text));
  }

  /**
   * Pone un archivo en la cola de salida y devuelve su transferId. Se emite 'queued' al momento;
   * si no hay otro en curso, también 'active'. Lanza Error si la sesión no está lista o ya se cerró,
   * y RangeError si `src.size` no es un entero seguro ≥ 0 o si es una imagen de portapapeles
   * (`purpose`) de más de MAX_CLIP_IMAGE_BYTES.
   */
  sendFile(src: FileSource): string {
    if (this.closed || !this.ready) throw new Error('La sesión no está lista');
    if (!Number.isSafeInteger(src.size) || src.size < 0) throw new RangeError('Tamaño de archivo inválido');
    if (src.purpose === PURPOSE_CLIPBOARD && src.size > MAX_CLIP_IMAGE_BYTES) {
      throw new RangeError(`Imagen de más de ${MAX_CLIP_IMAGE_BYTES} bytes`);
    }
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
      if (!this.cipher) {
        // se lee al momento: las tramas siguientes del mismo trozo ya se descifran en orden
        if (!this.onHandshakeFrame(frame)) return;
        continue;
      }
      let decoded: DecodedMessage | null;
      try {
        decoded = this.messages.push(this.cipher.recv.decrypt(frame));
      } catch (e) {
        this.fail(e); // también un fallo de descifrado: protocol_error
        return;
      }
      if (!decoded) continue;
      // el ping se contesta al momento, sin esperar a la cola (p. ej. tras un selector abierto);
      // un pong no cambia nada más. Antes de ready va por la cola, para validar el saludo.
      if (this.ready && decoded.type === 'control' && decoded.msg.kind === 'ping') {
        this.pongNow();
        continue;
      }
      const m = decoded;
      void this.enqueue(() => this.dispatch(m));
    }
  }

  /** Pong fuera de la cola. Si el enlace cayó, se cierra por la cola: antes se atiende lo que ya llegó. */
  private pongNow(): void {
    try {
      for (const payload of encodeControl({ kind: 'pong' })) {
        this.link.write(encodeFrame(this.cipher!.send.encrypt(payload)));
      }
    } catch {
      void this.enqueue(() => this.close('link_closed'));
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

  /** Las tramas de transporte solo se encolan tras el saludo, así que aquí la sesión ya está lista. */
  private dispatch(m: DecodedMessage): void | Promise<void> {
    if (m.type === 'data') return this.onFileData(m.transferId, m.bytes);
    const msg = m.msg;
    switch (msg.kind) {
      case 'ping':
        this.send({ kind: 'pong' });
        return;
      case 'pong':
        this.onPong();
        return;
      case 'clip':
        return this.onClip(msg);
      default:
        return this.onFileControl(msg);
    }
  }

  // --- handshake Noise IK con el saludo dentro, y regla de inicio (spec §3.5) ---

  /** Cliente: con el mensaje 1 ya enviado, espera el 2; si el enlace cae ahora, el handshake falló. */
  private awaitingServer(): boolean {
    return this.opts.role === 'client' && this.hsStep === 1;
  }

  /**
   * Trama recibida antes del cifrado de transporte. Se lee al momento (el servidor solo el
   * mensaje 1; el cliente, el 2 tras enviar el 1); el resto del saludo sigue por la cola.
   * Devuelve false si la sesión se cerró.
   */
  private onHandshakeFrame(frame: Uint8Array): boolean {
    const client = this.opts.role === 'client';
    if (this.hsStep !== (client ? 1 : 0)) {
      // cliente: antes de su mensaje 1; servidor: antes de contestar al 1
      this.close('protocol_error');
      return false;
    }
    this.hsStep++;
    try {
      const payload = this.hs.readMessage(frame);
      if (!client) {
        const hello = decodeClientHello(payload);
        const publicKey = this.hs.remoteStatic!;
        void this.enqueue(() => this.onClientHello(hello, publicKey));
        return true;
      }
      const answer = decodeServerHello(payload);
      this.cipher = this.hs.split();
      if (!answer.accepted) {
        this.close(answer.reason);
        return false;
      }
      void this.enqueue(() => this.onServerHello({ deviceId: answer.deviceId, deviceName: answer.pcName }));
      return true;
    } catch {
      this.close('handshake_failed');
      return false;
    }
  }

  private async sendClientHello(): Promise<void> {
    this.sync = this.opts.clipSyncFor(null);
    const raw = await this.opts.getLocalClip();
    const local = raw === null ? null : toWellFormed(raw);
    // se anuncia solo lo que de verdad se podrá enviar (también si no cabe al codificarlo)
    const willSendClip = local !== null && this.prepareClip(local).decision === 'send';
    if (willSendClip) this.startClip = local;
    const hello: ClientHello = { v: 2, ...this.self(), willSendClip };
    if (this.opts.pairingToken != null) hello.pairingToken = this.opts.pairingToken;
    const msg1 = this.hs.writeMessage(encodeClientHello(hello));
    this.hsStep = 1;
    this.writeFrame(msg1);
  }

  private onServerHello(peer: PeerInfo): void {
    const text = this.startClip;
    this.startClip = null;
    if (text !== null) this.pushStartClip(text); // antes de ready, igual que el servidor
    if (this.closed) return; // falló la escritura del clip
    this.becomeReady(peer);
  }

  private async onClientHello(hello: ClientHello, publicKey: Uint8Array): Promise<void> {
    let decision: AuthDecision;
    try {
      decision = await this.opts.authorize!({ publicKey, hello });
    } catch {
      this.close('internal_error');
      return;
    }
    if (this.closed) return;
    const msg2 = this.hs.writeMessage(
      encodeServerHello(
        decision.accepted
          ? { v: 2, accepted: true, deviceId: this.opts.self.deviceId, pcName: this.opts.self.deviceName }
          : { v: 2, accepted: false, reason: decision.reason },
      ),
    );
    this.hsStep = 2;
    this.cipher = this.hs.split();
    this.writeFrame(msg2);
    if (!decision.accepted) {
      this.close(decision.reason);
      return;
    }

    const peer = { deviceId: hello.deviceId, deviceName: hello.deviceName };
    const sync = (this.sync = this.opts.clipSyncFor(peer));
    // La regla se resuelve antes de ready: hasta entonces la app no puede llamar a sendClip.
    // La cola espera a esto, así que el clip del cliente aún no se ha procesado.
    const raw = await this.opts.getLocalClip();
    if (this.closed) return;
    const local = raw === null ? null : toWellFormed(raw);
    let superseded: string | null = null;
    if (local !== null) {
      if (!hello.willSendClip) this.pushStartClip(local);
      else if (this.prepareClip(local).decision === 'send') {
        // gana el móvil: el texto del PC se da por tratado para que no salga después y cruce
        sync.markSynced(local);
        superseded = local;
      }
    }
    if (this.closed) return; // falló la escritura del clip
    this.becomeReady(peer);
    if (this.closed) return; // la app cerró desde ready
    if (superseded !== null) this.emit('localClipSuperseded', superseded);
  }

  private becomeReady(peer: PeerInfo): void {
    this.remote = peer;
    this.ready = true;
    this.emit('ready', this.remote);
  }

  private self(): PeerInfo {
    return { deviceId: this.opts.self.deviceId, deviceName: this.opts.self.deviceName };
  }

  // --- portapapeles ---

  /** Decide si un texto (ya bien formado) se envía; si su JSON no cabe, es 'too_large'. */
  private prepareClip(text: string): { decision: ClipDecision; frames?: Uint8Array[] } {
    return prepareClip(this.sync!, text, this.opts.newTransferId());
  }

  /** Único camino de salida de un clip (ya bien formado), para el arranque y para sendClip. */
  private pushClip(text: string): ClipDecision {
    const { decision, frames } = this.prepareClip(text);
    if (decision !== 'send') return decision;
    this.write(frames!);
    if (this.closed) return decision; // la escritura falló: no llegó
    // tentativo hasta el pong del ping que sale justo detrás
    this.sync!.markSent(text);
    this.sendPing();
    this.confirmAt = this.pingsSent;
    return decision;
  }

  private pushStartClip(text: string): void {
    if (this.pushClip(text) === 'send' && !this.closed) this.emit('startClipSent', text);
  }

  private sendPing(): void {
    this.pingsSent += 1;
    this.send({ kind: 'ping' });
  }

  private onPong(): void {
    this.pongsReceived += 1;
    if (this.confirmAt !== null && this.pongsReceived >= this.confirmAt) {
      this.confirmAt = null;
      this.sync!.confirmSent();
    }
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
    const start: FileStartMsg = { kind: 'file_start', transferId: t.id, name, size, mime };
    if (t.src.purpose === PURPOSE_CLIPBOARD) start.purpose = PURPOSE_CLIPBOARD;
    // file_start sale antes del aviso: si un oyente cancela en 'active', file_cancel va detrás
    this.send(start);
    if (t.ended) return; // la escritura falló y cerró la sesión
    this.emitOut(t, 'active');
    if (t.ended) return; // un oyente canceló o cerró
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
    this.emitTransfer({ transferId: t.id, direction: 'out', name: t.src.name, size: t.src.size, bytes, state }, error, undefined, t.src.purpose);
  }

  // --- archivos: receptor ---

  private async onFileStart(msg: FileStartMsg): Promise<void> {
    if (this.inc) throw new ProtocolError('file_start con otro archivo entrante en curso');
    if (this.endedIn.has(msg.transferId)) throw new ProtocolError('transferId repetido');
    const meta: FileMeta = { name: msg.name, size: msg.size, mime: msg.mime };
    if (msg.purpose === PURPOSE_CLIPBOARD) meta.purpose = PURPOSE_CLIPBOARD;
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
    if (meta.purpose === PURPOSE_CLIPBOARD && meta.size > MAX_CLIP_IMAGE_BYTES) {
      // demasiado grande para el portapapeles: se rechaza sin abrir el sink ni cerrar la sesión
      this.endIn(t, 'failed', { error: 'too_large', cancel: 'too_large' });
      return;
    }
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
    const { name, size, purpose } = t.meta;
    this.emitTransfer({ transferId: t.id, direction: 'in', name, size, bytes: t.received, state }, error, location, purpose);
  }

  private emitTransfer(u: TransferUpdate, error?: string, location?: string, purpose?: FilePurpose): void {
    if (error !== undefined) u.error = error;
    if (location !== undefined) u.location = location;
    if (purpose !== undefined) u.purpose = purpose;
    this.emit('transfer', u);
  }

  // --- latido ---

  private tick(): void {
    if (this.closed) return;
    if (this.timers.now() - this.lastRx >= HEARTBEAT_TIMEOUT_MS) this.close('heartbeat_timeout');
    else if (this.ready) this.sendPing();
  }

  // --- salida ---

  private send(msg: ControlMessage): void {
    this.write(encodeControl(msg));
  }

  /** Cifra cada payload y lo escribe en su trama. */
  private write(payloads: Uint8Array[]): void {
    for (const payload of payloads) {
      if (this.closed) return;
      this.writeFrame(this.cipher!.send.encrypt(payload));
    }
  }

  /** Escribe una trama tal cual (un mensaje del handshake o uno ya cifrado). */
  private writeFrame(data: Uint8Array): void {
    if (this.closed) return;
    try {
      this.link.write(encodeFrame(data));
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
