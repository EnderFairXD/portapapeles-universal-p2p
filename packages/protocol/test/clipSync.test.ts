import { describe, expect, test } from 'vitest';
import { ClipboardSync, sha256Hex } from '../src/index';

describe('ClipboardSync', () => {
  test('texto nuevo → send; tras markSynced → duplicate', () => {
    const s = new ClipboardSync();
    expect(s.check('hola')).toBe('send');
    s.markSynced('hola');
    expect(s.check('hola')).toBe('duplicate');
    expect(s.check('adiós')).toBe('send');
  });

  test('recibido y escrito no rebota', () => {
    const s = new ClipboardSync();
    s.markSynced('del PC');
    expect(s.check('del PC')).toBe('duplicate');
  });

  test('vacío y solo espacios → empty', () => {
    expect(new ClipboardSync().check('')).toBe('empty');
    expect(new ClipboardSync().check('  \n')).toBe('empty');
  });

  test('1 MiB exacto → send; 1 MiB + 1 byte → too_large', () => {
    expect(new ClipboardSync().check('a'.repeat(1048576))).toBe('send');
    expect(new ClipboardSync().check('a'.repeat(1048577))).toBe('too_large');
  });

  test('el límite se mide en bytes UTF-8, no en caracteres', () => {
    expect(new ClipboardSync().check('😀'.repeat(262144))).toBe('send'); // 1 MiB exacto
    expect(new ClipboardSync().check('😀'.repeat(262144) + 'a')).toBe('too_large');
  });

  test('acepta un hash inicial', () => {
    expect(new ClipboardSync(sha256Hex('x')).check('x')).toBe('duplicate');
  });

  test('lastSyncedHash es null al inicio y el hash del último texto sincronizado después', () => {
    const s = new ClipboardSync();
    expect(s.lastSyncedHash).toBeNull();
    s.markSynced('hola');
    expect(s.lastSyncedHash).toBe(sha256Hex('hola'));
  });

  test('un texto vacío o demasiado grande no se marca como duplicado de uno anterior', () => {
    const s = new ClipboardSync();
    s.markSynced('hola');
    expect(s.check(' ')).toBe('empty');
    expect(s.check('a'.repeat(1048577))).toBe('too_large');
    expect(s.check('hola')).toBe('duplicate');
  });
});
