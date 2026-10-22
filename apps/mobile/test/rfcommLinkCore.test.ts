import { describe, expect, it } from 'vitest';

import { createRfcommDispatcher, makeRfcommLink, type RfcommBridge } from '../src/lib/rfcommLinkCore';

/** Puente falso: base64 «de verdad» con Buffer (solo en tests) y registro de las llamadas nativas. */
function fakeBridge() {
  const dispatcher = createRfcommDispatcher();
  const calls: string[] = [];
  const written: Uint8Array[] = [];
  let failWrite = false;
  const bridge: RfcommBridge = {
    register: dispatcher.register,
    encode: (b) => Buffer.from(b).toString('base64'),
    decode: (t) => new Uint8Array(Buffer.from(t, 'base64')),
    write(id, b64) {
      if (failWrite) throw new Error('módulo liberado');
      calls.push(`write:${id}`);
      written.push(new Uint8Array(Buffer.from(b64, 'base64')));
    },
    close(id) {
      calls.push(`close:${id}`);
    },
  };
  return { bridge, dispatcher, calls, written, failNextWrites: () => (failWrite = true) };
}

const b64 = (...bytes: number[]) => Buffer.from(bytes).toString('base64');

describe('makeRfcommLink', () => {
  it('entrega los trozos en orden, también los llegados antes de onData', () => {
    const { bridge, dispatcher } = fakeBridge();
    const link = makeRfcommLink(7, bridge);
    dispatcher.data(7, b64(1, 2));
    dispatcher.data(7, b64(3));
    const got: number[][] = [];
    link.onData((b) => got.push([...b]));
    dispatcher.data(7, b64(4, 5, 6));
    expect(got).toEqual([[1, 2], [3], [4, 5, 6]]);
  });

  it('ignora eventos de otros enlaces', () => {
    const { bridge, dispatcher } = fakeBridge();
    const link = makeRfcommLink(1, bridge);
    const got: number[][] = [];
    link.onData((b) => got.push([...b]));
    dispatcher.data(2, b64(9));
    expect(got).toEqual([]);
  });

  it('los bytes llegan antes de avisar del cierre', () => {
    const { bridge, dispatcher } = fakeBridge();
    const link = makeRfcommLink(1, bridge);
    const log: string[] = [];
    link.onData((b) => log.push(`data:${b.length}`));
    link.onClose((e) => log.push(`close:${e?.message ?? ''}`));
    dispatcher.data(1, b64(1, 2, 3));
    dispatcher.closed(1, 'se cayó');
    expect(log).toEqual(['data:3', 'close:se cayó']);
  });

  it('write envía en base64 y lanza tras cerrar', () => {
    const { bridge, dispatcher, written } = fakeBridge();
    const link = makeRfcommLink(1, bridge);
    link.onClose(() => {});
    link.write(new Uint8Array([1, 2, 3]));
    expect([...written[0]!]).toEqual([1, 2, 3]);
    dispatcher.closed(1);
    expect(() => link.write(new Uint8Array([1]))).toThrow();
  });

  it('close() pide el cierre una sola vez y ya no admite escribir; onClose llega al cerrarse el socket', () => {
    const { bridge, dispatcher, calls } = fakeBridge();
    const link = makeRfcommLink(3, bridge);
    const closes: (Error | undefined)[] = [];
    link.onClose((e) => closes.push(e));
    link.close();
    link.close();
    expect(calls).toEqual(['close:3']);
    expect(() => link.write(new Uint8Array([1]))).toThrow();
    expect(closes).toEqual([]);
    dispatcher.closed(3);
    dispatcher.closed(3);
    expect(closes).toEqual([undefined]);
  });

  it('onClose registrado después del cierre se avisa al momento con el error', () => {
    const { bridge, dispatcher } = fakeBridge();
    const link = makeRfcommLink(1, bridge);
    dispatcher.closed(1, 'x');
    let got: Error | undefined;
    link.onClose((e) => (got = e));
    expect(got?.message).toBe('x');
  });

  it('si el módulo nativo falla al escribir, el enlace se da por cerrado con error', () => {
    const { bridge, failNextWrites } = fakeBridge();
    const link = makeRfcommLink(1, bridge);
    let closed: Error | undefined;
    link.onClose((e) => (closed = e));
    failNextWrites();
    expect(() => link.write(new Uint8Array([1]))).toThrow();
    expect(closed?.message).toContain('módulo liberado');
  });

  it('tras desregistrarse (cierre) los eventos tardíos no hacen nada', () => {
    const { bridge, dispatcher } = fakeBridge();
    const link = makeRfcommLink(1, bridge);
    const got: number[] = [];
    link.onData((b) => got.push(b.length));
    dispatcher.closed(1);
    dispatcher.data(1, b64(1));
    expect(got).toEqual([]);
  });
});
