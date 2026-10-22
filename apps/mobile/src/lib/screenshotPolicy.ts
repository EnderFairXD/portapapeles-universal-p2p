// Qué capturas enviar, puro para poder probarlo (sin React Native ni expo-media-library).

/** Una captura de la galería. */
export interface ShotAsset {
  id: string;
  /** content:// del recurso (en Android el id del recurso es esa URI). */
  uri: string;
  /** Date.now() en ms de cuando se hizo. */
  creationTime: number;
  albumTitle: string;
  /** Nombre del archivo, para el mime y el nombre con que llega al PC. */
  filename?: string | null;
}

/** Como mucho tantas capturas por revisión: tras días sin abrir la app no se envían cientos. */
export const MAX_SHOTS_PER_CHECK = 5;
/** Solo las de los últimos 15 minutos. */
export const SHOT_MAX_AGE_MS = 15 * 60_000;
/** Cada cuánto se revisa con la app en primer plano. */
export const SHOT_POLL_MS = 3000;

/** El álbum de capturas: su título contiene «screenshot» o «captura» (sin distinguir mayúsculas). */
export function isScreenshotAlbum(title: string): boolean {
  const t = title.toLowerCase();
  return t.includes('screenshot') || t.includes('captura');
}

/**
 * Las capturas por enviar: posteriores a `since` (null = todas), de los últimos 15 minutos y
 * no enviadas ya; las 5 más recientes, la más reciente primero. Sin repetir recursos.
 */
export function pickScreenshots(assets: readonly ShotAsset[], since: number | null, now: number, sentIds: ReadonlySet<string>): ShotAsset[] {
  const seen = new Set<string>();
  return assets
    .filter((a) => {
      if (seen.has(a.id) || sentIds.has(a.id)) return false;
      seen.add(a.id);
      return (since === null || a.creationTime > since) && now - a.creationTime <= SHOT_MAX_AGE_MS;
    })
    .sort((a, b) => b.creationTime - a.creationTime)
    .slice(0, MAX_SHOTS_PER_CHECK);
}

/** Mime admitido por el PC según la extensión; null si no es png, jpeg ni webp. */
export function screenshotMime(filename: string | null | undefined): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}

/** Imagen elegida en la galería: su mime si el PC lo admite (exacto, como el protocolo); si no, por la extensión. */
export function pickedImageMime(
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') return mimeType;
  return screenshotMime(fileName);
}

/** Acceso a las fotos: `partial` (solo las elegidas) no sirve para ver las capturas nuevas. */
export function photoAccess(p: { granted: boolean; accessPrivileges?: string }): 'full' | 'partial' | 'none' {
  if (!p.granted) return 'none';
  return p.accessPrivileges === 'limited' ? 'partial' : 'full';
}
