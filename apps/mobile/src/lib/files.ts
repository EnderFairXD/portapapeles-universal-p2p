// Archivos: origen para enviar (File.open + readBytes) y destino SAF para recibir.
import { PURPOSE_CLIPBOARD, type FileMeta, type FileSink, type FileSource } from '@clipsync/protocol';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { sanitizeFileName } from './fileName';
import { imageExtension } from './imagePolicy';
import { createPickerGuard } from './pickerGuard';
import { pickedImageMime } from './screenshotPolicy';
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

/** Envuelve un diálogo del sistema (selector, permisos): la app no se pausa mientras está abierto. */
export async function withPicker<T>(fn: () => Promise<T>): Promise<T> {
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

export class UnsupportedImageError extends Error {
  constructor() {
    super('Formato de imagen no compatible');
  }
}

/**
 * Botón «Enviar imagen»: selector de fotos del sistema (en Android 13+ no pide permiso).
 * Una sola imagen: solo cabe una imagen de portapapeles en cola por PC.
 */
export async function pickImageSource(): Promise<{ src: FileSource; uri: string } | null> {
  const result = await withPicker(() =>
    ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 1, exif: false }),
  );
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const mime = pickedImageMime(asset.mimeType, asset.fileName ?? asset.uri);
  if (!mime) throw new UnsupportedImageError();
  const name = asset.fileName || `imagen.${imageExtension(mime)}`;
  return { src: fileSourceFromUri(asset.uri, name, mime, asset.fileSize ?? -1), uri: asset.uri };
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

/** Acepta la ruta/URI: el `File` se crea dentro del try, así que nunca lanza. */
export function deleteQuietly(target: File | string): void {
  try {
    const file = typeof target === 'string' ? new File(target) : target;
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

// --- imágenes del portapapeles ---

/** `Paths.cache/<name>` o `Paths.document/<name>`, creada si falta. */
export function appDir(base: 'cache' | 'document', name: string): Directory {
  const dir = new Directory(base === 'cache' ? Paths.cache : Paths.document, name);
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}

/** Nombre único y ordenable por fecha: marca de tiempo de 13 cifras + aleatorio. */
export function newImageFileName(ext: string): string {
  return `${String(Date.now()).padStart(13, '0')}-${Crypto.randomUUID().slice(0, 8)}.${ext}`;
}

/**
 * Crea el archivo en la carpeta SAF de los ajustes; si no hay (o ya no es accesible),
 * pide una y la guarda. El nombre se sanea igual que en el PC. Una imagen para el
 * portapapeles (`purpose`) va a `Paths.cache/images/`, no a la carpeta SAF.
 */
export async function openSink(meta: FileMeta): Promise<FileSink> {
  if (meta.purpose === PURPOSE_CLIPBOARD) {
    const file = new File(appDir('cache', 'images'), newImageFileName(imageExtension(meta.mime)));
    file.create();
    return sinkFor(file);
  }
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
  return sinkFor(file);
}

/** Escribe en `target`; si algo falla o se aborta, lo borra. */
function sinkFor(target: File): FileSink {
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
