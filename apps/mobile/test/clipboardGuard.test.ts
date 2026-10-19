import { describe, expect, it } from 'vitest';

import { SuppressGuard } from '../src/lib/clipboardGuard';

describe('SuppressGuard', () => {
  it('sin escritura en curso no descarta nada', () => {
    const g = new SuppressGuard();
    expect(g.active).toBe(false);
    expect(g.swallow()).toBe(false);
    expect(g.exit()).toBe(false);
  });

  it('un aviso descartado durante la escritura obliga a revisar al soltar', () => {
    const g = new SuppressGuard();
    g.enter();
    expect(g.swallow()).toBe(true);
    expect(g.exit()).toBe(true);
    expect(g.active).toBe(false);
  });

  it('sin avisos descartados no hay revisión', () => {
    const g = new SuppressGuard();
    g.enter();
    expect(g.exit()).toBe(false);
  });

  it('con escrituras anidadas la revisión llega al soltar la última', () => {
    const g = new SuppressGuard();
    g.enter();
    g.enter();
    g.swallow();
    expect(g.exit()).toBe(false);
    expect(g.active).toBe(true);
    expect(g.exit()).toBe(true);
  });

  it('la revisión se pide una sola vez', () => {
    const g = new SuppressGuard();
    g.enter();
    g.swallow();
    g.swallow();
    expect(g.exit()).toBe(true);
    g.enter();
    expect(g.exit()).toBe(false);
  });
});
