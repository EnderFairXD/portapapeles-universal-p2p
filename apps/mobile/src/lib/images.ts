// Imágenes del portapapeles: lectura para enviar, escritura de las recibidas (galería +
// portapapeles + lectura de vuelta) y copias para el historial. Base64 y SHA-256 van en nativo:
// en JS congelarían la interfaz con imágenes de varios MB.
import { MAX_HISTORY, PURPOSE_CLIPBOARD, sha256Hex, type FileSource } from '@clipsync/protocol';
import * as Clipboard from 'expo-clipboard';
import { File } from 'expo-file-system';
import { Album, Asset, getPermissionsAsync, requestPermissionsAsync } from 'expo-media-library';

import { withClipboardSuppressed } from './clipboardWatcher';
import { appDir, deleteQuietly, fileSourceFromUri, newImageFileName } from './files';
import { outgoingImageName, pruneImageNames, readWithRetries } from './imagePolicy';
import { nativeBase64 } from './nativeCrypto';

/** Álbum de la galería donde se guardan las imágenes recibidas. */
export const GALLERY_ALBUM = 'ClipSync';

/** Copias de las imágenes del historial (las más recientes, como mucho MAX_HISTORY). */
function historyDir() {
  return appDir('document', 'images');
}

async function decodeBase64(text: string): Promise<Uint8Array> {
  const codec = nativeBase64();
  if (codec) return codec.decode(text);
  // sin el módulo nativo: lo decodifica expo-file-system a través de un temporal
  const tmp = new File(appDir('cache', 'images'), newImageFileName('b64'));
  try {
    tmp.write(text, { encoding: 'base64' });
    return await tmp.bytes();
  } finally {
    deleteQuietly(tmp);
  }
}

export interface ClipboardImage {
  /** SHA-256 hex de los bytes PNG que da `getImageAsync({ format: 'png' })`. */
  hash: string;
  bytes: Uint8Array;
}

/** La imagen actual del portapapeles en PNG con su hash, o null si no hay o no se puede leer. */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  let data: string | undefined;
  try {
    data = (await Clipboard.getImageAsync({ format: 'png' }))?.data;
  } catch {
    return null;
  }
  if (!data) return null;
  // viene como data URL: data:image/png;base64,…
  const comma = data.indexOf(',');
  let bytes: Uint8Array;
  try {
    bytes = await decodeBase64(comma >= 0 ? data.slice(comma + 1) : data);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  return { hash: sha256Hex(bytes), bytes };
}

/**
 * Escribe la imagen en `Paths.cache/images/` y la abre para enviarla al portapapeles del PC.
 * `uri` es el archivo de la caché: se mueve al historial si llega o se borra si no.
 */
export function cachedImageSource(bytes: Uint8Array): { source: FileSource; uri: string } {
  const file = new File(appDir('cache', 'images'), newImageFileName('png'));
  file.create();
  try {
    file.write(bytes);
    const src = fileSourceFromUri(file.uri, outgoingImageName(new Date()), 'image/png', bytes.length);
    return { source: { ...src, purpose: PURPOSE_CLIPBOARD }, uri: file.uri };
  } catch (e) {
    deleteQuietly(file);
    throw e;
  }
}

const READBACK_RETRIES = 4;
const READBACK_RETRY_MS = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resultado de poner una imagen en el portapapeles. */
export type ClipboardWrite =
  /** `unverified`: sin lectura de vuelta, el hash es el del archivo y el portapapeles puede devolverla recodificada. */
  | { kind: 'ok'; hash: string; unverified?: true }
  /** Se puso, pero no se pudo leer de vuelta (p. ej. en segundo plano): se reintenta en primer plano. */
  | { kind: 'unreadable' }
  | { kind: 'failed' };

/**
 * Pone la imagen de `uri` en el portapapeles y devuelve el hash de su lectura de vuelta. Solo
 * `setImageAsync` y la lectura de vuelta van con el oyente callado; los avisos que lleguen
 * mientras tanto se recuperan al soltar. Si no se puede leer de vuelta: `unreadable`. Con
 * `lastTry` (primer plano y ya reintentado) la lectura se repite hasta 4 veces cada 250 ms (justo
 * al pasar a `active` la ventana aún puede no tener foco) y, si sigue sin ir, usa el hash de los
 * bytes del archivo con `unverified`.
 */
export async function setClipboardImage(uri: string, lastTry: boolean): Promise<ClipboardWrite> {
  const file = new File(uri);
  let data: string;
  try {
    data = await file.base64();
  } catch {
    return { kind: 'failed' };
  }
  const back = await withClipboardSuppressed(async () => {
    try {
      await Clipboard.setImageAsync(data);
    } catch {
      return 'failed' as const;
    }
    return readWithRetries(readClipboardImage, lastTry ? READBACK_RETRIES : 0, READBACK_RETRY_MS, sleep);
  });
  if (back === 'failed') return { kind: 'failed' };
  if (back) return { kind: 'ok', hash: back.hash };
  if (!lastTry) return { kind: 'unreadable' };
  try {
    return { kind: 'ok', hash: sha256Hex(await file.bytes()), unverified: true };
  } catch {
    return { kind: 'failed' };
  }
}

/** Guarda la imagen en el álbum «ClipSync»; pide permiso solo si hace falta (Android ≤ 12). */
async function saveToGallery(uri: string): Promise<string> {
  try {
    return await addToAlbum(uri);
  } catch (e) {
    const perm = await getPermissionsAsync(true, ['photo']);
    if (perm.granted || !perm.canAskAgain) throw e;
    if (!(await requestPermissionsAsync(true, ['photo'])).granted) throw e;
    return await addToAlbum(uri);
  }
}

async function addToAlbum(uri: string): Promise<string> {
  const album = await Album.get(GALLERY_ALBUM).catch(() => null);
  if (album) return (await Asset.create(uri, album)).id;
  const created = await Album.create(GALLERY_ALBUM, [uri]);
  const assets = await created.getAssets();
  return assets[0]?.id ?? created.id;
}

/** Mueve el archivo a `Paths.document/images/` y poda las copias antiguas; null si falla. */
export function keepForHistory(uri: string): string | null {
  try {
    const src = new File(uri);
    const dir = historyDir();
    const dest = new File(dir, newImageFileName(src.extension.replace('.', '') || 'png'));
    src.moveSync(dest);
    pruneHistoryImages();
    return dest.uri;
  } catch {
    return null;
  }
}

function pruneHistoryImages(): void {
  try {
    const files = historyDir()
      .list()
      .filter((f): f is File => f instanceof File);
    const extra = new Set(pruneImageNames(files.map((f) => f.name), MAX_HISTORY));
    for (const f of files) if (extra.has(f.name)) deleteQuietly(f);
  } catch {
    // se reintenta con la siguiente imagen
  }
}

export interface SavedImage {
  /** El recurso creado en la galería; null si no se guardó (desactivado o fallo). */
  galleryUri: string | null;
  /** Se intentó guardar en la galería y falló (aviso «No se pudo guardar en la galería»). */
  galleryFailed: boolean;
  /** Copia para el historial en `Paths.document/images/`; null si no se pudo guardar. */
  imageUri: string | null;
  /** Archivo que se pondrá en el portapapeles: la copia del historial o, si no la hay, el de la caché. */
  clipUri: string;
  /** Archivo de la caché que borrar tras escribir en el portapapeles (null si ya está en el historial). */
  temp: string | null;
}

/**
 * Una imagen recibida (en `Paths.cache/images/`): 1) a la galería si está activado (sin tocar
 * el oyente del portapapeles) y 2) copia para el historial. El portapapeles va aparte
 * (`setClipboardImage`): en segundo plano se difiere hasta volver a primer plano.
 */
export async function saveReceivedImage(path: string, saveToGalleryOn: boolean): Promise<SavedImage> {
  let galleryUri: string | null = null;
  let galleryFailed = false;
  if (saveToGalleryOn) {
    try {
      galleryUri = await saveToGallery(path);
    } catch {
      galleryFailed = true;
    }
  }
  const imageUri = keepForHistory(path);
  return { galleryUri, galleryFailed, imageUri, clipUri: imageUri ?? path, temp: imageUri ? null : path };
}

/** Borra el temporal de la caché de una imagen ya escrita (o descartada). */
export function discardTemp(temp: string | null): void {
  if (temp) deleteQuietly(temp);
}
