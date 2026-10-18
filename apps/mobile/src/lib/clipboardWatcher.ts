// Portapapeles del móvil. Sin sondeo: Android 12+ muestra un aviso en cada lectura.
import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';

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

/** Escrituras de la app en curso: mientras tanto el oyente no avisa de nada. */
let suppressed = 0;

/** Ejecuta `fn` con el oyente callado (escritura de una imagen recibida o del historial). */
export async function withClipboardSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressed += 1;
  try {
    return await fn();
  } finally {
    suppressed -= 1;
  }
}

export interface ClipboardHandlers {
  onText(text: string): void;
  /** Hay una imagen en el portapapeles; quien la recibe la lee (imagen gana a texto). */
  onImage(): void;
}

/**
 * Avisa de cada cambio: por el listener del sistema y al volver a primer plano.
 * Lo que escribe la propia app también llega aquí; el anti-rebote lo descarta.
 */
export function startClipboardWatcher(handlers: ClipboardHandlers): () => void {
  let active = true;
  const readText = async () => {
    const text = await readClipboard();
    if (active && suppressed === 0 && text !== null) handlers.onText(text);
  };
  const readAny = async () => {
    const image = await clipboardHasImage();
    if (!active || suppressed > 0) return;
    if (image) handlers.onImage();
    else await readText();
  };

  const clipSub = Clipboard.addClipboardListener(({ contentTypes }) => {
    if (suppressed > 0) return;
    const kind = clipboardKind(contentTypes);
    if (kind === 'image') handlers.onImage();
    else if (kind === 'text') void readText();
  });
  const appSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void readAny();
  });

  return () => {
    active = false;
    clipSub.remove();
    appSub.remove();
  };
}

export async function writeClipboard(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}
