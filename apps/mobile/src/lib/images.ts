// Imágenes del portapapeles: lectura para enviar, escritura de las recibidas (galería +
// portapapeles + lectura de vuelta) y copias para el historial. Base64 y SHA-256 van en nativo:
// en JS congelarían la interfaz con imágenes de varios MB.
import { MAX_HISTORY, PURPOSE_CLIPBOARD, sha256Hex, type FileSource } from '@clipsync/protocol';
import * as Clipboard from 'expo-clipboard';
import { File } from 'expo-file-system';
import { Album, Asset, getPermissionsAsync, requestPermissionsAsync } from 'expo-media-library';

import { withClipboardSuppressed } from './clipboardWatcher';
import { appDir, deleteQuietly, fileSourceFromUri, newImageFileName } from './files';
import { outgoingImageName, pruneImageNames } from './imagePolicy';
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

/**
 * Pone la imagen de `uri` en el portapapeles y devuelve el hash de su lectura de vuelta (si no
 * se puede leer, p. ej. en segundo plano, el de los bytes del archivo); null si no se pudo poner.
 * Llamar con el oyente callado (`withClipboardSuppressed`); los avisos que lleguen tarde los
 * descarta el anti-rebote, porque el gestor los lee después de marcar este hash.
 */
export async function setClipboardImage(uri: string): Promise<string | null> {
  const file = new File(uri);
  try {
    await Clipboard.setImageAsync(await file.base64());
  } catch {
    return null;
  }
  const back = await readClipboardImage();
  if (back) return back.hash;
  try {
    return sha256Hex(await file.bytes());
  } catch {
    return null;
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

export interface ReceivedImage {
  /** Hash de la lectura de vuelta, para `markSynced`; null si no se pudo poner en el portapapeles. */
  hash: string | null;
  /** El recurso creado en la galería; null si no se guardó (desactivado o fallo). */
  galleryUri: string | null;
  /** Se intentó guardar en la galería y falló (aviso «No se pudo guardar en la galería»). */
  galleryFailed: boolean;
  /** Copia para el historial en `Paths.document/images/`; null si no se pudo guardar. */
  imageUri: string | null;
}

/**
 * Una imagen recibida (en `Paths.cache/images/`): 1) a la galería si está activado, 2) al
 * portapapeles con el oyente callado y 3) lectura de vuelta para el hash; 4) copia para el
 * historial y 5) se borra de la caché. Un fallo de la galería no impide el portapapeles. Todo
 * con el oyente del portapapeles callado (se suelta siempre, también si algo lanza).
 */
export function writeReceivedImage(path: string, saveToGalleryOn: boolean): Promise<ReceivedImage> {
  return withClipboardSuppressed(async () => {
    try {
      let galleryUri: string | null = null;
      let galleryFailed = false;
      if (saveToGalleryOn) {
        try {
          galleryUri = await saveToGallery(path);
        } catch {
          galleryFailed = true;
        }
      }
      const hash = await setClipboardImage(path);
      const imageUri = keepForHistory(path);
      return { hash, galleryUri, galleryFailed, imageUri };
    } finally {
      // si no se movió al historial, no queda en la caché
      deleteQuietly(new File(path));
    }
  });
}
