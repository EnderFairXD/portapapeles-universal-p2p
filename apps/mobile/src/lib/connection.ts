// Conexión persistente con el PC: WiFi (mDNS) o USB (adb reverse), con reintentos.
import {
  ClipboardSync,
  CONNECT_TIMEOUT_MS,
  DEFAULT_TCP_PORT,
  MAX_HISTORY,
  RECONNECT_INTERVAL_MS,
  Session,
  type FileSource,
  type Link,
  type PeerInfo,
  type TransferUpdate,
} from '@clipsync/protocol';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';

import { readClipboard, startClipboardWatcher, writeClipboard } from './clipboardWatcher';
import { discoverPc } from './discovery';
import { isPickerOpen, openSink } from './files';
import { getDeviceId } from './settings';
import { connectTcp } from './tcpLink';

export type ConnStatus = 'searching' | 'connecting' | 'connected';
export type Transport = 'wifi' | 'usb';

export interface HistoryEntry {
  id: string;
  kind: 'text' | 'file';
  direction: 'in' | 'out';
  text?: string;
  fileName?: string;
  /** Archivo recibido: URI content:// del documento guardado. */
  location?: string;
  /** Date.now() */
  at: number;
}

export interface ConnState {
  status: ConnStatus;
  transport: Transport | null;
  peerName: string | null;
  /** En curso y terminadas sin éxito (como mucho 5 de estas); las completadas pasan al historial. */
  transfers: TransferUpdate[];
  /** El más reciente primero; como mucho MAX_HISTORY. */
  history: HistoryEntry[];
  /** Último aviso para el usuario; se borra al enviar algo con éxito o con clearError(). */
  lastError: string | null;
}

/** Terminadas (fallidas o canceladas) que se conservan en la lista, como en el PC. */
export const MAX_FINISHED_TRANSFERS = 5;
const USB_HOST = '127.0.0.1';

const CLIP_TOO_LARGE = 'Texto demasiado grande para sincronizar (máx. 1 MB)';
const CLIP_WRITE_FAILED = 'No se pudo escribir en el portapapeles';
const INVALID_FILE_SIZE = 'No se pudo leer el tamaño del archivo';

function isFinished(u: TransferUpdate): boolean {
  return u.state === 'done' || u.state === 'failed' || u.state === 'cancelled';
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** El PC serializa los opcionales como null: aquí null y ausente son lo mismo. */
function normalize(u: TransferUpdate): TransferUpdate {
  const { error, location, ...rest } = u as TransferUpdate & { error?: string | null; location?: string | null };
  const out: TransferUpdate = { ...rest };
  if (error != null) out.error = error;
  if (location != null) out.location = location;
  return out;
}

export class ConnectionManager {
  private state: ConnState = {
    status: 'searching',
    transport: null,
    peerName: null,
    transfers: [],
    history: [],
    lastError: null,
  };
  private readonly listeners = new Set<() => void>();

  /** start() llamado (y no stop()): la app quiere estar conectada en primer plano. */
  private enabled = false;
  private appStateSub: NativeEventSubscription | null = null;
  /** Bucle de conexión activo. */
  private running = false;
  /** Sube en cada arranque/parada: un bucle con otra generación ya no vale. */
  private generation = 0;
  private wake: (() => void) | null = null;
  private stopWatcher: (() => void) | null = null;

  private session: Session | null = null;
  private ready = false;
  /** Único anti-rebote del móvil (con un solo PC); se renueva tras un cierre anómalo. */
  private sync = new ClipboardSync(null);
  /** Texto que la regla de inicio va a enviar al saludar. */
  private startClip: string | null = null;
  private nextHistoryId = 1;
  private self: PeerInfo | null = null;

  // --- API pública ---

  /** Conecta mientras la app esté en primer plano: activo → reanuda, segundo plano → para. */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.appStateSub = AppState.addEventListener('change', this.onAppState);
    if (AppState.currentState !== 'background') this.resume();
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.pause();
  }

  getState = (): ConnState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /**
   * Encola un archivo y devuelve su transferId; null si no hay sesión lista (entonces se
   * cierra `src`).
   */
  sendFile(src: FileSource): string | null {
    const session = this.readySession();
    if (!session) {
      void src.close().catch(() => {});
      return null;
    }
    try {
      const id = session.sendFile(src);
      this.setError(null);
      return id;
    } catch (e) {
      void src.close().catch(() => {});
      if (e instanceof RangeError) this.setError(INVALID_FILE_SIZE);
      return null;
    }
  }

  cancelTransfer(id: string): void {
    this.session?.cancelTransfer(id);
  }

  /** Copia un texto del historial al portapapeles sin reenviarlo al PC. */
  async copyFromHistory(text: string): Promise<void> {
    // se marca antes de escribir: el listener del portapapeles salta enseguida
    this.sync.markSynced(text);
    await writeClipboard(text);
  }

  /** Muestra un error en la interfaz (p. ej. FileTooLargeError al elegir un archivo). */
  reportError(message: string): void {
    this.setError(message);
  }

  clearError(): void {
    this.setError(null);
  }

  // --- ciclo de vida ---

  private onAppState = (s: AppStateStatus) => {
    if (s === 'active') this.resume();
    // un selector del sistema abierto también manda la app a segundo plano
    else if (s === 'background' && !isPickerOpen()) this.pause();
  };

  private resume(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    this.stopWatcher = startClipboardWatcher((text) => this.onLocalText(text));
    void this.loop(gen);
  }

  private pause(): void {
    if (!this.running) return;
    this.running = false;
    this.stopWatcher?.();
    this.stopWatcher = null;
    // cierre ordenado (no hace falta renovar el anti-rebote); antes de cambiar de generación
    // para que lleguen los 'failed' de las transferencias en curso
    this.session?.close('closed');
    this.session = null;
    this.ready = false;
    this.generation += 1;
    this.wake?.();
    this.update({ status: 'searching', transport: null, peerName: null });
  }

  private async loop(gen: number): Promise<void> {
    while (gen === this.generation) {
      this.update({ status: 'searching', transport: null, peerName: null });
      const conn = await this.connectOnce(gen);
      if (gen !== this.generation) {
        conn?.link.close();
        return;
      }
      if (conn) {
        const { reason, wasReady } = await this.runSession(conn.link, conn.transport, gen);
        if (gen !== this.generation) return;
        // R18: lo escrito en un enlace moribundo pudo no llegar al PC; no se da por sincronizado
        if (reason === 'link_closed' || reason === 'heartbeat_timeout') this.sync = new ClipboardSync(null);
        if (wasReady) continue; // la sesión funcionó: se reintenta enseguida
      }
      await this.sleep(RECONNECT_INTERVAL_MS);
    }
  }

  /** WiFi por mDNS y, si no, USB por 127.0.0.1. */
  private async connectOnce(gen: number): Promise<{ link: Link; transport: Transport } | null> {
    const pc = await discoverPc(CONNECT_TIMEOUT_MS);
    if (gen !== this.generation) return null;
    if (pc) {
      this.update({ status: 'connecting' });
      try {
        return { link: await connectTcp(pc.host, pc.port, CONNECT_TIMEOUT_MS), transport: 'wifi' };
      } catch {
        // se prueba el USB
      }
      if (gen !== this.generation) return null;
    }
    try {
      return { link: await connectTcp(USB_HOST, DEFAULT_TCP_PORT, CONNECT_TIMEOUT_MS), transport: 'usb' };
    } catch {
      return null;
    }
  }

  private runSession(link: Link, transport: Transport, gen: number): Promise<{ reason: string; wasReady: boolean }> {
    return new Promise((resolve) => {
      let wasReady = false;
      this.startClip = null;
      const session = new Session(link, {
        role: 'client',
        self: this.selfInfo(),
        clipSyncFor: () => this.sync,
        getLocalClip: () => this.localClipForStart(),
        openSink,
        newTransferId: () => toHex(Crypto.getRandomBytes(16)),
      });
      this.session = session;
      this.ready = false;
      this.update({ status: 'connecting' });

      session.on('ready', (peer) => {
        if (gen !== this.generation) return;
        wasReady = true;
        this.ready = true;
        const sent = this.startClip;
        this.startClip = null;
        this.update({ status: 'connected', transport, peerName: peer.deviceName });
        if (sent !== null) this.addTextOnce('out', sent);
      });
      session.on('clip', (text) => {
        if (gen !== this.generation) return;
        this.addTextOnce('in', text);
        // el listener saltará con este texto; el anti-rebote ya lo tiene marcado
        writeClipboard(text).catch(() => this.setError(CLIP_WRITE_FAILED));
      });
      session.on('transfer', (u) => this.onTransfer(normalize(u)));
      session.on('closed', (reason) => {
        if (this.session === session) {
          this.session = null;
          this.ready = false;
        }
        resolve({ reason, wasReady });
      });

      void session.start();
    });
  }

  // --- portapapeles ---

  /** Regla de inicio: el texto actual se anuncia en el hello (la sesión decide si se envía). */
  private async localClipForStart(): Promise<string | null> {
    const text = await readClipboard();
    if (text === null) return null;
    const decision = this.sync.check(text);
    if (decision === 'too_large') this.setError(CLIP_TOO_LARGE);
    this.startClip = decision === 'send' ? text : null;
    return text;
  }

  private onLocalText(text: string): void {
    // sin sesión lista no se envía: la regla de inicio lo mandará al conectar
    const session = this.readySession();
    if (!session) return;
    let decision;
    try {
      decision = session.sendClip(text);
    } catch {
      return; // la sesión acaba de cerrarse
    }
    if (decision === 'send') {
      this.addHistory({ kind: 'text', direction: 'out', text });
      this.setError(null);
    } else if (decision === 'too_large') this.setError(CLIP_TOO_LARGE);
  }

  // --- archivos ---

  private onTransfer(u: TransferUpdate): void {
    if (u.state === 'done') {
      // las completadas pasan al historial, como en el PC
      this.update({ transfers: this.state.transfers.filter((t) => t.transferId !== u.transferId) });
      this.addHistory({ kind: 'file', direction: u.direction, fileName: u.name, location: u.location });
      return;
    }
    const i = this.state.transfers.findIndex((t) => t.transferId === u.transferId);
    let transfers = [...this.state.transfers];
    if (i >= 0) transfers[i] = u;
    else transfers.push(u);
    if (isFinished(u)) {
      // se quitan las terminadas más antiguas; las que siguen en curso no se tocan
      let extra = transfers.filter(isFinished).length - MAX_FINISHED_TRANSFERS;
      transfers = transfers.filter((t) => {
        if (extra <= 0 || !isFinished(t)) return true;
        extra -= 1;
        return false;
      });
    }
    this.update({ transfers });
  }

  // --- utilidades ---

  private readySession(): Session | null {
    return this.ready && this.session ? this.session : null;
  }

  private selfInfo(): PeerInfo {
    if (!this.self) {
      this.self = {
        deviceId: getDeviceId(),
        deviceName: Device.deviceName ?? Device.modelName ?? 'Android',
      };
    }
    return this.self;
  }

  private addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): void {
    const item: HistoryEntry = { ...entry, id: String(this.nextHistoryId++), at: Date.now() };
    if (item.location === undefined) delete item.location;
    this.update({ history: [item, ...this.state.history].slice(0, MAX_HISTORY) });
  }

  /**
   * Para los textos que llegan o salen solos al reconectar: si el más reciente del
   * historial es el mismo, no se repite (como el historial del PC).
   */
  private addTextOnce(direction: 'in' | 'out', text: string): void {
    const newest = this.state.history.find((h) => h.kind === 'text');
    if (newest?.text === text) return;
    this.addHistory({ kind: 'text', direction, text });
  }

  private setError(message: string | null): void {
    if (this.state.lastError !== message) this.update({ lastError: message });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private update(patch: Partial<ConnState>): void {
    const next = { ...this.state, ...patch };
    const changed = (Object.keys(patch) as (keyof ConnState)[]).some((k) => next[k] !== this.state[k]);
    if (!changed) return;
    this.state = next;
    for (const cb of [...this.listeners]) cb();
  }
}

/** Instancia única de la app. */
export const connection = new ConnectionManager();
