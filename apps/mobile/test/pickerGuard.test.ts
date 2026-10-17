import { describe, expect, it } from 'vitest';

import { createPickerGuard } from '../src/lib/pickerGuard';

describe('createPickerGuard', () => {
  it('cuenta los selectores abiertos', () => {
    const g = createPickerGuard();
    expect(g.isOpen()).toBe(false);
    const a = g.enter();
    const b = g.enter();
    g.leave(a);
    expect(g.isOpen()).toBe(true);
    g.leave(b);
    expect(g.isOpen()).toBe(false);
  });

  it('reset() libera un selector que nunca termina', () => {
    const g = createPickerGuard();
    g.enter();
    expect(g.isOpen()).toBe(true);
    g.reset();
    expect(g.isOpen()).toBe(false);
  });

  it('el cierre tardío de un selector anterior al reset no resta a uno nuevo', () => {
    const g = createPickerGuard();
    const old = g.enter();
    g.reset();
    g.enter();
    g.leave(old);
    expect(g.isOpen()).toBe(true);
  });

  it('nunca baja de cero', () => {
    const g = createPickerGuard();
    const t = g.enter();
    g.leave(t);
    g.leave(t);
    g.enter();
    expect(g.isOpen()).toBe(true);
  });
});
