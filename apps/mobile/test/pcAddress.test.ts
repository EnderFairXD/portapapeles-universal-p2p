import { describe, expect, it } from 'vitest';

import { connectCandidates, parseLastPc, servicePcs } from '../src/lib/pcAddress';

const FP = '0123456789abcdef';

describe('servicePcs', () => {
  it('con la huella igual devuelve todas las direcciones, primero las IPv4', () => {
    expect(
      servicePcs(
        { name: 'pc', port: 52847, addresses: ['fe80::1', '192.168.1.5', '10.0.0.2'], txt: { v: '2', fp: FP } },
        FP,
      ),
    ).toEqual([
      { host: '192.168.1.5', port: 52847 },
      { host: '10.0.0.2', port: 52847 },
      { host: 'fe80::1', port: 52847 },
    ]);
  });

  it('con otra huella o sin ella no devuelve nada (otro PC de la red)', () => {
    const base = { name: 'pc', port: 52847, addresses: ['1.2.3.4'] };
    expect(servicePcs({ ...base, txt: { v: '2', fp: 'fedcba9876543210' } }, FP)).toEqual([]);
    expect(servicePcs({ ...base, txt: { v: '2' } }, FP)).toEqual([]);
    expect(servicePcs(base, FP)).toEqual([]);
  });

  it('descarta otra versión del protocolo, sin puerto o sin direcciones', () => {
    expect(servicePcs({ name: 'pc', port: 52847, addresses: ['1.2.3.4'], txt: { v: '1', fp: FP } }, FP)).toEqual([]);
    expect(servicePcs({ name: 'pc', port: 0, addresses: ['1.2.3.4'], txt: { fp: FP } }, FP)).toEqual([]);
    expect(servicePcs({ name: 'pc', port: 52847, addresses: [], txt: { fp: FP } }, FP)).toEqual([]);
    expect(servicePcs({ name: 'pc', port: 52847, txt: { fp: FP } }, FP)).toEqual([]);
  });
});

describe('connectCandidates', () => {
  const a = { host: '192.168.1.5', port: 52847 };
  const b = { host: '192.168.1.9', port: 52847 };
  const c = { host: '10.0.0.2', port: 52847 };

  it('prueba la última dirección, después mDNS y después el QR, sin repetir y en ese orden', () => {
    expect(connectCandidates(b, [a, b], [c, a])).toEqual([b, a, c]);
    expect(connectCandidates(null, [a, b], [b, c])).toEqual([a, b, c]);
    expect(connectCandidates(a, [], [])).toEqual([a]);
    expect(connectCandidates(null, [a, a], [a])).toEqual([a]);
    expect(connectCandidates(null, [], [c])).toEqual([c]);
    expect(connectCandidates(null, [], [])).toEqual([]);
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
