// Conexión persistente con el PC: WiFi (mDNS) o USB (adb reverse), con reintentos.
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_TCP_PORT,
  MAX_HISTORY,
  RECONNECT_INTERVAL_MS,
  Session,
  decideClip,
  fingerprint,
  type FileSource,
  type KeyPair,
  type Link,
  type PairingInfo,
  type PeerInfo,
  type TransferUpdate,
} from '@clipsync/protocol';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import {
  AppState,
  type AppStateStatus,
  type NativeEventSubscription,
  type TurboModule,
  TurboModuleRegistry,
} from 'react-native';

import { readClipboard, startClipboardWatcher, writeClipboard } from './clipboardWatcher';
import { resolvedPcs, startDiscovery, stopDiscovery } from './discovery';
import { loadIdentity } from './identity';
import { installNativeCrypto } from './nativeCrypto';
import {
  backgroundDecision,
  classifySendError,
  closeOutcome,
  createPauseCheck,
  hasPendingWork,
  INVALID_FILE_SIZE_MESSAGE,
  localSendOutcome,
  reconnectDelayMs,
  type SendFileResult,
} from './connectionPolicy';
import { isPickerOpen, onPickerSettled, openSink, resetPickers } from './files';
import { bytesToHex, hexToBytes, pairedPcFromInfo, type PairedPc } from './pairing';
import { connectCandidates, type PcAddress } from './pcAddress';
import { getDeviceId, loadSettings, updateSettings } from './settings';
import { SyncKeeper } from './syncKeeper';
import { connectTcp } from './tcpLink';

export type ConnStatus = 'unpaired' | 'searching' | 'connecting' | 'connected';
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
  /** El PC emparejado; `pairing` mientras falta completar el emparejamiento con el token del QR. */
  pc: { name: string; pairing: boolean } | null;
}

/** Terminadas (fallidas o canceladas) que se conservan en la lista, como en el PC. */
export const MAX_FINISHED_TRANSFERS = 5;
const USB_HOST = '127.0.0.1';

const CLIP_TOO_LARGE = 'Texto demasiado grande para sincronizar (máx. 1 MB)';
const PC_UNREACHABLE = 'PC no alcanzable. Comprueba que el móvil y el PC están en la misma red WiFi.';
const IDENTITY_FAILED = 'No se pudo acceder al almacén seguro del móvil.';
const CLIP_WRITE_FAILED = 'No se pudo escribir en el portapapeles';
/** Margen tras cerrarse un selector antes de pausar si la app sigue en segundo plano. */
const PICKER_SETTLE_MS = 1000;

/** El módulo nativo que alimenta AppState (spec NativeAppState de React Native). */
interface NativeAppStateModule extends TurboModule {
  getCurrentAppState(success: (s: { app_state: string }) => void, error: (e: unknown) => void): void;
}
const nativeAppState = TurboModuleRegistry.get<NativeAppStateModule>('AppState');

/** Estado que tiene ahora Android, sin esperar a que JS procese el evento de cambio. */
function confirmAppState(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!nativeAppState) {
      reject(new Error('AppState nativo no disponible'));
      return;
    }
    nativeAppState.getCurrentAppState((s) => resolve(s.app_state), reject);
  });
}

function isFinished(u: TransferUpdate): boolean {
  return u.state === 'done' || u.state === 'failed' || u.state === 'cancelled';
}

function pcView(pc: PairedPc | null): ConnState['pc'] {
  return pc ? { name: pc.name, pairing: pc.token !== null } : null;
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
  /** El PC emparejado (settings.json); null hasta escanear su QR. */
  private pc: PairedPc | null = loadSettings().pc;
  /** Cuándo empezó cada transferencia en curso (solo para el registro de velocidad). */
  private transferStarts = new Map<string, number>();
  private state: ConnState = {
    status: this.pc ? 'searching' : 'unpaired',
    transport: null,
    peerName: null,
    transfers: [],
    history: [],
    lastError: null,
    pc: pcView(this.pc),
  };
  private readonly listeners = new Set<() => void>();

  /** start() llamado (y no stop()): la app quiere estar conectada en primer plano. */
  private enabled = false;
  private appStateSub: NativeEventSubscription | null = null;
  private pickerSub: (() => void) | null = null;
  private readonly pauseCheck = createPauseCheck({
    delayMs: PICKER_SETTLE_MS,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    appState: () => AppState.currentState,
    confirmAppState,
    pickerOpen: isPickerOpen,
    // ya confirmado con Android: no se vuelve a mirar AppState.currentState, que puede ir atrasado
    pause: () => this.applyBackground('background'),
  });
  /** Hay un «Compartir → ClipSync» esperando a enviarse (lo avisa ShareSender). */
  private sharePending = false;
  /** Bucle de conexión activo. */
  private running = false;
  /** Sube en cada arranque/parada: un bucle con otra generación ya no vale. */
  private generation = 0;
  private wake: (() => void) | null = null;
  private stopWatcher: (() => void) | null = null;

  private session: Session | null = null;
  private ready = false;
  /** Anti-rebote del móvil (con un solo PC), persistido en settings.json (R29). */
  private keeper: SyncKeeper | null = null;
  /** Última dirección WiFi del PC que funcionó; se prueba la primera. */
  private lastPc: PcAddress | null | undefined = undefined;
  /** Handshakes fallidos seguidos con el PC alcanzable (D8); `ready` lo pone a 0. */
  private handshakeFailures = 0;
  private nextHistoryId = 1;
  private self: PeerInfo | null = null;

  // --- API pública ---

  /** Conecta mientras la app esté en primer plano: activo → reanuda, segundo plano → para. */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.appStateSub = AppState.addEventListener('change', this.onAppState);
    this.pickerSub = onPickerSettled(() => this.pauseCheck.schedule());
    if (AppState.currentState !== 'background') this.resume();
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.pickerSub?.();
    this.pickerSub = null;
    this.pauseCheck.cancel();
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
   * Encola un archivo. Si no se puede, cierra `src` y dice por qué: `no_session` (sin sesión
   * lista; se puede reintentar) o `rejected` (el archivo no vale; el aviso ya está en lastError).
   */
  sendFile(src: FileSource): SendFileResult {
    const session = this.readySession();
    if (!session) {
      void src.close().catch(() => {});
      return { ok: false, reason: 'no_session' };
    }
    try {
      const id = session.sendFile(src);
      this.setError(null);
      return { ok: true, id };
    } catch (e) {
      void src.close().catch(() => {});
      const reason = classifySendError(e);
      if (reason === 'rejected') this.setError(INVALID_FILE_SIZE_MESSAGE);
      return { ok: false, reason };
    }
  }

  cancelTransfer(id: string): void {
    this.session?.cancelTransfer(id);
  }

  /** Copia un texto del historial al portapapeles sin reenviarlo al PC. */
  async copyFromHistory(text: string): Promise<void> {
    // se marca antes de escribir: el listener del portapapeles salta enseguida
    this.sync().current.markSynced(text);
    await writeClipboard(text);
  }

  /** Muestra un error en la interfaz (p. ej. FileTooLargeError al elegir un archivo). */
  reportError(message: string): void {
    this.setError(message);
  }

  clearError(): void {
    this.setError(null);
  }

  /** ShareSender avisa de si hay archivos compartidos por enviar (no se pausa mientras tanto). */
  setSharePending(pending: boolean): void {
    if (this.sharePending === pending) return;
    this.sharePending = pending;
    if (!pending) this.applyBackground();
  }

  /**
   * Empareja con el PC del QR: guarda el PC con su token, olvida lo sincronizado con el anterior
   * (el SyncKeeper se recrea desde settings) y reinicia la conexión.
   */
  pair(info: PairingInfo): void {
    this.pause();
    this.pc = pairedPcFromInfo(info);
    this.lastPc = null;
    this.keeper = null;
    this.handshakeFailures = 0;
    updateSettings({ pc: this.pc, lastSyncedHash: null, lastPc: null });
    this.update({ status: 'searching', transport: null, peerName: null, pc: pcView(this.pc), lastError: null });
    if (this.enabled && AppState.currentState !== 'background') this.resume();
  }

  /** Cierra la sesión y borra el emparejamiento (lastSyncedHash y lastPc no se tocan). */
  forgetPc(): void {
    this.pause({ status: 'unpaired', transport: null, peerName: null, pc: null, lastError: null });
    this.pc = null;
    this.handshakeFailures = 0;
    updateSettings({ pc: null });
  }

  // --- ciclo de vida ---

  private onAppState = (s: AppStateStatus) => {
    if (s === 'active') {
      // de vuelta en primer plano no queda ningún selector vivo (aunque no haya terminado)
      resetPickers();
      this.pauseCheck.cancel();
      this.resume();
    } else if (s === 'background') this.applyBackground(s);
  };

  /**
   * Segundo plano (también al cerrarse un selector o al acabar lo pendiente): pausa, o solo
   * para el vigilante si hay archivos o un compartir en marcha (I1). Un selector abierto
   * también manda la app a segundo plano: entonces no se hace nada (R26).
   */
  private applyBackground(appState: string = AppState.currentState): void {
    if (!this.enabled) return;
    const busy = hasPendingWork(this.state.transfers, this.sharePending);
    const decision = backgroundDecision({ appState, pickerOpen: isPickerOpen(), busy });
    if (decision === 'pause') this.pause();
    else if (decision === 'watcher_only') this.stopClipboardWatcher();
  }

  private resume(): void {
    if (!this.pc) {
      this.update({ status: 'unpaired' });
      return;
    }
    if (this.running) {
      // seguía conectado en segundo plano: solo vuelve el vigilante, y lo copiado mientras tanto
      if (!this.stopWatcher) {
        this.startClipboardWatcher();
        void readClipboard().then((text) => {
          if (text !== null && this.stopWatcher) this.onLocalText(text);
        });
      }
      return;
    }
    this.running = true;
    const gen = ++this.generation;
    this.startClipboardWatcher();
    startDiscovery();
    void this.loop(gen);
  }

  private startClipboardWatcher(): void {
    this.stopWatcher ??= startClipboardWatcher((text) => this.onLocalText(text));
  }

  private stopClipboardWatcher(): void {
    this.stopWatcher?.();
    this.stopWatcher = null;
  }

  /** Para la conexión; `to` es el estado en que queda (por defecto, buscando). */
  private pause(to?: Partial<ConnState>): void {
    if (!this.running) {
      if (to) this.update(to);
      return;
    }
    this.running = false;
    this.pauseCheck.cancel();
    this.stopClipboardWatcher();
    stopDiscovery();
    // antes de cambiar de generación para que lleguen los 'failed' de las transferencias en
    // curso; el anti-rebote vuelve al último hash confirmado al cerrarse (R29)
    this.session?.close('closed');
    this.session = null;
    this.ready = false;
    this.generation += 1;
    this.wake?.();
    this.update(to ?? { status: 'searching', transport: null, peerName: null });
  }

  private async loop(gen: number): Promise<void> {
    while (gen === this.generation) {
      const pc = this.pc;
      if (!pc) return; // sin emparejar no hay nada que buscar
      this.update({ status: 'searching', transport: null, peerName: null });
      let identity: KeyPair;
      try {
        identity = await loadIdentity();
      } catch {
        if (gen !== this.generation) return;
        this.setError(IDENTITY_FAILED);
        await this.sleep(RECONNECT_INTERVAL_MS);
        continue;
      }
      if (gen !== this.generation) return;
      const conn = await this.connectOnce(gen, pc);
      if (gen !== this.generation) {
        conn?.link.close();
        return;
      }
      if (conn) {
        const { reason, wasReady, readyForMs, tokenSent } = await this.runSession(conn.link, conn.transport, conn.addr, gen, pc, identity);
        if (gen !== this.generation) return;
        const outcome = closeOutcome(reason, { tokenSent, handshakeFailures: this.handshakeFailures, transport: conn.transport });
        if (outcome.kind === 'unpair') {
          this.unpair(outcome.message);
          return;
        }
        this.handshakeFailures = outcome.handshakeFailures;
        // la sesión funcionó el tiempo suficiente: se reintenta enseguida; si cae al poco, se espera
        if (reconnectDelayMs(wasReady, readyForMs, RECONNECT_INTERVAL_MS) === 0) continue;
      } else if (this.pc?.token != null) {
        // una vuelta entera sin llegar a ningún candidato con el emparejamiento por completar
        this.setError(PC_UNREACHABLE);
      }
      await this.sleep(RECONNECT_INTERVAL_MS);
    }
  }

  /** El PC rechazó el emparejamiento (o no se pudo verificar): se borra y se vuelve a la bienvenida. */
  private unpair(message: string): void {
    this.pc = null;
    this.handshakeFailures = 0;
    updateSettings({ pc: null });
    this.pause({ status: 'unpaired', transport: null, peerName: null, pc: null, lastError: message });
  }

  /**
   * WiFi (la última dirección que funcionó, las resueltas por mDNS con la huella de este PC y
   * las IPs del QR) y, si no, USB por 127.0.0.1. Cada intento tiene su propio plazo de CONNECT_TIMEOUT_MS.
   */
  private async connectOnce(gen: number, pc: PairedPc): Promise<{ link: Link; transport: Transport; addr: PcAddress | null } | null> {
    if (this.lastPc === undefined) this.lastPc = loadSettings().lastPc;
    const last = this.lastPc;
    const qr = pc.ips.map((host) => ({ host, port: pc.port }));
    // con una dirección guardada o las del QR no se espera a mDNS: se prueba ya y, si no, lo resuelto
    const resolved = await resolvedPcs(last || qr.length > 0 ? 0 : CONNECT_TIMEOUT_MS, fingerprint(hexToBytes(pc.publicKeyHex)));
    if (gen !== this.generation) return null;
    for (const addr of connectCandidates(last, resolved, qr)) {
      this.update({ status: 'connecting' });
      try {
        const link = await connectTcp(addr.host, addr.port, CONNECT_TIMEOUT_MS);
        // la dirección se recuerda en `ready`, no aquí: una IP del QR podría ser de otro dispositivo
        return { link, transport: 'wifi', addr }; // si cambió la generación, el bucle lo cierra
      } catch {
        // la siguiente
      }
      if (gen !== this.generation) return null;
    }
    try {
      return { link: await connectTcp(USB_HOST, DEFAULT_TCP_PORT, CONNECT_TIMEOUT_MS), transport: 'usb', addr: null };
    } catch {
      return null;
    }
  }

  private rememberPc(pc: PcAddress): void {
    const last = this.lastPc;
    if (last && last.host === pc.host && last.port === pc.port) return;
    this.lastPc = pc;
    updateSettings({ lastPc: pc });
  }

  private runSession(
    link: Link,
    transport: Transport,
    addr: PcAddress | null,
    gen: number,
    pc: PairedPc,
    identity: KeyPair,
  ): Promise<{ reason: string; wasReady: boolean; readyForMs: number; tokenSent: boolean }> {
    return new Promise((resolve) => {
      let wasReady = false;
      let readyAt = 0;
      const openedAt = Date.now();
      const session = new Session(link, {
        role: 'client',
        self: this.selfInfo(),
        identity,
        serverKey: hexToBytes(pc.publicKeyHex),
        pairingToken: pc.token,
        randomBytes: Crypto.getRandomBytes,
        clipSyncFor: () => this.sync().current,
        getLocalClip: () => this.localClipForStart(),
        openSink,
        newTransferId: () => bytesToHex(Crypto.getRandomBytes(16)),
      });
      this.session = session;
      this.ready = false;
      this.update({ status: 'connecting' });

      session.on('ready', (peer) => {
        if (gen !== this.generation) return;
        wasReady = true;
        readyAt = Date.now();
        // sin __DEV__: la medida de la fase 2 se toma en un build de release (`adb logcat`)
        console.log(`[clipsync] enlace abierto → ready: ${readyAt - openedAt} ms`);
        this.ready = true;
        this.handshakeFailures = 0;
        if (addr) this.rememberPc(addr);
        // el PC aceptó: el token ya no sirve (es de un solo uso) y el emparejamiento queda completo
        if (this.pc?.token != null) {
          this.pc = { ...this.pc, token: null };
          updateSettings({ pc: this.pc });
        }
        if (this.state.lastError === PC_UNREACHABLE || this.state.lastError === IDENTITY_FAILED) this.setError(null);
        this.update({ status: 'connected', transport, peerName: peer.deviceName, pc: pcView(this.pc) });
      });
      // solo lo que la Session envió de verdad en la regla de inicio (M4)
      session.on('startClipSent', (text) => {
        if (gen === this.generation) this.addTextOnce('out', text);
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
        // tras cualquier cierre se parte del último hash confirmado (R29)
        this.sync().renew();
        resolve({ reason, wasReady, readyForMs: wasReady ? Date.now() - readyAt : 0, tokenSent: pc.token !== null });
      });

      void session.start();
    });
  }

  // --- portapapeles ---

  /** Regla de inicio: el texto actual se anuncia en el hello (la sesión decide si se envía). */
  private async localClipForStart(): Promise<string | null> {
    const text = await readClipboard();
    if (text === null) return null;
    // la misma decisión que tomará la Session (también si el JSON no cabe)
    if (decideClip(this.sync().current, text) === 'too_large') this.setError(CLIP_TOO_LARGE);
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
    // si el socket estaba muerto, sendClip cerró la sesión y el texto no llegó
    const outcome = localSendOutcome(decision, this.readySession() === session);
    if (outcome === 'record') {
      this.addHistory({ kind: 'text', direction: 'out', text });
      this.setError(null);
    } else if (outcome === 'too_large') this.setError(CLIP_TOO_LARGE);
  }

  // --- archivos ---

  private onTransfer(u: TransferUpdate): void {
    this.logSpeed(u);
    if (u.state === 'done') {
      // las completadas pasan al historial, como en el PC
      this.update({ transfers: this.state.transfers.filter((t) => t.transferId !== u.transferId) });
      this.addHistory({ kind: 'file', direction: u.direction, fileName: u.name, location: u.location });
      this.applyBackground(); // al terminar lo pendiente en segundo plano, ahora sí se pausa (I1)
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
    if (isFinished(u)) this.applyBackground();
  }

  /** Velocidad de cada archivo terminado, para medir en release con `adb logcat -s ReactNativeJS`. */
  private logSpeed(u: TransferUpdate): void {
    if (!isFinished(u)) {
      if (!this.transferStarts.has(u.transferId)) this.transferStarts.set(u.transferId, Date.now());
      return;
    }
    const start = this.transferStarts.get(u.transferId);
    this.transferStarts.delete(u.transferId);
    if (u.state !== 'done' || start === undefined) return;
    const s = (Date.now() - start) / 1000;
    const mib = u.size / 1048576;
    const arrow = u.direction === 'out' ? 'móvil→PC' : 'PC→móvil';
    console.log(`[clipsync] archivo ${arrow}: ${mib.toFixed(1)} MiB en ${s.toFixed(1)} s → ${(mib / s).toFixed(2)} MiB/s`);
  }

  // --- utilidades ---

  private sync(): SyncKeeper {
    this.keeper ??= new SyncKeeper({
      load: () => loadSettings().lastSyncedHash,
      save: (hash) => updateSettings({ lastSyncedHash: hash }),
    });
    return this.keeper;
  }

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

// antes de la primera sesión: ChaCha20 y SHA-256 nativos (o @noble si no superan la comparación)
installNativeCrypto();

/** Instancia única de la app. */
export const connection = new ConnectionManager();
