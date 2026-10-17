import { describe, expect, it } from 'vitest';

import { connectCandidates, parseLastPc, servicePcs } from '../src/lib/pcAddress';

describe('servicePcs', () => {
  it('devuelve todas las direcciones resueltas, primero las IPv4', () => {
    expect(
      servicePcs({ name: 'pc', port: 52847, addresses: ['fe80::1', '192.168.1.5', '10.0.0.2'], txt: { v: '2' } }),
    ).toEqual([
      { host: '192.168.1.5', port: 52847 },
      { host: '10.0.0.2', port: 52847 },
      { host: 'fe80::1', port: 52847 },
    ]);
  });

  it('descarta otra versión del protocolo, sin puerto o sin direcciones', () => {
    expect(servicePcs({ name: 'pc', port: 52847, addresses: ['1.2.3.4'], txt: { v: '1' } })).toEqual([]);
    expect(servicePcs({ name: 'pc', port: 0, addresses: ['1.2.3.4'] })).toEqual([]);
    expect(servicePcs({ name: 'pc', port: 52847, addresses: [] })).toEqual([]);
    expect(servicePcs({ name: 'pc', port: 52847 })).toEqual([]);
  });
});

describe('connectCandidates', () => {
  const a = { host: '192.168.1.5', port: 52847 };
  const b = { host: '192.168.1.9', port: 52847 };

  it('prueba primero la última dirección que funcionó y luego las resueltas, sin repetir', () => {
    expect(connectCandidates(b, [a, b])).toEqual([b, a]);
    expect(connectCandidates(null, [a, b])).toEqual([a, b]);
    expect(connectCandidates(a, [])).toEqual([a]);
    expect(connectCandidates(null, [a, a])).toEqual([a]);
  });
});

describe('parseLastPc', () => {
  it('acepta solo un host no vacío y un puerto válido', () => {
    expect(parseLastPc({ host: '192.168.1.5', port: 52847 })).toEqual({ host: '192.168.1.5', port: 52847 });
    expect(parseLastPc({ host: '', port: 52847 })).toBeNull();
    expect(parseLastPc({ host: 'x', port: 70000 })).toBeNull();
    expect(parseLastPc({ host: 'x', port: '52847' })).toBeNull();
    expect(parseLastPc(null)).toBeNull();
    expect(parseLastPc('192.168.1.5')).toBeNull();
  });
});
