// Ajustes persistentes en Paths.document (JSON pequeño, lectura síncrona).
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

import { parseLastPc, type PcAddress } from './pcAddress';
import { parsePairedPc, type PairedPc } from './pairing';
import { parseBtAddress, parseTransportMode, type TransportMode } from './transportPolicy';

export interface Settings {
  /** Carpeta SAF elegida para guardar los archivos recibidos. */
  receiveDirUri: string | null;
  /** SHA-256 del último texto que consta que el PC tiene (R29). */
  lastSyncedHash: string | null;
  /** Última dirección WiFi del PC con la que se conectó. */
  lastPc: PcAddress | null;
  /** El PC emparejado; null hasta escanear su QR. */
  pc: PairedPc | null;
  /** SHA-256 de la última imagen que consta que el PC tiene (R29 de imágenes). */
  lastImageHash: string | null;
  /** Date.now() de la última revisión de capturas (Tarea 9); null hasta la primera. */
  lastScreenshotCheck: number | null;
  /** «Enviar capturas automáticamente». */
  sendScreenshots: boolean;
  /** «Guardar imágenes recibidas en la galería». */
  saveToGallery: boolean;
  /** Medio de conexión: `auto` (WiFi → USB → Bluetooth) o uno fijo. */
  transportMode: TransportMode;
  /** Dirección Bluetooth del PC (del QR o elegida de los emparejados), AA:BB:CC:DD:EE:FF. */
  btAddress: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function readJson(name: string): Record<string, unknown> | null {
  try {
    const file = new File(Paths.document, name);
    if (!file.exists) return null;
    const value: unknown = JSON.parse(file.textSync());
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null; // archivo dañado: se usan los valores por defecto
  }
}

function writeJson(name: string, value: unknown): void {
  const file = new File(Paths.document, name);
  if (!file.exists) file.create();
  file.write(JSON.stringify(value));
}

export function loadSettings(): Settings {
  const raw = readJson('settings.json');
  return {
    receiveDirUri: typeof raw?.receiveDirUri === 'string' ? raw.receiveDirUri : null,
    lastSyncedHash: typeof raw?.lastSyncedHash === 'string' && SHA256_HEX.test(raw.lastSyncedHash) ? raw.lastSyncedHash : null,
    lastPc: parseLastPc(raw?.lastPc),
    pc: parsePairedPc(raw?.pc),
    lastImageHash: typeof raw?.lastImageHash === 'string' && SHA256_HEX.test(raw.lastImageHash) ? raw.lastImageHash : null,
    lastScreenshotCheck:
      typeof raw?.lastScreenshotCheck === 'number' && Number.isFinite(raw.lastScreenshotCheck) ? raw.lastScreenshotCheck : null,
    // activados por defecto
    sendScreenshots: raw?.sendScreenshots !== false,
    saveToGallery: raw?.saveToGallery !== false,
    transportMode: parseTransportMode(raw?.transportMode),
    btAddress: parseBtAddress(raw?.btAddress),
  };
}

export function saveSettings(s: Settings): void {
  writeJson('settings.json', {
    receiveDirUri: s.receiveDirUri,
    lastSyncedHash: s.lastSyncedHash,
    lastPc: s.lastPc,
    pc: s.pc,
    lastImageHash: s.lastImageHash,
    lastScreenshotCheck: s.lastScreenshotCheck,
    sendScreenshots: s.sendScreenshots,
    saveToGallery: s.saveToGallery,
    transportMode: s.transportMode,
    btAddress: s.btAddress,
  });
}

/** Cambia solo esos campos; un fallo al escribir se ignora (vale para esta ejecución). */
export function updateSettings(patch: Partial<Settings>): void {
  try {
    saveSettings({ ...loadSettings(), ...patch });
  } catch {
    // sin persistir
  }
}

let deviceId: string | null = null;

/** Id estable de este móvil: el PC guarda por él qué texto quedó sincronizado. */
export function getDeviceId(): string {
  if (deviceId) return deviceId;
  const raw = readJson('device.json');
  if (typeof raw?.deviceId === 'string' && raw.deviceId !== '') {
    deviceId = raw.deviceId;
    return deviceId;
  }
  deviceId = Crypto.randomUUID();
  try {
    writeJson('device.json', { deviceId });
  } catch {
    // sin persistir vale para esta ejecución
  }
  return deviceId;
}
