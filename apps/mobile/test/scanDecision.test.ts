import { bytesToBase64Url } from '@clipsync/protocol';
import { describe, expect, it } from 'vitest';

import { decideScan } from '../src/lib/scanDecision';

const KEY = new Uint8Array(32).fill(7);
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';

function qr(name: string): string {
  return `clipsync://pair?v=2&pk=${bytesToBase64Url(KEY)}&t=${TOKEN}&n=${encodeURIComponent(name)}&ip=192.168.1.5&port=52847`;
}

describe('decideScan', () => {
  it('un texto que no es un QR de ClipSync es inválido', () => {
    expect(decideScan('https://ejemplo.com', null)).toEqual({ kind: 'invalid' });
    expect(decideScan('', 'Mi PC')).toEqual({ kind: 'invalid' });
  });

  it('sin PC emparejado, empareja directamente', () => {
    const d = decideScan(qr('Portátil'), null);
    expect(d.kind).toBe('pair');
    if (d.kind === 'pair') expect(d.info.name).toBe('Portátil');
  });

  it('con otro PC emparejado, pide confirmar la sustitución', () => {
    const d = decideScan(qr('Portátil'), 'Sobremesa');
    expect(d.kind).toBe('confirm');
    if (d.kind === 'confirm') {
      expect(d.current).toBe('Sobremesa');
      expect(d.info.name).toBe('Portátil');
    }
  });
});
