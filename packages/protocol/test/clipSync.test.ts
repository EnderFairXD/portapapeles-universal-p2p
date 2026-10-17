import { describe, expect, test } from 'vitest';
import { ClipboardSync, decideClip, MAX_CLIP_BYTES, sha256Hex, toWellFormed } from '../src/index';

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

describe('ClipboardSync en dos fases (enviado → confirmado)', () => {
  test('el constructor recibe el hash confirmado inicial', () => {
    const s = new ClipboardSync(sha256Hex('x'));
    expect(s.lastConfirmedHash).toBe(sha256Hex('x'));
    expect(s.lastSyncedHash).toBe(sha256Hex('x'));
    expect(new ClipboardSync().lastConfirmedHash).toBeNull();
  });

  test('markSent es tentativo: evita el rebote pero no cambia el confirmado', () => {
    const s = new ClipboardSync(sha256Hex('viejo'));
    s.markSent('nuevo');
    expect(s.check('nuevo')).toBe('duplicate');
    expect(s.lastSyncedHash).toBe(sha256Hex('nuevo'));
    expect(s.lastConfirmedHash).toBe(sha256Hex('viejo'));
  });

  test('confirmSent promueve lo enviado a confirmado', () => {
    const s = new ClipboardSync();
    s.markSent('hola');
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(sha256Hex('hola'));
    expect(s.check('hola')).toBe('duplicate');
  });

  test('markSynced confirma al instante (texto recibido)', () => {
    const s = new ClipboardSync();
    s.markSynced('del PC');
    expect(s.lastConfirmedHash).toBe(sha256Hex('del PC'));
  });

  test('un texto recibido tras un envío sin confirmar gana: confirmSent ya no hace nada', () => {
    const s = new ClipboardSync();
    s.markSent('enviado');
    s.markSynced('recibido');
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(sha256Hex('recibido'));
    expect(s.lastSyncedHash).toBe(sha256Hex('recibido'));
  });

  test('confirmSent sin nada pendiente no cambia nada', () => {
    const s = new ClipboardSync(sha256Hex('a'));
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(sha256Hex('a'));
  });

  test('avisa del cambio del confirmado solo cuando cambia', () => {
    const seen: (string | null)[] = [];
    const s = new ClipboardSync(null, (h) => seen.push(h));
    s.markSent('a');
    expect(seen).toEqual([]);
    s.confirmSent();
    s.confirmSent();
    s.markSynced('a'); // mismo hash: sin aviso
    s.markSynced('b');
    expect(seen).toEqual([sha256Hex('a'), sha256Hex('b')]);
  });
});

describe('toWellFormed y textos con sustitutos sueltos', () => {
  test('cambia los sustitutos sueltos por U+FFFD y deja los pares', () => {
    expect(toWellFormed('a\ud800b')).toBe('a�b');
    expect(toWellFormed('\udc00')).toBe('�');
    expect(toWellFormed('x\ud83d')).toBe('x�');
    expect(toWellFormed('\udc00\ud800')).toBe('��');
    expect(toWellFormed('😀 bien')).toBe('😀 bien');
    expect(toWellFormed('')).toBe('');
  });

  test('check, markSynced y markSent tratan igual un texto y su versión bien formada', () => {
    const s = new ClipboardSync();
    s.markSynced('a\ud800');
    expect(s.check('a�')).toBe('duplicate');
    expect(s.lastSyncedHash).toBe(sha256Hex('a�'));
    s.markSent('b\udfff');
    expect(s.check('b�')).toBe('duplicate');
    s.confirmSent();
    expect(s.lastConfirmedHash).toBe(sha256Hex('b�'));
  });
});

describe('decideClip', () => {
  test('igual que check, salvo que un JSON que no cabe es too_large', () => {
    const s = new ClipboardSync();
    expect(decideClip(s, 'hola')).toBe('send');
    expect(decideClip(s, ' ')).toBe('empty');
    s.markSynced('hola');
    expect(decideClip(s, 'hola')).toBe('duplicate');
    // cabe en 1 MiB, pero cada comilla ocupa 2 bytes en JSON
    expect(decideClip(s, '"'.repeat(MAX_CLIP_BYTES))).toBe('too_large');
  });
});
