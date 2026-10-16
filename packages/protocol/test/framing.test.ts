import { describe, expect, test } from 'vitest';
import { FrameDecoder, encodeFrame } from '../src/framing';

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('framing', () => {
  test('encodeFrame antepone la longitud u16 big-endian', () => {
    expect(encodeFrame(Uint8Array.of(0xaa, 0xbb))).toEqual(Uint8Array.of(0x00, 0x02, 0xaa, 0xbb));
  });

  test('encodeFrame acepta 65535 bytes y rechaza 65536', () => {
    const frame = encodeFrame(new Uint8Array(65535));
    expect(frame.length).toBe(65537);
    expect(frame.slice(0, 2)).toEqual(Uint8Array.of(0xff, 0xff));
    expect(() => encodeFrame(new Uint8Array(65536))).toThrow(RangeError);
  });

  test('FrameDecoder reensambla tramas partidas en trozos arbitrarios', () => {
    const bytes = concat(encodeFrame(Uint8Array.of(1)), encodeFrame(new Uint8Array(0)), encodeFrame(Uint8Array.of(2, 3)));
    const d = new FrameDecoder();
    const out = [...bytes].flatMap((b) => d.push(Uint8Array.of(b))); // byte a byte
    expect(out).toEqual([Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)]);
  });

  test('FrameDecoder devuelve varias tramas de un solo trozo', () => {
    const bytes = concat(encodeFrame(Uint8Array.of(1)), encodeFrame(new Uint8Array(0)), encodeFrame(Uint8Array.of(2, 3)));
    const out = new FrameDecoder().push(bytes);
    expect(out).toEqual([Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)]);
  });

  test('FrameDecoder conserva el resto incompleto entre llamadas', () => {
    const d = new FrameDecoder();
    const frame = encodeFrame(Uint8Array.of(7, 8, 9));
    expect(d.push(frame.slice(0, 3))).toEqual([]);
    expect(d.push(frame.slice(3))).toEqual([Uint8Array.of(7, 8, 9)]);
  });

  test('FrameDecoder reensambla una trama máxima de 65535 bytes en trozos', () => {
    const payload = new Uint8Array(65535).fill(0x5a);
    const frame = encodeFrame(payload);
    const d = new FrameDecoder();
    expect(d.push(frame.slice(0, 30000))).toEqual([]);
    const out = d.push(frame.slice(30000));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(payload);
  });
});
