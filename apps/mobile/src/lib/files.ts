// Archivos: origen para enviar (File.open + readBytes) y destino SAF para recibir.
import type { FileMeta, FileSink, FileSource } from '@clipsync/protocol';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode } from 'expo-file-system';

import { sanitizeFileName } from './fileName';
import { createPickerGuard } from './pickerGuard';
import { loadSettings, saveSettings } from './settings';

/** Techo de cordura para lo que se envía desde el móvil. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor() {
    super('Archivo demasiado grande (máx. 200 MB)');
    this.name = 'FileTooLargeError';
  }
}

/** Se lanza si el usuario cierra el selector de carpeta sin elegir ninguna. */
export class NoReceiveDirError extends Error {
  constructor() {
    super('No se eligió carpeta de recepción');
    this.name = 'NoReceiveDirError';
  }
}

// --- selectores del sistema ---

const pickers = createPickerGuard();
const settledListeners = new Set<() => void>();

/**
 * true mientras hay un selector del sistema abierto: la app pasa a segundo plano, pero la
 * conexión no debe cortarse por ello.
 */
export function isPickerOpen(): boolean {
  return pickers.isOpen();
}

/** Olvida los selectores abiertos: al volver la app a primer plano ninguno puede seguir vivo. */
export function resetPickers(): void {
  pickers.reset();
}

/** Avisa cada vez que un selector termina (con éxito, cancelado o con error). */
export function onPickerSettled(cb: () => void): () => void {
  settledListeners.add(cb);
  return () => {
    settledListeners.delete(cb);
  };
}

async function withPicker<T>(fn: () => Promise<T>): Promise<T> {
  const token = pickers.enter();
  try {
    return await fn();
  } finally {
    pickers.leave(token);
    // si el usuario salió a Inicio con el selector abierto, ahora toca pausar la conexión
    for (const cb of [...settledListeners]) cb();
  }
}

// --- envío ---

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** No se pudo averiguar el tamaño (y el archivo no está vacío): enviarlo acabaría en size_mismatch. */
export class UnknownFileSizeError extends Error {
  constructor() {
    super('No se pudo leer el tamaño del archivo');
    this.name = 'UnknownFileSizeError';
  }
}

/** Sin tamaño positivo, el archivo es vacío de verdad solo si no da ni un byte. */
function isEmpty(handle: { readBytes(length: number): Uint8Array }): boolean {
  try {
    return handle.readBytes(1).length === 0;
  } catch {
    return false;
  }
}

/**
 * Abre `uri` para enviarlo. Los content:// pueden declarar tamaño -1/0/undefined, así que
 * se usa el del descriptor abierto o el del proveedor antes que el declarado.
 * Lanza FileTooLargeError por encima de 200 MB y UnknownFileSizeError si no hay un tamaño
 * positivo y el archivo no está vacío.
 */
export function fileSourceFromUri(uri: string, name: string, mime: string, size: number): FileSource {
  const file = new File(uri);
  const handle = file.open(FileMode.ReadOnly);
  let realSize = 0;
  try {
    let providerSize: number | null = null;
    try {
      providerSize = file.size;
    } catch {
      // el proveedor no da tamaño
    }
    realSize = [handle.size, providerSize, size].find(positive) ?? 0;
    if (realSize === 0 && !isEmpty(handle)) throw new UnknownFileSizeError();
  } catch (e) {
    handle.close();
    throw e;
  }
  if (realSize > MAX_FILE_BYTES) {
    handle.close();
    throw new FileTooLargeError();
  }

  let closed = false;
  return {
    name: name || file.name || 'archivo',
    mime: mime || 'application/octet-stream',
    size: realSize,
    async read(maxBytes) {
      return handle.readBytes(maxBytes);
    },
    async close() {
      if (closed) return;
      closed = true;
      handle.close();
    },
  };
}

/** Abre el selector de documentos; null si se cancela. */
export async function pickFileSource(): Promise<FileSource | null> {
  const result = await withPicker(() =>
    DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false, multiple: false }),
  );
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return fileSourceFromUri(asset.uri, asset.name, asset.mimeType ?? '', asset.size ?? -1);
}

// --- recepción ---

/** Abre el selector de carpeta, guarda la elegida en los ajustes y devuelve su URI (null si se cancela). */
export async function chooseReceiveDir(): Promise<string | null> {
  let dir: Directory;
  try {
    dir = await withPicker(() => Directory.pickDirectoryAsync());
  } catch {
    return null; // cancelado
  }
  saveSettings({ ...loadSettings(), receiveDirUri: dir.uri });
  return dir.uri;
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // ya no está
  }
}

/**
 * SAF añade «(1)» si el nombre existe; octet-stream evita que añada otra extensión.
 * Asíncrono: createDocument puede tardar segundos (3 s en MIUI) y congelaría el hilo de JS.
 */
function createIn(dirUri: string, name: string): Promise<File> {
  return new Directory(dirUri).createFileAsync(name, 'application/octet-stream');
}

/**
 * Crea el archivo en la carpeta SAF de los ajustes; si no hay (o ya no es accesible),
 * pide una y la guarda. El nombre se sanea igual que en el PC.
 */
export async function openSink(meta: FileMeta): Promise<FileSink> {
  const name = sanitizeFileName(meta.name);
  let file: File | null = null;
  const saved = loadSettings().receiveDirUri;
  if (saved) {
    try {
      file = await createIn(saved, name);
    } catch {
      file = null; // permiso revocado o carpeta borrada: se vuelve a pedir
    }
  }
  if (!file) {
    const picked = await chooseReceiveDir();
    if (!picked) throw new NoReceiveDirError();
    file = await createIn(picked, name);
  }

  const target = file;
  let handle;
  try {
    handle = target.open(FileMode.WriteOnly);
  } catch (e) {
    deleteQuietly(target);
    throw e;
  }
  const out = handle;
  let open = true;
  const closeHandle = () => {
    if (!open) return;
    open = false;
    out.close();
  };

  return {
    async write(bytes) {
      out.writeBytes(bytes);
    },
    async finish() {
      closeHandle();
      return target.uri;
    },
    // también tras finish(): la sesión cayó antes de confirmar y no debe quedar nada
    async abort() {
      try {
        closeHandle();
      } catch {
        // se borra igualmente
      }
      deleteQuietly(target);
    },
  };
}
