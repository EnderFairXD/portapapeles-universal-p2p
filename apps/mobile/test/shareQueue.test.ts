import { describe, expect, it } from 'vitest';

import { newShareProgress, runShareQueue, type ShareStep } from '../src/lib/shareQueue';

const script = (steps: ShareStep[]) => {
  let i = 0;
  return () => steps[i++] ?? { kind: 'sent' as const };
};

describe('runShareQueue', () => {
  it('envía todo y termina', () => {
    const p = newShareProgress({});
    expect(runShareQueue(['a', 'b'], p, script([{ kind: 'sent' }, { kind: 'sent' }]))).toBe('done');
    expect(p.next).toBe(2);
    expect(p.failure).toBeNull();
  });

  it('salta un archivo rechazado, conserva su aviso y no lo reintenta', () => {
    const p = newShareProgress({});
    const seen: string[] = [];
    const r = runShareQueue(['a', 'b', 'c'], p, (f) => {
      seen.push(f);
      return f === 'b' ? { kind: 'failed', message: 'malo' } : { kind: 'sent' };
    });
    expect(r).toBe('done');
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(p.failure).toBe('malo');
  });

  it('el aviso de un fallo sobrevive a una caída de conexión posterior', () => {
    const p = newShareProgress({});
    const first = runShareQueue(['a', 'b', 'c'], p, script([{ kind: 'failed', message: 'malo' }, { kind: 'no_connection' }]));
    expect(first).toBe('waiting');
    expect(p.next).toBe(1);
    expect(p.failure).toBe('malo');
    // al volver la conexión sigue en «b» y «a» no se repite
    const seen: string[] = [];
    const second = runShareQueue(['a', 'b', 'c'], p, (f) => {
      seen.push(f);
      return { kind: 'sent' };
    });
    expect(second).toBe('done');
    expect(seen).toEqual(['b', 'c']);
    expect(p.failure).toBe('malo');
  });
});
