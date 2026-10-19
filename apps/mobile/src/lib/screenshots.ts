// Capturas de pantalla nuevas: lectura de los álbumes de la galería (expo-media-library) y
// vigilante que las ofrece al gestor de la conexión. La decisión de cuáles enviar es pura
// (screenshotPolicy.ts).
import { Album, AssetField, MediaType, Query, getPermissionsAsync, requestPermissionsAsync } from 'expo-media-library';
import { AppState } from 'react-native';

import { withPicker } from './files';
import { isScreenshotAlbum, photoAccess, SHOT_POLL_MS, type ShotAsset } from './screenshotPolicy';

/** Candidatas por álbum: de sobra para las 5 que se envían como mucho. */
const PER_ALBUM = 10;

/**
 * Acceso a las fotos: lo pide la primera vez (permiso sin decidir) y después solo lo consulta,
 * para no insistir. `partial` (fotos elegidas) no basta para ver las capturas nuevas.
 */
export async function ensurePhotoAccess(): Promise<'full' | 'partial' | 'none'> {
  try {
    let perm = await getPermissionsAsync(false, ['photo']);
    if (!perm.granted && perm.status === 'undetermined' && perm.canAskAgain) {
      perm = await withPicker(() => requestPermissionsAsync(false, ['photo']));
    }
    return photoAccess(perm);
  } catch {
    return 'none';
  }
}

/** Las capturas más recientes de los álbumes de capturas (títulos en caché por álbum). */
async function listRecentScreenshots(titles: Map<string, string>): Promise<ShotAsset[]> {
  const out: ShotAsset[] = [];
  for (const album of await Album.getAll()) {
    let title = titles.get(album.id);
    if (title === undefined) {
      title = await album.getTitle().catch(() => '');
      titles.set(album.id, title);
    }
    if (!isScreenshotAlbum(title)) continue;
    const metas = await new Query()
      .album(album)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
      .limit(PER_ALBUM)
      .exeForMetadata();
    for (const m of metas) {
      const creationTime = m.creationTime ?? m.modificationTime;
      if (m.mediaType !== MediaType.IMAGE || creationTime === null) continue;
      // en Android el id del recurso es su content://
      out.push({ id: m.id, uri: m.id, creationTime, albumTitle: title, filename: m.filename });
    }
  }
  return out;
}

/**
 * Revisa los álbumes de capturas al ponerse la app en primer plano y cada 3 s mientras siga
 * ahí. `onShots` recibe las candidatas recientes (el gestor elige cuáles enviar). Devuelve la
 * función que para el vigilante.
 */
export function startScreenshotWatcher(onShots: (shots: ShotAsset[]) => void): () => void {
  let active = true;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const titles = new Map<string, string>();

  const tick = async () => {
    if (busy || !active) return;
    busy = true;
    try {
      const shots = await listRecentScreenshots(titles);
      if (active && shots.length > 0) onShots(shots);
    } catch {
      // sin acceso o galería ocupada: se reintenta en el siguiente turno
    } finally {
      busy = false;
    }
  };
  const run = () => {
    void tick();
    timer ??= setInterval(() => void tick(), SHOT_POLL_MS);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  if (AppState.currentState === 'active') run();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') run();
    else stopTimer();
  });

  return () => {
    active = false;
    stopTimer();
    sub.remove();
  };
}
