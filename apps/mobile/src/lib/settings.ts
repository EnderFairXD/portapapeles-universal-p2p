// Ajustes persistentes en Paths.document (JSON pequeño, lectura síncrona).
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

export interface Settings {
  /** Carpeta SAF elegida para guardar los archivos recibidos. */
  receiveDirUri: string | null;
}

const DEFAULTS: Settings = { receiveDirUri: null };

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
    receiveDirUri: typeof raw?.receiveDirUri === 'string' ? raw.receiveDirUri : DEFAULTS.receiveDirUri,
  };
}

export function saveSettings(s: Settings): void {
  writeJson('settings.json', { receiveDirUri: s.receiveDirUri });
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
