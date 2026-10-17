import { describe, expect, it } from 'vitest';

import { sanitizeFileName } from '../src/lib/fileName';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Mismos casos que sanitize_file_name en apps/desktop/src-tauri/src/core/files.rs
describe('sanitizeFileName', () => {
  it('se queda con el último componente de la ruta', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\x\\a.txt')).toBe('a.txt');
    expect(sanitizeFileName('a/b.txt')).toBe('b.txt');
  });

  it('usa "archivo" si no queda nada útil', () => {
    expect(sanitizeFileName('')).toBe('archivo');
    expect(sanitizeFileName('a/')).toBe('archivo');
    expect(sanitizeFileName('..')).toBe('archivo');
    expect(sanitizeFileName('.')).toBe('archivo');
    expect(sanitizeFileName('<>:"|?*')).toBe('archivo');
    expect(sanitizeFileName(' . .txt')).toBe('archivo.txt');
  });

  it('quita caracteres prohibidos y de control', () => {
    expect(sanitizeFileName('a?b*.txt')).toBe('ab.txt');
    expect(sanitizeFileName('a\u0000b\nc\u007f.txt')).toBe('abc.txt');
    expect(sanitizeFileName('a\u0085b.txt')).toBe('ab.txt');
  });

  it('quita caracteres bidi y de formato', () => {
    expect(sanitizeFileName('factura\u202Efdp.exe')).toBe('facturafdp.exe');
    expect(sanitizeFileName('\uFEFFa\u200Bb\u200Fc\u2028d\u2029e\u2066f\u2069.txt')).toBe('abcdef.txt');
    expect(sanitizeFileName('x\u202A\u202B\u202C\u202D.txt')).toBe('x.txt');
  });

  it('recorta puntos y espacios finales', () => {
    expect(sanitizeFileName('nombre. . ')).toBe('nombre');
    expect(sanitizeFileName('informe final.pdf')).toBe('informe final.pdf');
  });

  it('protege los nombres reservados de Windows', () => {
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('con')).toBe('_con');
    expect(sanitizeFileName('Lpt9.tar.gz')).toBe('_Lpt9.tar.gz');
    expect(sanitizeFileName('COM1')).toBe('_COM1');
    expect(sanitizeFileName('COM0.txt')).toBe('COM0.txt');
    expect(sanitizeFileName('CONSOLA.txt')).toBe('CONSOLA.txt');
    expect(sanitizeFileName('CON  .txt')).toBe('_CON  .txt');
  });

  it('limita a 200 bytes UTF-8 conservando la extensión', () => {
    const pdf = sanitizeFileName(`${'x'.repeat(300)}.pdf`);
    expect(bytes(pdf)).toBe(200);
    expect(pdf.endsWith('.pdf')).toBe(true);

    const multibyte = sanitizeFileName(`${'ñ'.repeat(150)}.txt`);
    expect(bytes(multibyte)).toBeLessThanOrEqual(200);
    expect(multibyte.endsWith('.txt')).toBe(true);
    expect(multibyte).not.toContain('\uFFFD');

    expect(bytes(sanitizeFileName('y'.repeat(500)))).toBe(200);

    const ext = sanitizeFileName(`a.${'z'.repeat(400)}`);
    expect(bytes(ext)).toBeLessThanOrEqual(200);
    expect(ext.length).toBeGreaterThan(0);
  });

  it('no parte pares sustitutos al truncar', () => {
    const n = sanitizeFileName(`${'😀'.repeat(80)}.png`);
    expect(bytes(n)).toBeLessThanOrEqual(200);
    expect(n.endsWith('.png')).toBe(true);
    expect(n).not.toMatch(LONE_SURROGATE);
  });

  it('es idempotente', () => {
    for (const raw of ['../../x', 'CON.txt', `${'x'.repeat(300)}.pdf`, 'nombre. . ', '<>:"|?*', ' . .txt']) {
      const once = sanitizeFileName(raw);
      expect(sanitizeFileName(once)).toBe(once);
    }
  });
});
