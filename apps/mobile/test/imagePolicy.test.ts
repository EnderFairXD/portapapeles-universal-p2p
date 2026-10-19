import { describe, expect, it } from 'vitest';

import {
  canWriteClipboard,
  clipboardKind,
  imageExtension,
  ImageKeeper,
  ImageOutbox,
  isOwnWrite,
  outgoingImageName,
  PendingImageWrite,
  pruneImageNames,
  startClipText,
  type HashStore,
} from '../src/lib/imagePolicy';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const R = 'e'.repeat(64);

function memoryStore(initial: string | null = null): HashStore & { saved: (string | null)[] } {
  let value = initial;
  const saved: (string | null)[] = [];
  return {
    saved,
    load: () => value,
    save(h) {
      value = h;
      saved.push(h);
    },
  };
}

describe('clipboardKind', () => {
  it('imagen y texto en la misma copia: gana la imagen', () => {
    expect(clipboardKind(['plain-text', 'image'])).toBe('image');
  });

  it('solo texto', () => {
    expect(clipboardKind(['plain-text'])).toBe('text');
  });

  it('html o url sin texto plano ni imagen: nada que enviar', () => {
    expect(clipboardKind(['html'])).toBe('none');
    expect(clipboardKind([])).toBe('none');
  });
});

describe('imageExtension', () => {
  it('según el mime admitido; png si no se conoce', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/webp')).toBe('webp');
    expect(imageExtension('application/octet-stream')).toBe('png');
  });
});

describe('outgoingImageName', () => {
  it('nombre legible con la fecha local para la carpeta del PC', () => {
    expect(outgoingImageName(new Date(2026, 9, 19, 8, 5, 3))).toBe('imagen-20261019-080503.png');
  });
});

describe('pruneImageNames', () => {
  it('se quedan las más recientes (nombre con marca de tiempo); devuelve las que sobran', () => {
    const names = ['000000000003-c.png', '000000000001-a.png', '000000000002-b.jpg'];
    expect(pruneImageNames(names, 2)).toEqual(['000000000001-a.png']);
    expect(pruneImageNames(names, 5)).toEqual([]);
  });
});

describe('isOwnWrite', () => {
  it('el hash de lo último que escribió la app', () => {
    expect(isOwnWrite(A, A)).toBe(true);
  });

  it('otra imagen, o sin escritura previa', () => {
    expect(isOwnWrite(A, B)).toBe(false);
    expect(isOwnWrite(A, null)).toBe(false);
  });
});

describe('ImageKeeper (R29 de imágenes)', () => {
  it('imagen recibida y escrita: no se reenvía, tampoco tras reconectar ni en frío', () => {
    const store = memoryStore();
    const k = new ImageKeeper(store);
    k.current.markSynced(R); // hash de la lectura de vuelta
    expect(k.current.isDuplicate(R)).toBe(true);
    k.renew(); // la sesión cae
    expect(k.current.isDuplicate(R)).toBe(true);
    expect(store.saved).toEqual([R]);
    expect(new ImageKeeper(store).current.isDuplicate(R)).toBe(true);
  });

  it('enviada sin confirmar y sesión caída: se reenvía al reconectar', () => {
    const store = memoryStore();
    const k = new ImageKeeper(store);
    k.current.markSent(A);
    expect(k.current.isDuplicate(A)).toBe(true); // durante la sesión no rebota
    k.renew();
    expect(k.current.isDuplicate(A)).toBe(false);
    expect(store.saved).toEqual([]); // nunca se persistió lo tentativo
  });

  it('enviada y confirmada: persiste y no se repite tras reconectar', () => {
    const store = memoryStore();
    const k = new ImageKeeper(store);
    k.current.markSent(A);
    k.current.confirmSent();
    k.renew();
    expect(k.current.isDuplicate(A)).toBe(true);
    expect(store.saved).toEqual([A]);
  });

  it('un cierre nunca vuelve el confirmado a null', () => {
    const store = memoryStore(A);
    const k = new ImageKeeper(store);
    k.current.markSent(B);
    k.current.revertSent();
    k.renew();
    expect(k.current.lastConfirmedHash).toBe(A);
    expect(store.saved).toEqual([]);
  });

  it('ajustes ilegibles: como la primera vez', () => {
    const k = new ImageKeeper({
      load: () => {
        throw new Error('roto');
      },
      save: () => {},
    });
    expect(k.current.lastConfirmedHash).toBeNull();
  });
});

describe('ImageOutbox (R7: como mucho una imagen en cola o en curso)', () => {
  function setup() {
    const store = memoryStore();
    const keeper = new ImageKeeper(store);
    const box = new ImageOutbox(() => keeper.current);
    return { store, keeper, box };
  }

  it('una imagen nueva se envía y queda tentativa; done la confirma', () => {
    const { store, keeper, box } = setup();
    expect(box.offer(A)).toEqual({ send: true, cancel: null });
    expect(box.dropQueued()).toBeNull();
    box.sent('t1', A, true);
    expect(keeper.current.isDuplicate(A)).toBe(true);
    expect(keeper.current.lastConfirmedHash).toBeNull();
    box.finished('t1', true);
    expect(keeper.current.lastConfirmedHash).toBe(A);
    expect(store.saved).toEqual([A]);
  });

  it('duplicada: no se envía', () => {
    const { keeper, box } = setup();
    keeper.current.markSynced(R);
    expect(box.offer(R)).toEqual({ send: false, cancel: null });
  });

  it('fallo: vuelve al último confirmado', () => {
    const { keeper, box } = setup();
    box.sent('t1', A, true);
    box.finished('t1', false);
    expect(keeper.current.isDuplicate(A)).toBe(false);
  });

  it('una nueva sustituye a la que espera en cola; la cancelada no revierte la nueva', () => {
    const { keeper, box } = setup();
    box.sent('t1', A, false); // en cola detrás de otro archivo
    expect(box.offer(B)).toEqual({ send: true, cancel: null });
    expect(box.dropQueued()).toEqual({ id: 't1', hash: A });
    box.sent('t2', B, false);
    box.finished('t1', false); // llega su 'cancelled': ya no se sigue
    expect(keeper.current.isDuplicate(B)).toBe(true);
    box.finished('t2', true);
    expect(keeper.current.lastConfirmedHash).toBe(B);
  });

  it('la que está en vuelo termina y la nueva va detrás', () => {
    const { keeper, box } = setup();
    box.sent('t1', A, true);
    expect(box.offer(B)).toEqual({ send: true, cancel: null });
    expect(box.dropQueued()).toBeNull(); // la de vuelo no se toca
    box.sent('t2', B, false);
    box.finished('t1', true); // ya no es la última marcada: no confirma nada
    expect(keeper.current.lastConfirmedHash).toBeNull();
    box.finished('t2', true);
    expect(keeper.current.lastConfirmedHash).toBe(B);
  });

  it('la misma que ya espera en cola: no se encola otra vez', () => {
    const { box } = setup();
    box.sent('t1', A, false);
    expect(box.offer(A)).toEqual({ send: false, cancel: null });
  });

  it('la misma que está en vuelo: se cancela la de la cola y vuelve a ser la tentativa', () => {
    const { keeper, box } = setup();
    box.sent('t1', A, true);
    box.sent('t2', B, false);
    expect(box.offer(A)).toEqual({ send: false, cancel: 't2' });
    box.finished('t2', false); // su 'cancelled'
    expect(keeper.current.isDuplicate(A)).toBe(true);
    box.finished('t1', true);
    expect(keeper.current.lastConfirmedHash).toBe(A);
  });

  it('pasa de cola a vuelo con started()', () => {
    const { box } = setup();
    box.sent('t1', A, false);
    box.started('t1');
    expect(box.offer(B)).toEqual({ send: true, cancel: null });
    expect(box.dropQueued()).toBeNull();
  });

  it('una recibida después de enviar: el fin de la enviada no toca lo recibido', () => {
    const { keeper, box } = setup();
    box.sent('t1', A, true);
    keeper.current.markSynced(R);
    box.finished('t1', false);
    expect(keeper.current.isDuplicate(R)).toBe(true);
    expect(keeper.current.lastConfirmedHash).toBe(R);
  });

  it('sendFile falla tras quitar la de la cola: se revierte la quitada', () => {
    const { keeper, box } = setup();
    keeper.current.markSynced(C);
    box.sent('t1', A, false);
    expect(box.dropQueued()).toEqual({ id: 't1', hash: A });
    box.settle(A, false);
    expect(keeper.current.isDuplicate(C)).toBe(true);
  });

  it('clear() olvida lo pendiente (sesión cerrada)', () => {
    const { box } = setup();
    box.sent('t1', A, false);
    box.clear();
    expect(box.dropQueued()).toBeNull();
  });
});

describe('startClipText (regla de inicio)', () => {
  it('con una imagen en el portapapeles no se anuncia el texto que viene con ella (ni se lee)', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return 'https://ejemplo.com/foto.png';
    };
    expect(await startClipText(true, read)).toBeNull();
    expect(reads).toBe(0);
  });

  it('sin imagen se anuncia el texto', async () => {
    expect(await startClipText(false, async () => 'hola')).toBe('hola');
  });

  it('sin texto, nada', async () => {
    expect(await startClipText(false, async () => null)).toBeNull();
  });
});

describe('canWriteClipboard', () => {
  it('solo en primer plano (en segundo Android no deja leer lo escrito)', () => {
    expect(canWriteClipboard('active')).toBe(true);
    expect(canWriteClipboard('background')).toBe(false);
    expect(canWriteClipboard('inactive')).toBe(false);
  });
});

describe('PendingImageWrite', () => {
  it('guarda una imagen y la entrega una sola vez', () => {
    const p = new PendingImageWrite();
    expect(p.take()).toBeNull();
    expect(p.set({ uri: 'file:///a.png', temp: null })).toBeNull();
    expect(p.take()).toEqual({ uri: 'file:///a.png', temp: null });
    expect(p.take()).toBeNull();
  });

  it('una imagen nueva sustituye a la pendiente y devuelve la antigua para limpiarla', () => {
    const p = new PendingImageWrite();
    p.set({ uri: 'file:///a.png', temp: 'file:///cache/a.png' });
    expect(p.set({ uri: 'file:///b.png', temp: null })).toEqual({ uri: 'file:///a.png', temp: 'file:///cache/a.png' });
    expect(p.take()?.uri).toBe('file:///b.png');
  });

  it('clear devuelve lo descartado', () => {
    const p = new PendingImageWrite();
    p.set({ uri: 'file:///a.png', temp: null });
    expect(p.clear()?.uri).toBe('file:///a.png');
    expect(p.clear()).toBeNull();
  });
});
