import { describe, expect, test, vi } from 'vitest';
import { ImageSync, sha256Hex } from '../src/index';

const A = sha256Hex('a');
const B = sha256Hex('b');
const C = sha256Hex('c');

describe('ImageSync', () => {
  test('al inicio no hay hashes', () => {
    const s = new ImageSync();
    expect(s.lastSyncedHash).toBeNull();
    expect(s.lastConfirmedHash).toBeNull();
    expect(s.isDuplicate(A)).toBe(false);
  });

  test('acepta un hash confirmado inicial', () => {
    const s = new ImageSync(A);
    expect(s.isDuplicate(A)).toBe(true);
    expect(s.lastConfirmedHash).toBe(A);
    expect(s.lastSyncedHash).toBe(A);
  });

  test('markSent evita el rebote pero no confirma', () => {
    const onChange = vi.fn();
    const s = new ImageSync(null, onChange);
    s.markSent(A);
    expect(s.isDuplicate(A)).toBe(true);
    expect(s.isDuplicate(B)).toBe(false);
    expect(s.lastSyncedHash).toBe(A);
    expect(s.lastConfirmedHash).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('confirmSent confirma lo enviado y avisa una sola vez', () => {
    const onChange = vi.fn();
    const s = new ImageSync(null, onChange);
    s.markSent(A);
    s.confirmSent();
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(A);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(A);
  });

  test('revertSent vuelve al último confirmado', () => {
    const s = new ImageSync(A);
    s.markSent(B);
    expect(s.lastSyncedHash).toBe(B);
    s.revertSent();
    expect(s.lastSyncedHash).toBe(A);
    expect(s.lastConfirmedHash).toBe(A);
    expect(s.isDuplicate(B)).toBe(false);
    s.confirmSent(); // ya no hay nada tentativo
    expect(s.lastConfirmedHash).toBe(A);
  });

  test('revertSent sin confirmado previo vuelve a null', () => {
    const s = new ImageSync();
    s.markSent(A);
    s.revertSent();
    expect(s.lastSyncedHash).toBeNull();
  });

  test('markSynced confirma al momento y avisa', () => {
    const onChange = vi.fn();
    const s = new ImageSync(null, onChange);
    s.markSynced(A);
    expect(s.isDuplicate(A)).toBe(true);
    expect(s.lastConfirmedHash).toBe(A);
    expect(onChange).toHaveBeenCalledWith(A);
  });

  test('markSynced con el mismo hash ya confirmado no avisa de nuevo', () => {
    const onChange = vi.fn();
    const s = new ImageSync(A, onChange);
    s.markSynced(A);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('confirmSent tras un markSynced posterior no hace nada', () => {
    const onChange = vi.fn();
    const s = new ImageSync(null, onChange);
    s.markSent(A);
    s.markSynced(B);
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(B);
    expect(s.lastSyncedHash).toBe(B);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(B);
  });

  test('revertSent tras un markSynced posterior no deshace lo recibido', () => {
    const s = new ImageSync();
    s.markSent(A);
    s.markSynced(B);
    s.revertSent();
    expect(s.lastSyncedHash).toBe(B);
  });

  test('un markSent nuevo sustituye al tentativo anterior', () => {
    const s = new ImageSync(A);
    s.markSent(B);
    s.markSent(C);
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(C);
  });
});
