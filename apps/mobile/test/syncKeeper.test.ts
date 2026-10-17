import { decideClip, sha256Hex } from '@clipsync/protocol';
import { describe, expect, it } from 'vitest';

import { SyncKeeper, type HashStore } from '../src/lib/syncKeeper';

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

/** Lo que el móvil anuncia en su hello: willSendClip = la Session enviaría su texto. */
const announces = (k: SyncKeeper, phoneClip: string) => decideClip(k.current, phoneClip) === 'send';

describe('SyncKeeper (R29)', () => {
  it('pausa y vuelta con solo el PC cambiado: el móvil no anuncia willSendClip', () => {
    const k = new SyncKeeper(memoryStore());
    // sesión 1: el móvil envió «A» y el PC lo confirmó con su pong
    k.current.markSent('A');
    k.current.confirmSent();
    k.renew(); // pause(): cierre ordenado
    // el PC copió otra cosa mientras tanto; el portapapeles del móvil sigue en «A»
    expect(announces(k, 'A')).toBe(false);
  });

  it('solo cambió el móvil: anuncia', () => {
    const k = new SyncKeeper(memoryStore());
    k.current.markSynced('A');
    k.renew();
    expect(announces(k, 'B')).toBe(true);
  });

  it('arranque en frío con un hash guardado: no reenvía lo ya sincronizado', () => {
    const k = new SyncKeeper(memoryStore(sha256Hex('A')));
    expect(announces(k, 'A')).toBe(false);
    expect(announces(k, 'B')).toBe(true);
  });

  it('cierre anómalo tras un envío sin confirmar: vuelve a anunciarlo', () => {
    const store = memoryStore();
    const k = new SyncKeeper(store);
    k.current.markSent('A'); // el pong no llegó
    expect(announces(k, 'A')).toBe(false); // durante la sesión no rebota
    k.renew(); // link_closed / heartbeat_timeout
    expect(announces(k, 'A')).toBe(true);
    expect(store.saved).toEqual([]);
  });

  it('cierre anómalo tras un envío confirmado: no lo vuelve a anunciar', () => {
    const k = new SyncKeeper(memoryStore());
    k.current.markSent('A');
    k.current.confirmSent();
    k.renew();
    expect(announces(k, 'A')).toBe(false);
  });

  it('persiste cada cambio del hash confirmado, también lo recibido', () => {
    const store = memoryStore();
    const k = new SyncKeeper(store);
    k.current.markSynced('del PC');
    k.current.markSent('del móvil');
    k.current.confirmSent();
    expect(store.saved).toEqual([sha256Hex('del PC'), sha256Hex('del móvil')]);
    // tras renovar, la instancia nueva sigue persistiendo
    k.renew().markSynced('otro');
    expect(store.saved.at(-1)).toBe(sha256Hex('otro'));
  });

  it('un fallo al guardar no rompe la sincronización', () => {
    const k = new SyncKeeper({
      load: () => null,
      save: () => {
        throw new Error('disco lleno');
      },
    });
    expect(() => k.current.markSynced('A')).not.toThrow();
    expect(k.current.lastConfirmedHash).toBe(sha256Hex('A'));
  });
});
