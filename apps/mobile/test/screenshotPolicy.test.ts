import { describe, expect, it } from 'vitest';

import {
  isScreenshotAlbum,
  MAX_SHOTS_PER_CHECK,
  photoAccess,
  pickScreenshots,
  screenshotMime,
  SHOT_MAX_AGE_MS,
  type ShotAsset,
} from '../src/lib/screenshotPolicy';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function shot(id: string, agoMs: number, albumTitle = 'Screenshots'): ShotAsset {
  return { id, uri: `content://media/external/images/media/${id}`, creationTime: NOW - agoMs, albumTitle };
}

describe('isScreenshotAlbum', () => {
  it('«Screenshots» y «Capturas de pantalla», sin distinguir mayúsculas', () => {
    expect(isScreenshotAlbum('Screenshots')).toBe(true);
    expect(isScreenshotAlbum('SCREENSHOTS')).toBe(true);
    expect(isScreenshotAlbum('Capturas de pantalla')).toBe(true);
    expect(isScreenshotAlbum('Screenshot')).toBe(true);
  });

  it('otros álbumes no', () => {
    expect(isScreenshotAlbum('Camera')).toBe(false);
    expect(isScreenshotAlbum('ClipSync')).toBe(false);
    expect(isScreenshotAlbum('')).toBe(false);
  });
});

describe('pickScreenshots', () => {
  it('8 capturas en 10 minutos: solo las 5 más recientes, la más reciente primero', () => {
    const assets = Array.from({ length: 8 }, (_, i) => shot(String(i), (8 - i) * MIN));
    const got = pickScreenshots(assets, null, NOW, new Set());
    expect(got).toHaveLength(MAX_SHOTS_PER_CHECK);
    expect(got.map((s) => s.id)).toEqual(['7', '6', '5', '4', '3']);
  });

  it('una de hace 20 minutos queda fuera', () => {
    expect(pickScreenshots([shot('viejo', 20 * MIN)], null, NOW, new Set())).toEqual([]);
    expect(pickScreenshots([shot('justo', SHOT_MAX_AGE_MS)], null, NOW, new Set())).toHaveLength(1);
  });

  it('una anterior a `since` queda fuera (y una igual también: ya se miró)', () => {
    const since = NOW - 5 * MIN;
    const got = pickScreenshots([shot('antes', 8 * MIN), shot('igual', 5 * MIN), shot('despues', 2 * MIN)], since, NOW, new Set());
    expect(got.map((s) => s.id)).toEqual(['despues']);
  });

  it('una ya enviada (sentIds) queda fuera', () => {
    const got = pickScreenshots([shot('a', 3 * MIN), shot('b', 2 * MIN)], null, NOW, new Set(['b']));
    expect(got.map((s) => s.id)).toEqual(['a']);
  });

  it('`since` nulo con una captura de hace 1 minuto: dentro', () => {
    expect(pickScreenshots([shot('a', MIN)], null, NOW, new Set())).toHaveLength(1);
  });

  it('el mismo recurso en dos álbumes cuenta una vez', () => {
    const got = pickScreenshots([shot('a', MIN), shot('a', MIN, 'Capturas de pantalla')], null, NOW, new Set());
    expect(got).toHaveLength(1);
  });

  it('no modifica la lista de entrada', () => {
    const assets = [shot('a', 3 * MIN), shot('b', MIN)];
    pickScreenshots(assets, null, NOW, new Set());
    expect(assets.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('screenshotMime', () => {
  it('png, jpg y webp por la extensión', () => {
    expect(screenshotMime('Screenshot_2026.png')).toBe('image/png');
    expect(screenshotMime('captura.JPG')).toBe('image/jpeg');
    expect(screenshotMime('a.jpeg')).toBe('image/jpeg');
    expect(screenshotMime('a.webp')).toBe('image/webp');
  });

  it('otros formatos o sin extensión: null (no se envían)', () => {
    expect(screenshotMime('a.heic')).toBeNull();
    expect(screenshotMime('sin_extension')).toBeNull();
    expect(screenshotMime(null)).toBeNull();
  });
});

describe('photoAccess', () => {
  it('concedido del todo', () => {
    expect(photoAccess({ granted: true, accessPrivileges: 'all' })).toBe('full');
    expect(photoAccess({ granted: true })).toBe('full');
  });

  it('acceso a fotos seleccionadas: parcial', () => {
    expect(photoAccess({ granted: true, accessPrivileges: 'limited' })).toBe('partial');
  });

  it('denegado', () => {
    expect(photoAccess({ granted: false })).toBe('none');
    expect(photoAccess({ granted: false, accessPrivileges: 'none' })).toBe('none');
  });
});
