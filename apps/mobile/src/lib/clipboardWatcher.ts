// Portapapeles del móvil. Sin sondeo: Android 12+ muestra un aviso en cada lectura.
import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';

import { SuppressGuard } from './clipboardGuard';
import { clipboardKind } from './imagePolicy';

/** Texto actual del portapapeles, o null si está vacío o no se puede leer. */
export async function readClipboard(): Promise<string | null> {
  try {
    const text = await Clipboard.getStringAsync();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** true si el portapapeles tiene ahora una imagen (no la lee: sin aviso de pegado). */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    return await Clipboard.hasImageAsync();
  } catch {
    return false;
  }
}

/** Escrituras de imágenes de la app en curso: mientras tanto el oyente descarta los avisos. */
const guard = new SuppressGuard();
/** Revisa el portapapeles si se descartó algún aviso durante una escritura (lo pone el vigilante). */
let onMissed: (() => void) | null = null;

/**
 * Ejecuta `fn` con el oyente callado. Solo para la escritura de la imagen y su lectura de
 * vuelta, no para la galería ni los permisos. Los avisos descartados se recuperan al soltar.
 */
export async function withClipboardSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  guard.enter();
  try {
    return await fn();
  } finally {
    if (guard.exit()) onMissed?.();
  }
}

export interface ClipboardHandlers {
  onText(text: string): void;
  /** Hay una imagen en el portapapeles; quien la recibe la lee (imagen gana a texto). */
  onImage(): void;
  /** Se descartó algún aviso durante una escritura de la app: revisar el portapapeles. */
  onMissed(): void;
}

/**
 * Avisa de cada cambio: por el listener del sistema y al volver a primer plano.
 * Lo que escribe la propia app también llega aquí; el anti-rebote lo descarta.
 */
export function startClipboardWatcher(handlers: ClipboardHandlers): () => void {
  let active = true;
  onMissed = handlers.onMissed;
  const readText = async () => {
    const text = await readClipboard();
    if (active && text !== null && !guard.swallow()) handlers.onText(text);
  };
  const readAny = async () => {
    const image = await clipboardHasImage();
    if (!active || guard.swallow()) return;
    if (image) handlers.onImage();
    else await readText();
  };

  const clipSub = Clipboard.addClipboardListener(({ contentTypes }) => {
    const kind = clipboardKind(contentTypes);
    if (kind === 'none' || guard.swallow()) return;
    if (kind === 'image') handlers.onImage();
    else void readText();
  });
  const appSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void readAny();
  });

  return () => {
    active = false;
    if (onMissed === handlers.onMissed) onMissed = null;
    clipSub.remove();
    appSub.remove();
  };
}

export async function writeClipboard(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}
