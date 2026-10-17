// Portapapeles del móvil. Sin sondeo: Android 12+ muestra un aviso en cada lectura.
import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';

/** Texto actual del portapapeles, o null si está vacío o no se puede leer. */
export async function readClipboard(): Promise<string | null> {
  try {
    const text = await Clipboard.getStringAsync();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * Avisa de cada texto nuevo: por el listener del sistema y al volver a primer plano.
 * Lo que escribe la propia app también llega aquí; el anti-rebote lo descarta.
 */
export function startClipboardWatcher(onText: (text: string) => void): () => void {
  let active = true;
  const read = async () => {
    const text = await readClipboard();
    if (active && text !== null) onText(text);
  };

  const clipSub = Clipboard.addClipboardListener(({ contentTypes }) => {
    if (contentTypes.includes(Clipboard.ContentType.PLAIN_TEXT)) void read();
  });
  const appSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void read();
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
