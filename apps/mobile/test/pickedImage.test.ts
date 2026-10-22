import { describe, expect, it } from 'vitest';

import { pickedImageMime } from '../src/lib/screenshotPolicy';

describe('pickedImageMime', () => {
  it('acepta los mime que admite el PC', () => {
    expect(pickedImageMime('image/png', 'a.bin')).toBe('image/png');
    expect(pickedImageMime('image/jpeg', null)).toBe('image/jpeg');
    expect(pickedImageMime('image/webp', undefined)).toBe('image/webp');
  });

  it('sin mime válido, decide por la extensión', () => {
    expect(pickedImageMime(null, 'IMG_1.JPG')).toBe('image/jpeg');
    expect(pickedImageMime('', 'foto.png')).toBe('image/png');
    expect(pickedImageMime('application/octet-stream', 'x.webp')).toBe('image/webp');
  });

  it('rechaza HEIC y otros formatos', () => {
    expect(pickedImageMime('image/heic', 'IMG.HEIC')).toBeNull();
    expect(pickedImageMime('image/gif', 'anim.gif')).toBeNull();
    expect(pickedImageMime(null, null)).toBeNull();
  });

  it('no acepta mime con mayúsculas o parámetros, como el protocolo', () => {
    expect(pickedImageMime('IMAGE/PNG', 'sin-extension')).toBeNull();
    expect(pickedImageMime('image/png; q=1', 'sin-extension')).toBeNull();
  });
});
