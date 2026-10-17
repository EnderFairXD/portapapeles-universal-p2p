// Archivos: origen para enviar (File.open + readBytes) y destino SAF para recibir.
import type { FileMeta, FileSink, FileSource } from '@clipsync/protocol';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode } from 'expo-file-system';

import { sanitizeFileName } from './fileName';
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

let pickersOpen = 0;

/**
 * true mientras hay un selector del sistema abierto: la app pasa a segundo plano, pero la
 * conexión no debe cortarse por ello.
 */
export function isPickerOpen(): boolean {
  return pickersOpen > 0;
}

async function withPicker<T>(fn: () => Promise<T>): Promise<T> {
  pickersOpen += 1;
  try {
    return await fn();
  } finally {
    pickersOpen -= 1;
  }
}

// --- envío ---

function positive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/**
 * Abre `uri` para enviarlo. Los content:// pueden declarar tamaño -1/0/undefined, así que
 * se usa el del descriptor abierto o el del proveedor antes que el declarado.
 * Lanza FileTooLargeError por encima de 200 MB.
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

/** SAF añade «(1)» si el nombre existe; octet-stream evita que añada otra extensión. */
function createIn(dirUri: string, name: string): File {
  return new Directory(dirUri).createFile(name, 'application/octet-stream');
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
      file = createIn(saved, name);
    } catch {
      file = null; // permiso revocado o carpeta borrada: se vuelve a pedir
    }
  }
  if (!file) {
    const picked = await chooseReceiveDir();
    if (!picked) throw new NoReceiveDirError();
    file = createIn(picked, name);
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
