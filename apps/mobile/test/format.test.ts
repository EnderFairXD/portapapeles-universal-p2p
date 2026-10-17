import { describe, expect, it } from 'vitest';

import {
  failureText,
  filesLabel,
  formatClock,
  formatProgress,
  percent,
  preview,
  readableDir,
  transferDetail,
} from '../src/lib/format';

describe('failureText', () => {
  it('traduce los códigos conocidos', () => {
    expect(failureText('size_mismatch')).toBe('Falló: el tamaño no coincide');
    expect(failureText('heartbeat_timeout')).toBe('Falló: el PC dejó de responder');
  });

  it('muestra «Falló» a secas con códigos desconocidos, vacíos o nulos', () => {
    expect(failureText('<script>alert(1)</script>')).toBe('Falló');
    expect(failureText('constructor')).toBe('Falló');
    expect(failureText('__proto__')).toBe('Falló');
    expect(failureText('')).toBe('Falló');
    expect(failureText(null)).toBe('Falló');
    expect(failureText(undefined)).toBe('Falló');
  });
});

describe('transferDetail', () => {
  const base = { bytes: 0, size: 0 };
  it('cubre cada estado', () => {
    expect(transferDetail({ ...base, state: 'queued' })).toBe('En cola');
    expect(transferDetail({ ...base, state: 'cancelled' })).toBe('Cancelado');
    expect(transferDetail({ ...base, state: 'failed', error: 'io_error' })).toBe('Falló: no se pudo guardar el archivo');
    expect(transferDetail({ ...base, state: 'failed' })).toBe('Falló');
    expect(transferDetail({ bytes: 1536 * 1024, size: 5 * 1024 * 1024, state: 'active' })).toBe('1,5 MB de 5,0 MB');
  });
});

describe('formatProgress y percent', () => {
  it('usa la unidad del tamaño total', () => {
    expect(formatProgress(512, 900)).toBe('512 B de 900 B');
    expect(formatProgress(0, 2048)).toBe('0,0 KB de 2,0 KB');
  });
  it('aguanta valores raros', () => {
    expect(formatProgress(Number.NaN, 10)).toBe('0 B de 10 B');
    expect(percent(5, 0)).toBe(0);
    expect(percent(50, 100)).toBe(50);
    expect(percent(500, 100)).toBe(100);
    expect(percent(-5, 100)).toBe(0);
  });
});

describe('readableDir', () => {
  it('lee las carpetas de almacenamiento interno', () => {
    expect(readableDir('content://com.android.externalstorage.documents/tree/primary%3ADownload%2FClipSync')).toBe(
      'Download/ClipSync',
    );
  });
  it('lee la raíz y otros volúmenes', () => {
    expect(readableDir('content://com.android.externalstorage.documents/tree/primary%3A')).toBe(
      'Almacenamiento interno',
    );
    expect(readableDir('content://x/tree/1A2B-3C4D%3AMusica')).toBe('Musica');
  });
  it('sin carpeta', () => {
    expect(readableDir(null)).toBe('Sin elegir');
    expect(readableDir('')).toBe('Sin elegir');
  });
  it('ignora la parte /document/', () => {
    expect(readableDir('content://x/tree/primary%3AA/document/primary%3AA%2FB')).toBe('A');
  });
});

describe('otros', () => {
  it('filesLabel', () => {
    expect(filesLabel(1)).toBe('1 archivo');
    expect(filesLabel(2)).toBe('2 archivos');
  });
  it('formatClock', () => {
    expect(formatClock(0)).toBeNull();
    expect(formatClock(Number.NaN)).toBeNull();
    expect(formatClock(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05');
  });
  it('preview no parte pares sustitutos', () => {
    expect(preview('abc', 5)).toBe('abc');
    expect(preview('a😀b', 2)).toBe('a…');
  });
});
