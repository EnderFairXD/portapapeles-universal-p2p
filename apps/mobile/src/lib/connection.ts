// Conexión persistente con el PC: WiFi (mDNS), USB (adb reverse) o Bluetooth (RFCOMM), con reintentos.
import {
  DEFAULT_TCP_PORT,
  MAX_CLIP_IMAGE_BYTES,
  MAX_HISTORY,
  PURPOSE_CLIPBOARD,
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

import {
  clipboardHasImage,
  readClipboard,
  startClipboardWatcher,
  writeClipboard,
} from './clipboardWatcher';
import { bluetoothState, hasBluetoothPermission, listBondedDevices, requestBluetoothPermission } from './bluetooth';
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
import { deleteQuietly, fileSourceFromUri, FileTooLargeError, isPickerOpen, onPickerSettled, openSink, resetPickers, UnknownFileSizeError } from './files';
import {
  canWriteClipboard,
  ImageKeeper,
  ImageOutbox,
  isOwnWrite,
  PendingImageWrite,
  pendingExpired,
  startClipText,
  UnverifiedWrite,
  type PendingImage,
} from './imagePolicy';
import { cachedImageSource, discardTemp, keepForHistory, readClipboardImage, saveReceivedImage, setClipboardImage } from './images';
import { bytesToHex, hexToBytes, pairedPcFromInfo, type PairedPc } from './pairing';
import { connectCandidates, type PcAddress } from './pcAddress';
import { connectRfcomm } from './rfcommLink';
import { pickScreenshots, screenshotMime, type ShotAsset } from './screenshotPolicy';
import { ensurePhotoAccess, startScreenshotWatcher } from './screenshots';
import { getDeviceId, loadSettings, updateSettings } from './settings';
import { SyncKeeper } from './syncKeeper';
import { connectTcp } from './tcpLink';
import {
  BLUETOOTH_ISSUE_MESSAGES,
  UPGRADE_INTERVAL_MS,
  betterTransports,
  btCoolingDown,
  candidates,
  modeChangeAction,
  parseBtAddress,
  shouldUpgrade,
  transportTimeoutMs,
  type BluetoothIssue,
  type PolicyCtx,
  type Transport,
  type TransportMode,
} from './transportPolicy';
import type { BondedDevice } from '../../modules/clipsync-native';

export type ConnStatus = 'unpaired' | 'searching' | 'connecting' | 'connected';
export type { Transport, TransportMode, BluetoothIssue } from './transportPolicy';
export type { BondedDevice } from '../../modules/clipsync-native';

export interface HistoryEntry {
  id: string;
  kind: 'text' | 'file' | 'image';
  direction: 'in' | 'out';
  text?: string;
  fileName?: string;
  /** Archivo recibido: URI content:// del documento guardado. */
  location?: string;
  /**
   * Imagen: copia en Paths.document/images (file://), o la URI que dio quien la envió con
   * `sendClipboardImageFile` (p. ej. el content:// de una captura).
   */
  imageUri?: string;
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
  /** Enviar capturas está activado pero falta el permiso de fotos (denegado o solo algunas fotos). */
  photoAccessMissing: boolean;
  /** Medio elegido en ajustes (`auto` por defecto). */
  transportMode: TransportMode;
  /** Dirección Bluetooth del PC (del QR o elegida de los emparejados); null si no hay. */
  btAddress: string | null;
  /** Por qué Bluetooth no se puede usar ahora (null si se puede o no se ha comprobado aún). */
  bluetoothIssue: BluetoothIssue | null;
}

/** Resultado de `sendClipboardImageFile`: además, `duplicate` si el PC ya la tiene o ya va de camino. */
export type ImageSendResult = SendFileResult | { ok: false; reason: 'duplicate' };

/** Terminadas (fallidas o canceladas) que se conservan en la lista, como en el PC. */
export const MAX_FINISHED_TRANSFERS = 5;
const USB_HOST = '127.0.0.1';

const CLIP_TOO_LARGE = 'Texto demasiado grande para sincronizar (máx. 1 MB)';
const PC_UNREACHABLE = 'PC no alcanzable. Comprueba que el móvil y el PC están en la misma red WiFi.';
const IDENTITY_FAILED = 'No se pudo acceder al almacén seguro del móvil.';
/** Avisos de modo fijo cuando el único medio elegido no conecta. */
const USB_UNREACHABLE = 'PC no alcanzable por USB. Conecta el cable y activa la depuración USB.';
const BT_UNREACHABLE = 'No se pudo conectar por Bluetooth. Comprueba que el PC tiene Bluetooth y ClipSync abiertos.';
/** Avisos que se borran solos al conectar. */
const TRANSPORT_ERRORS: ReadonlySet<string> = new Set([
  PC_UNREACHABLE,
  IDENTITY_FAILED,
  USB_UNREACHABLE,
  BT_UNREACHABLE,
  ...Object.values(BLUETOOTH_ISSUE_MESSAGES),
]);
const CLIP_WRITE_FAILED = 'No se pudo escribir en el portapapeles';
export const IMAGE_TOO_LARGE = 'Imagen demasiado grande para sincronizar (máx. 20 MB)';
export const IMAGE_WRITE_FAILED = 'No se pudo poner la imagen en el portapapeles';
export const GALLERY_FAILED = 'No se pudo guardar en la galería';
/** Margen tras cerrarse un selector antes de pausar si la app sigue en segundo plano. */
const PICKER_SETTLE_MS = 1000;
/** Reintentos de una captura que no se pudo abrir antes de darla por perdida. */
const SHOT_MAX_ATTEMPTS = 3;
/** Ids de capturas recordados para no repetirlas (se recorta al pasar de aquí). */
const SHOT_IDS_KEPT = 200;

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

/** Enlace ya abierto con el medio por el que se abrió. */
interface OpenLink {
  link: Link;
  transport: Transport;
  addr: PcAddress | null;
}

export class ConnectionManager {
  private readonly initial = loadSettings();
  /** El PC emparejado (settings.json); null hasta escanear su QR. */
  private pc: PairedPc | null = this.initial.pc;
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
    photoAccessMissing: false,
    transportMode: this.initial.transportMode,
    btAddress: this.initial.btAddress,
    bluetoothIssue: null,
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
  /** Vigilante de capturas nuevas (solo con «Enviar capturas» activado y permiso de fotos). */
  private stopShots: (() => void) | null = null;
  private shotsStarting = false;
  /** Capturas ya encoladas (o descartadas): no se repiten aunque sigan en la ventana de 15 min. */
  private readonly sentShotIds = new Set<string>();
  private readonly shotAttempts = new Map<string, number>();

  private session: Session | null = null;
  private ready = false;
  /** Anti-rebote del móvil (con un solo PC), persistido en settings.json (R29). */
  private keeper: SyncKeeper | null = null;
  /** Anti-rebote de imágenes, persistido en settings.json (`lastImageHash`, R29). */
  private imageKeeper: ImageKeeper | null = null;
  /** R7: como mucho una imagen del portapapeles en cola y otra en vuelo. */
  private readonly outbox = new ImageOutbox(() => this.images().current);
  /** Imágenes salientes: qué guardar en el historial al terminar (y qué borrar de la caché). */
  private readonly imageSends = new Map<string, { cacheUri?: string; imageUri?: string }>();
  /** Lecturas y escrituras de imágenes, de una en una (nunca dos a la vez sobre el portapapeles). */
  private imageWork: Promise<void> = Promise.resolve();
  private imageCheckQueued = false;
  /** Imagen recibida en segundo plano (o sin poder leerla de vuelta): se escribe al pasar a 'active'. */
  private readonly pendingWrite = new PendingImageWrite();
  /** Escritura sin lectura de vuelta: la primera imagen distinta que se lea (10 s) es la suya recodificada. */
  private readonly unverified = new UnverifiedWrite();
  /** Hash de lectura de vuelta de la última imagen que escribió la app (hasta que se vea otra). */
  private lastWrittenImage: string | null = null;
  /** Última dirección WiFi del PC que funcionó; se prueba la primera. */
  private lastPc: PcAddress | null | undefined = undefined;
  /** Handshakes fallidos seguidos con el PC alcanzable (D8); `ready` lo pone a 0. */
  private handshakeFailures = 0;
  private nextHistoryId = 1;
  private self: PeerInfo | null = null;
  /** Ya se pidió BLUETOOTH_CONNECT en esta ejecución: no se vuelve a abrir el diálogo solo. */
  private btPermissionAsked = false;
  /** Cuándo falló el último intento de Bluetooth (frena el modo Auto; null si no falló). */
  private btFailedAt: number | null = null;
  /** Cambio de medio en marcha: enlace nuevo ya abierto que el bucle usará tras cerrar la sesión vieja. */
  private upgradeLink: OpenLink | null = null;
  private upgradeTimer: ReturnType<typeof setInterval> | null = null;
  private upgrading = false;

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

  /**
   * Envía una imagen al portapapeles del PC (`purpose: 'clipboard'`; se fuerza aquí). Para la
   * Tarea 9 (capturas) y para las imágenes copiadas en el móvil.
   * - Con `hash` (SHA-256 hex de lo que da `getImageAsync({ format: 'png' })`): entra en el
   *   anti-rebote (ImageSync) y en R7 (sustituye a la que espere en cola); `duplicate` si el PC
   *   ya la tiene o ya va de camino.
   * - Sin `hash` (capturas): se encola sin más; varias seguidas esperan su turno.
   * - `imageUri`: miniatura del historial cuando llegue (si no, no hay entrada de historial).
   * Más de 20 MiB → `rejected` con el aviso de tamaño. Si no se envía, cierra `src`.
   */
  sendClipboardImageFile(src: FileSource, hash?: string, imageUri?: string): ImageSendResult {
    return this.queueImage(src, hash, { imageUri });
  }

  /** Vuelve a poner un texto o una imagen del historial en el portapapeles sin reenviarlo al PC. */
  async copyFromHistory(item: string | HistoryEntry): Promise<void> {
    if (typeof item !== 'string' && item.kind === 'image') {
      const uri = item.imageUri;
      if (uri) await this.runImageWork(() => this.copyImageFromHistory(uri));
      return;
    }
    const text = typeof item === 'string' ? item : item.text;
    if (!text) return; // un archivo, o la fila de una imagen sin miniatura todavía (Tarea 10)
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
    this.imageKeeper = null;
    this.lastWrittenImage = null;
    this.unverified.clear();
    this.dropPendingImage();
    this.handshakeFailures = 0;
    // un QR sin `bt` (PC sin Bluetooth o versión antigua) borra la dirección del PC anterior
    const btAddress = info.bt ?? null;
    this.btFailedAt = null;
    updateSettings({ pc: this.pc, lastSyncedHash: null, lastImageHash: null, lastPc: null, btAddress });
    this.update({ status: 'searching', transport: null, peerName: null, pc: pcView(this.pc), lastError: null, btAddress });
    if (this.enabled && AppState.currentState !== 'background') this.resume();
  }

  /** Cierra la sesión y borra el emparejamiento (lastSyncedHash y lastPc no se tocan). */
  forgetPc(): void {
    this.pause({ status: 'unpaired', transport: null, peerName: null, pc: null, lastError: null });
    this.pc = null;
    this.dropPendingImage();
    this.handshakeFailures = 0;
    updateSettings({ pc: null, btAddress: null });
    this.update({ btAddress: null });
  }

  /** Cambia el medio de conexión. Un medio fijo distinto del actual reinicia la conexión. */
  setTransportMode(mode: TransportMode): void {
    if (this.state.transportMode === mode) return;
    updateSettings({ transportMode: mode });
    this.update({ transportMode: mode });
    if (this.state.lastError !== null && TRANSPORT_ERRORS.has(this.state.lastError)) this.setError(null);
    if (!this.running) return;
    // con transferencias en curso o en cola no se corta la sesión: el cambio espera (R2) y
    // `applyPendingMode` lo aplica al terminar; la interfaz lo deduce con `modeChangePending`
    const action = modeChangeAction(mode, this.state.transport, this.isBusy());
    if (action === 'restart') this.restart();
    else if (action === 'wake') this.wake?.(); // sin sesión: reintenta ya con el medio nuevo
  }

  /** Aplica un cambio de modo aplazado en cuanto no queda nada pendiente. */
  private applyPendingMode(): void {
    if (!this.running) return;
    if (modeChangeAction(this.state.transportMode, this.state.transport, this.isBusy()) === 'restart') this.restart();
  }

  /** Fija la dirección Bluetooth del PC (de la lista de emparejados) o la borra con null. */
  setBtAddress(address: string | null): void {
    const value = parseBtAddress(address);
    if (this.state.btAddress === value) return;
    updateSettings({ btAddress: value });
    this.btFailedAt = null;
    this.update({ btAddress: value });
    this.wake?.();
  }

  /**
   * Dispositivos Bluetooth ya emparejados en el sistema, para elegir el PC. Pide BLUETOOTH_CONNECT si
   * falta; sin permiso devuelve [] y avisa en lastError.
   */
  async bondedDevices(): Promise<BondedDevice[]> {
    this.btPermissionAsked = true;
    if (!(await requestBluetoothPermission())) {
      this.setError(BLUETOOTH_ISSUE_MESSAGES.no_permission);
      return [];
    }
    return listBondedDevices();
  }

  /** Pide BLUETOOTH_CONNECT (Android 12+); true si está concedido. */
  async requestBluetoothPermission(): Promise<boolean> {
    this.btPermissionAsked = true;
    const granted = await requestBluetoothPermission();
    if (granted && this.state.lastError === BLUETOOTH_ISSUE_MESSAGES.no_permission) this.setError(null);
    if (granted) this.wake?.();
    return granted;
  }

  // --- ciclo de vida ---

  private onAppState = (s: AppStateStatus) => {
    if (s === 'active') {
      // de vuelta en primer plano no queda ningún selector vivo (aunque no haya terminado)
      resetPickers();
      this.pauseCheck.cancel();
      // antes que cualquier revisión de imágenes: la cadena las atiende por orden
      this.flushPendingImage();
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
    this.applyPendingMode();
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
      void this.startScreenshots();
      if (!this.stopWatcher) {
        this.startClipboardWatcher();
        const watching = () => this.stopWatcher !== null;
        void clipboardHasImage().then(async (image) => {
          if (!watching()) return;
          if (image) {
            this.queueImageCheck();
            return;
          }
          const text = await readClipboard();
          if (text !== null && watching()) this.onLocalText(text);
        });
      }
      return;
    }
    this.running = true;
    const gen = ++this.generation;
    this.startClipboardWatcher();
    void this.startScreenshots();
    startDiscovery();
    void this.loop(gen);
  }

  /** Corta la conexión y la reabre (cambio de modo con una sesión por un medio que ya no vale). */
  private restart(): void {
    this.pause();
    if (this.enabled && AppState.currentState !== 'background') this.resume();
  }

  private startClipboardWatcher(): void {
    this.stopWatcher ??= startClipboardWatcher({
      onText: (text) => this.onLocalText(text),
      onImage: () => this.queueImageCheck(),
      onMissed: () => this.recheckClipboard(),
    });
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
    this.stopScreenshots();
    stopDiscovery();
    this.stopUpgradeWatch();
    this.dropUpgradeLink();
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
      // en un cambio de medio el enlace nuevo ya está abierto: no se parpadea a «buscando»
      if (!this.upgradeLink) this.update({ status: 'searching', transport: null, peerName: null });
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
      } else if (this.pc?.token != null && loadSettings().transportMode === 'auto') {
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
    updateSettings({ pc: null, btAddress: null });
    this.pause({ status: 'unpaired', transport: null, peerName: null, pc: null, lastError: message, btAddress: null });
  }

  /**
   * Prueba los medios que dicta `candidates` (Auto: WiFi 2 s → USB 2 s → Bluetooth 8 s; modo fijo:
   * solo el elegido, con el motivo en lastError si falla). Si hay un enlace nuevo ya abierto por un
   * cambio de medio, lo usa sin volver a conectar.
   */
  private async connectOnce(gen: number, pc: PairedPc): Promise<OpenLink | null> {
    const handoff = this.upgradeLink;
    if (handoff) {
      this.upgradeLink = null;
      return handoff;
    }
    const mode = loadSettings().transportMode;
    const ctx = await this.policyCtx(loadSettings().btAddress);
    if (gen !== this.generation) return null;
    const plan = candidates(mode, ctx);
    this.update({ bluetoothIssue: plan.issue });
    if (plan.reason) {
      this.setError(plan.reason);
      return null;
    }
    let reason: string | null = null;
    for (const transport of plan.transports) {
      if (transport === 'bluetooth' && ctx.btPermission !== 'granted') {
        // primer uso: se pide una sola vez por ejecución; el diálogo no pausa la sesión (withPicker)
        this.btPermissionAsked = true;
        const granted = await requestBluetoothPermission();
        if (gen !== this.generation) return null;
        if (!granted) {
          this.update({ bluetoothIssue: 'no_permission' });
          if (mode !== 'auto') reason = BLUETOOTH_ISSUE_MESSAGES.no_permission;
          continue;
        }
        this.update({ bluetoothIssue: null });
      }
      const conn = await this.connectVia(transport, gen, pc, ctx.btAddress, true);
      if (gen !== this.generation) {
        conn?.link.close();
        return null;
      }
      if (conn) {
        if (transport === 'bluetooth') this.btFailedAt = null;
        return conn;
      }
      if (transport === 'bluetooth') this.btFailedAt = Date.now();
    }
    if (mode !== 'auto' && reason === null && plan.transports.length > 0) {
      reason = mode === 'wifi' ? PC_UNREACHABLE : mode === 'usb' ? USB_UNREACHABLE : BT_UNREACHABLE;
    }
    if (reason) this.setError(reason);
    return null;
  }

  /** Lo que el bucle necesita saber de Bluetooth para elegir los medios. */
  private async policyCtx(btAddress: string | null): Promise<PolicyCtx> {
    const btState = bluetoothState();
    let btPermission: PolicyCtx['btPermission'] = 'granted';
    // el permiso solo importa si hay a quién conectar y adaptador
    if (btAddress !== null && btState !== 'unavailable' && !(await hasBluetoothPermission())) {
      btPermission = this.btPermissionAsked ? 'denied' : 'undetermined';
    }
    return { btAddress, btPermission, btState, btCoolingDown: btCoolingDown(this.btFailedAt, Date.now()) };
  }

  /**
   * Un solo medio. WiFi: la última dirección que funcionó, las resueltas por mDNS con la huella de
   * este PC y las IPs del QR. Cada intento tiene su plazo (`transportTimeoutMs`). Con `announce`
   * el estado pasa a «conectando»; la búsqueda de un medio mejor lo hace en silencio.
   */
  private async connectVia(
    transport: Transport,
    gen: number,
    pc: PairedPc,
    btAddress: string | null,
    announce: boolean,
  ): Promise<OpenLink | null> {
    const timeout = transportTimeoutMs(transport);
    if (transport === 'usb') {
      try {
        return { link: await connectTcp(USB_HOST, DEFAULT_TCP_PORT, timeout), transport, addr: null };
      } catch {
        return null;
      }
    }
    if (transport === 'bluetooth') {
      if (btAddress === null) return null;
      if (announce) this.update({ status: 'connecting' });
      try {
        return { link: await connectRfcomm(btAddress, timeout), transport, addr: null };
      } catch {
        return null;
      }
    }
    if (this.lastPc === undefined) this.lastPc = loadSettings().lastPc;
    const last = this.lastPc;
    const qr = pc.ips.map((host) => ({ host, port: pc.port }));
    // con una dirección guardada o las del QR no se espera a mDNS: se prueba ya y, si no, lo resuelto
    const resolved = await resolvedPcs(last || qr.length > 0 ? 0 : timeout, fingerprint(hexToBytes(pc.publicKeyHex)));
    if (gen !== this.generation) return null;
    for (const addr of connectCandidates(last, resolved, qr)) {
      if (announce) this.update({ status: 'connecting' });
      try {
        const link = await connectTcp(addr.host, addr.port, timeout);
        // la dirección se recuerda en `ready`, no aquí: una IP del QR podría ser de otro dispositivo
        return { link, transport, addr }; // si cambió la generación, el bucle lo cierra
      } catch {
        // la siguiente
      }
      if (gen !== this.generation) return null;
    }
    return null;
  }

  // --- cambio a un medio mejor ---

  /** Hay archivos en cola o en curso, o un compartir sin enviar: no se cambia de medio. */
  private isBusy(): boolean {
    return hasPendingWork(this.state.transfers, this.sharePending);
  }

  private dropUpgradeLink(): void {
    this.upgradeLink?.link.close();
    this.upgradeLink = null;
  }

  private stopUpgradeWatch(): void {
    if (this.upgradeTimer) clearInterval(this.upgradeTimer);
    this.upgradeTimer = null;
  }

  /** Estando en un medio peor (Auto), cada 30 s mira si hay uno mejor. */
  private startUpgradeWatch(gen: number, session: Session, transport: Transport, pc: PairedPc, readyAt: number): void {
    this.stopUpgradeWatch();
    if (betterTransports(transport).length === 0) return;
    this.upgradeTimer = setInterval(() => {
      void this.checkUpgrade(gen, session, transport, pc, readyAt);
    }, UPGRADE_INTERVAL_MS);
  }

  /**
   * Abre (solo el enlace, sin sesión) un medio mejor. Si sigue sin haber transferencias, cierra la
   * sesión vieja y el bucle arranca la nueva sobre ese enlace; así nunca coexisten dos sesiones del
   * mismo dispositivo (el PC cerraría una con `replaced`). Si ya hay trabajo, descarta el enlace y
   * lo vuelve a intentar en el siguiente turno.
   */
  private async checkUpgrade(gen: number, session: Session, transport: Transport, pc: PairedPc, readyAt: number): Promise<void> {
    const stale = () => gen !== this.generation || this.session !== session || !this.ready;
    if (this.upgrading || stale()) return;
    const mode = loadSettings().transportMode;
    if (!shouldUpgrade(transport, mode, { connectedForMs: Date.now() - readyAt, busy: this.isBusy() })) return;
    this.upgrading = true;
    try {
      let better: OpenLink | null = null;
      for (const t of betterTransports(transport)) {
        better = await this.connectVia(t, gen, pc, null, false);
        if (better || stale()) break;
      }
      if (!better) return;
      // durante la conexión puede haber empezado una transferencia o cerrarse la sesión
      if (stale() || this.isBusy()) {
        better.link.close();
        return;
      }
      this.upgradeLink = better;
      this.stopUpgradeWatch();
      session.close('closed');
    } finally {
      this.upgrading = false;
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
        if (this.state.lastError !== null && TRANSPORT_ERRORS.has(this.state.lastError)) this.setError(null);
        this.update({ status: 'connected', transport, peerName: peer.deviceName, pc: pcView(this.pc) });
        this.startUpgradeWatch(gen, session, transport, pc, readyAt);
        // regla de inicio de imágenes: la actual del portapapeles, si el PC no la tiene
        void clipboardHasImage().then((image) => {
          if (image && gen === this.generation) this.queueImageCheck();
        });
      });
      // solo lo que la Session envió de verdad en la regla de inicio (M4)
      session.on('startClipSent', (text) => {
        if (gen === this.generation) this.addTextOnce('out', text);
      });
      session.on('clip', (text) => {
        if (gen !== this.generation) return;
        this.addTextOnce('in', text);
        this.dropPendingImage(); // el texto es lo último del portapapeles: la imagen pendiente ya no va
        // el listener saltará con este texto; el anti-rebote ya lo tiene marcado
        writeClipboard(text).catch(() => this.setError(CLIP_WRITE_FAILED));
      });
      session.on('transfer', (u) => this.onTransfer(normalize(u)));
      session.on('closed', (reason) => {
        if (this.session === session) {
          this.stopUpgradeWatch();
          this.session = null;
          this.ready = false;
        }
        // tras cualquier cierre se parte del último hash confirmado (R29), también en imágenes
        this.sync().renew();
        this.images().renew();
        this.outbox.clear();
        resolve({ reason, wasReady, readyForMs: wasReady ? Date.now() - readyAt : 0, tokenSent: pc.token !== null });
      });

      void session.start();
    });
  }

  // --- portapapeles ---

  /** Regla de inicio: el texto actual se anuncia en el hello (la sesión decide si se envía). */
  private async localClipForStart(): Promise<string | null> {
    // con una imagen en el portapapeles solo se envía la imagen (la regla de inicio de imágenes)
    const text = await startClipText(await clipboardHasImage(), readClipboard);
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

  // --- capturas ---

  /** Ajustes: se activó o desactivó «Enviar capturas»; arranca o para el vigilante al momento. */
  refreshScreenshots(): void {
    this.stopScreenshots();
    if (this.running) void this.startScreenshots();
    else this.update({ photoAccessMissing: false });
  }

  private stopScreenshots(): void {
    this.stopShots?.();
    this.stopShots = null;
  }

  /** Arranca el vigilante si está activado y hay permiso completo; si no, avisa de que falta. */
  private async startScreenshots(): Promise<void> {
    if (this.stopShots || this.shotsStarting) return;
    if (!loadSettings().sendScreenshots) {
      this.update({ photoAccessMissing: false });
      return;
    }
    this.shotsStarting = true;
    const gen = this.generation;
    let access: Awaited<ReturnType<typeof ensurePhotoAccess>>;
    try {
      access = await ensurePhotoAccess();
    } finally {
      this.shotsStarting = false;
    }
    // si mientras tanto se pausó o se desactivó, no arranca
    if (gen !== this.generation || !this.running || this.stopShots || !loadSettings().sendScreenshots) return;
    this.update({ photoAccessMissing: access !== 'full' });
    if (access !== 'full') return;
    // la primera vez se parte de ahora: lo anterior no se envía
    if (loadSettings().lastScreenshotCheck === null) updateSettings({ lastScreenshotCheck: Date.now() });
    this.stopShots = startScreenshotWatcher((shots) => this.onScreenshots(shots));
  }

  /**
   * Candidatas del vigilante: se envían las nuevas, de la más antigua a la más reciente, y
   * `lastScreenshotCheck` avanza hasta la última tratada. Sin sesión lista no se toca nada:
   * se reintenta en el siguiente turno.
   */
  private onScreenshots(candidates: ShotAsset[]): void {
    if (!this.readySession()) return;
    const since = loadSettings().lastScreenshotCheck;
    const picked = pickScreenshots(candidates, since, Date.now(), this.sentShotIds).reverse();
    let handled = since;
    for (const shot of picked) {
      if (!this.sendScreenshot(shot)) break;
      handled = Math.max(handled ?? 0, shot.creationTime);
    }
    if (handled !== since) updateSettings({ lastScreenshotCheck: handled });
  }

  /** true si la captura quedó tratada (encolada o descartada); false si hay que reintentar. */
  private sendScreenshot(shot: ShotAsset): boolean {
    const done = () => {
      this.sentShotIds.add(shot.id);
      this.shotAttempts.delete(shot.id);
      if (this.sentShotIds.size > SHOT_IDS_KEPT) {
        const oldest = this.sentShotIds.values().next().value;
        if (oldest !== undefined) this.sentShotIds.delete(oldest);
      }
      return true;
    };
    const mime = screenshotMime(shot.filename);
    if (!mime) return done(); // formato que el PC no admite (p. ej. HEIC)
    let src: FileSource;
    try {
      src = fileSourceFromUri(shot.uri, shot.filename ?? 'captura', mime, -1);
    } catch (e) {
      if (e instanceof FileTooLargeError || e instanceof UnknownFileSizeError) return done();
      const attempts = (this.shotAttempts.get(shot.id) ?? 0) + 1;
      this.shotAttempts.set(shot.id, attempts);
      return attempts >= SHOT_MAX_ATTEMPTS ? done() : false;
    }
    const result = this.sendClipboardImageFile(src, undefined, shot.uri);
    if (result.ok || result.reason === 'rejected') return done();
    return false; // sin sesión: ya se reintentará
  }

  // --- archivos ---

  private onTransfer(u: TransferUpdate): void {
    this.logSpeed(u);
    if (u.purpose === PURPOSE_CLIPBOARD) this.onImageTransfer(u);
    if (u.state === 'done' && u.purpose === PURPOSE_CLIPBOARD) {
      // no van a Descargas: el historial las recoge al escribirlas o al llegar al PC
      this.update({ transfers: this.state.transfers.filter((t) => t.transferId !== u.transferId) });
      this.applyBackground();
      return;
    }
    if (u.state === 'cancelled' && u.purpose === PURPOSE_CLIPBOARD && u.direction === 'out') {
      // sustituida por otra más nueva (R7): no se muestra como cancelada
      this.update({ transfers: this.state.transfers.filter((t) => t.transferId !== u.transferId) });
      this.applyBackground();
      return;
    }
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

  // --- imágenes del portapapeles ---

  private onImageTransfer(u: TransferUpdate): void {
    if (u.direction === 'in') {
      if (u.state === 'done' && u.location) {
        const path = u.location;
        const name = u.name;
        this.queueImageWork(() => this.onImageReceived(path, name));
      }
      return;
    }
    if (u.state === 'active') {
      this.outbox.started(u.transferId);
      return;
    }
    if (!isFinished(u)) return;
    this.outbox.finished(u.transferId, u.state === 'done');
    const send = this.imageSends.get(u.transferId);
    this.imageSends.delete(u.transferId);
    if (!send) return;
    if (u.state === 'done') {
      const imageUri = send.cacheUri ? keepForHistory(send.cacheUri) : send.imageUri;
      if (imageUri) this.addHistory({ kind: 'image', direction: 'out', fileName: u.name, imageUri });
    } else if (send.cacheUri) {
      deleteQuietly(send.cacheUri);
    }
  }

  /**
   * Recibida del PC: galería y copia del historial al momento; el portapapeles ahora si la app
   * está en primer plano y se puede leer de vuelta, y si no, al pasar a 'active'.
   */
  private async onImageReceived(path: string, name: string): Promise<void> {
    this.dropPendingImage(); // la nueva sustituye a una pendiente anterior
    const r = await saveReceivedImage(path, loadSettings().saveToGallery);
    if (r.galleryFailed) this.setError(GALLERY_FAILED);
    if (r.imageUri) this.addHistory({ kind: 'image', direction: 'in', fileName: name, imageUri: r.imageUri });
    await this.writeImageToClipboard({ uri: r.clipUri, temp: r.temp, at: Date.now() }, false);
  }

  /** Pone la imagen en el portapapeles, o la deja pendiente si ahora no se puede (segundo plano). */
  private async writeImageToClipboard(image: PendingImage, lastTry: boolean): Promise<void> {
    if (!canWriteClipboard(AppState.currentState)) {
      this.deferImage(image);
      return;
    }
    const w = await setClipboardImage(image.uri, lastTry);
    if (w.kind === 'unreadable') {
      this.deferImage(image);
      return;
    }
    discardTemp(image.temp);
    if (w.kind === 'failed') {
      this.setError(IMAGE_WRITE_FAILED);
      return;
    }
    this.adoptWrittenImage(w.hash, w.unverified === true);
  }

  /** Lo que la app acaba de escribir es lo último del portapapeles: ni rebota ni deja en cola a otra. */
  private adoptWrittenImage(hash: string, unverified: boolean): void {
    this.images().current.markSynced(hash);
    this.lastWrittenImage = hash;
    if (unverified) this.unverified.arm(Date.now());
    else this.unverified.clear();
    // la que esperaba en cola ya no es lo último del portapapeles
    const queued = this.outbox.dropQueued();
    if (queued) this.session?.cancelTransfer(queued.id);
  }

  private deferImage(image: PendingImage): void {
    const old = this.pendingWrite.set(image);
    if (old) discardTemp(old.temp);
  }

  /** Descarta la imagen pendiente (otra más nueva, un texto o un cambio de PC la sustituye). */
  private dropPendingImage(): void {
    const old = this.pendingWrite.clear();
    if (old) discardTemp(old.temp);
  }

  /** Vuelta a primer plano: escribe la imagen que llegó en segundo plano, antes de revisar nada más. */
  private flushPendingImage(): void {
    const image = this.pendingWrite.take();
    if (!image) return;
    if (pendingExpired(image, Date.now())) {
      discardTemp(image.temp); // demasiado vieja: la entrada del historial se queda
      return;
    }
    this.queueImageWork(() => this.writeImageToClipboard(image, true));
  }

  /**
   * Se descartaron avisos del portapapeles mientras la app escribía una imagen: se revisa el
   * portapapeles por la cadena de imágenes (imagen primero; si no hay, el texto).
   */
  private recheckClipboard(): void {
    if (!this.stopWatcher) return;
    this.queueImageWork(async () => {
      if (!this.stopWatcher) return;
      if (await clipboardHasImage()) {
        await this.onLocalImage();
        return;
      }
      const text = await readClipboard();
      if (text !== null && this.stopWatcher !== null) this.onLocalText(text);
    });
  }

  /** Lanza si no se pudo poner en el portapapeles (la interfaz avisa «No se pudo copiar»). */
  private async copyImageFromHistory(uri: string): Promise<void> {
    // pendiente de una recibida en segundo plano: lo elegido ahora es lo último del portapapeles
    this.dropPendingImage();
    const w = await setClipboardImage(uri, true);
    if (w.kind !== 'ok') throw new Error(IMAGE_WRITE_FAILED);
    this.adoptWrittenImage(w.hash, w.unverified === true);
  }

  /** Una lectura pendiente basta para cualquier número de avisos seguidos del portapapeles. */
  private queueImageCheck(): void {
    if (this.imageCheckQueued) return;
    this.imageCheckQueued = true;
    this.queueImageWork(async () => {
      this.imageCheckQueued = false;
      await this.onLocalImage();
    });
  }

  /** Detrás de lo que ya esté en marcha con imágenes; el resultado (o el error) es solo de `fn`. */
  private runImageWork(fn: () => Promise<void>): Promise<void> {
    const run = this.imageWork.then(fn);
    this.imageWork = run.catch((e: unknown) => {
      console.warn(`[clipsync] imagen del portapapeles: ${String(e)}`);
    });
    return run;
  }

  /** Como runImageWork, sin esperar: el error ya queda en el registro. */
  private queueImageWork(fn: () => Promise<void>): void {
    this.runImageWork(fn).catch(() => {});
  }

  /** Imagen copiada en el móvil (o la actual al conectar): se envía si el PC no la tiene. */
  private async onLocalImage(): Promise<void> {
    // sin sesión lista no se envía: la regla de inicio la mandará al conectar
    if (!this.readySession()) return;
    const img = await readClipboardImage();
    if (!img || !this.readySession()) return;
    if (isOwnWrite(img.hash, this.lastWrittenImage)) return;
    if (this.unverified.take(Date.now())) {
      // la imagen que escribimos sin poder leerla de vuelta, recodificada: se adopta, no se envía
      this.images().current.markSynced(img.hash);
      this.lastWrittenImage = img.hash;
      return;
    }
    this.lastWrittenImage = null; // ya hay otra: si vuelve la escrita, es una copia nueva
    if (this.images().current.isDuplicate(img.hash)) return;
    if (img.bytes.length > MAX_CLIP_IMAGE_BYTES) {
      this.setError(IMAGE_TOO_LARGE);
      return;
    }
    let cached: { source: FileSource; uri: string };
    try {
      cached = cachedImageSource(img.bytes);
    } catch {
      return; // sin espacio en la caché: se reintenta con la siguiente copia
    }
    const result = this.queueImage(cached.source, img.hash, { cacheUri: cached.uri });
    if (!result.ok) deleteQuietly(cached.uri);
  }

  /** Encola una imagen con `purpose: 'clipboard'` (R7 si lleva hash). Cierra `src` si no sale. */
  private queueImage(src: FileSource, hash: string | undefined, keep: { cacheUri?: string; imageUri?: string }): ImageSendResult {
    const session = this.readySession();
    if (!session) {
      void src.close().catch(() => {});
      return { ok: false, reason: 'no_session' };
    }
    if (hash !== undefined) {
      const offer = this.outbox.offer(hash);
      if (!offer.send) {
        if (offer.cancel) session.cancelTransfer(offer.cancel);
        void src.close().catch(() => {});
        return { ok: false, reason: 'duplicate' };
      }
    }
    if (src.size > MAX_CLIP_IMAGE_BYTES) {
      void src.close().catch(() => {});
      this.setError(IMAGE_TOO_LARGE);
      return { ok: false, reason: 'rejected' };
    }
    // la que esperaba en cola sobra (ya olvidada: su 'cancelled' no revierte la nueva)
    const replaced = hash !== undefined ? this.outbox.dropQueued() : null;
    if (replaced) session.cancelTransfer(replaced.id);
    let id: string;
    try {
      id = session.sendFile({ ...src, purpose: PURPOSE_CLIPBOARD });
    } catch (e) {
      void src.close().catch(() => {});
      if (replaced) this.outbox.settle(replaced.hash, false);
      return { ok: false, reason: classifySendError(e) };
    }
    if (this.readySession() !== session) {
      // la escritura falló y la sesión se cerró dentro de sendFile: no se marca nada
      return { ok: false, reason: 'no_session' };
    }
    this.imageSends.set(id, keep);
    if (hash !== undefined) {
      // sendFile ya pudo emitir 'active' si no había otro archivo en curso
      const active = this.state.transfers.some((t) => t.transferId === id && t.state === 'active');
      this.outbox.sent(id, hash, active);
    }
    return { ok: true, id };
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

  private images(): ImageKeeper {
    this.imageKeeper ??= new ImageKeeper({
      load: () => loadSettings().lastImageHash,
      save: (hash) => updateSettings({ lastImageHash: hash }),
    });
    return this.imageKeeper;
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
    if (item.imageUri === undefined) delete item.imageUri;
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
