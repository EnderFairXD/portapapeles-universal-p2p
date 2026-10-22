import { describe, expect, it } from 'vitest';

import {
  BT_CONNECT_TIMEOUT_MS,
  BT_RETRY_COOLDOWN_MS,
  UPGRADE_INTERVAL_MS,
  allowsTransport,
  betterTransports,
  btCoolingDown,
  candidates,
  modeChangeAction,
  modeChangePending,
  parseBtAddress,
  parseTransportMode,
  shouldUpgrade,
  transportTimeoutMs,
  type PolicyCtx,
} from '../src/lib/transportPolicy';

const BT = 'AA:BB:CC:DD:EE:FF';
const ok: PolicyCtx = { btAddress: BT, btPermission: 'granted', btState: 'on', btCoolingDown: false };

describe('candidates', () => {
  it('auto con todo disponible: WiFi, USB y Bluetooth, en ese orden', () => {
    expect(candidates('auto', ok)).toEqual({ transports: ['wifi', 'usb', 'bluetooth'], issue: null, reason: null });
  });

  it('auto sin permiso denegado: se salta Bluetooth sin error', () => {
    const r = candidates('auto', { ...ok, btPermission: 'denied' });
    expect(r.transports).toEqual(['wifi', 'usb']);
    expect(r.issue).toBe('no_permission');
    expect(r.reason).toBeNull();
  });

  it('auto con permiso aún sin decidir: Bluetooth se ofrece (se pedirá al usarlo)', () => {
    expect(candidates('auto', { ...ok, btPermission: 'undetermined' }).transports).toEqual(['wifi', 'usb', 'bluetooth']);
  });

  it('auto sin dirección, con Bluetooth apagado o sin adaptador: se salta', () => {
    expect(candidates('auto', { ...ok, btAddress: null })).toMatchObject({ transports: ['wifi', 'usb'], issue: 'no_address' });
    expect(candidates('auto', { ...ok, btState: 'off' })).toMatchObject({ transports: ['wifi', 'usb'], issue: 'off' });
    expect(candidates('auto', { ...ok, btState: 'unavailable' })).toMatchObject({ transports: ['wifi', 'usb'], issue: 'unavailable' });
  });

  it('auto tras un fallo reciente de Bluetooth: espera antes de reintentarlo, pero no es un problema', () => {
    expect(candidates('auto', { ...ok, btCoolingDown: true })).toEqual({ transports: ['wifi', 'usb'], issue: null, reason: null });
  });

  it('modo fijo wifi o usb: solo ese medio, aunque falte lo de Bluetooth', () => {
    expect(candidates('wifi', { ...ok, btAddress: null })).toEqual({ transports: ['wifi'], issue: 'no_address', reason: null });
    expect(candidates('usb', ok).transports).toEqual(['usb']);
  });

  it('modo fijo bluetooth con todo en orden', () => {
    expect(candidates('bluetooth', ok)).toEqual({ transports: ['bluetooth'], issue: null, reason: null });
  });

  it('modo fijo bluetooth sin dirección: motivo y ningún medio', () => {
    expect(candidates('bluetooth', { ...ok, btAddress: null })).toEqual({
      transports: [],
      issue: 'no_address',
      reason: 'Empareja el móvil y el PC en los ajustes de Bluetooth del sistema',
    });
  });

  it('modo fijo bluetooth: motivo para permiso denegado, apagado y sin adaptador', () => {
    expect(candidates('bluetooth', { ...ok, btPermission: 'denied' }).reason).toBe('Permite el acceso a Bluetooth para conectar sin WiFi');
    expect(candidates('bluetooth', { ...ok, btState: 'off' }).reason).toBe('Bluetooth apagado');
    expect(candidates('bluetooth', { ...ok, btState: 'unavailable' }).reason).toBe('Este móvil no tiene Bluetooth');
  });

  it('modo fijo bluetooth ignora la espera tras un fallo', () => {
    expect(candidates('bluetooth', { ...ok, btCoolingDown: true }).transports).toEqual(['bluetooth']);
  });
});

describe('plazos', () => {
  it('WiFi y USB 2 s, Bluetooth 8 s', () => {
    expect(transportTimeoutMs('wifi')).toBe(2000);
    expect(transportTimeoutMs('usb')).toBe(2000);
    expect(transportTimeoutMs('bluetooth')).toBe(BT_CONNECT_TIMEOUT_MS);
    expect(BT_CONNECT_TIMEOUT_MS).toBe(8000);
  });
});

describe('shouldUpgrade', () => {
  const idle = { connectedForMs: UPGRADE_INTERVAL_MS, busy: false };

  it('de Bluetooth a mejor medio en auto, sin transferencias', () => {
    expect(shouldUpgrade('bluetooth', 'auto', idle)).toBe(true);
    expect(shouldUpgrade('usb', 'auto', idle)).toBe(true);
  });

  it('por WiFi no hay nada mejor', () => {
    expect(shouldUpgrade('wifi', 'auto', idle)).toBe(false);
  });

  it('no con una transferencia en curso o en cola', () => {
    expect(shouldUpgrade('bluetooth', 'auto', { ...idle, busy: true })).toBe(false);
  });

  it('no antes de 30 s conectado', () => {
    expect(shouldUpgrade('bluetooth', 'auto', { connectedForMs: UPGRADE_INTERVAL_MS - 1, busy: false })).toBe(false);
  });

  it('no en modo fijo', () => {
    expect(shouldUpgrade('bluetooth', 'wifi', idle)).toBe(false);
    expect(shouldUpgrade('usb', 'bluetooth', idle)).toBe(false);
  });
});

describe('betterTransports y allowsTransport', () => {
  it('lo mejor que lo actual, en orden de preferencia', () => {
    expect(betterTransports('bluetooth')).toEqual(['wifi', 'usb']);
    expect(betterTransports('usb')).toEqual(['wifi']);
    expect(betterTransports('wifi')).toEqual([]);
  });

  it('el modo fijo solo admite su medio; auto admite todos', () => {
    expect(allowsTransport('auto', 'usb')).toBe(true);
    expect(allowsTransport('wifi', 'usb')).toBe(false);
    expect(allowsTransport('bluetooth', 'bluetooth')).toBe(true);
  });
});

describe('btCoolingDown', () => {
  it('sin fallo previo no espera', () => {
    expect(btCoolingDown(null, 1_000_000)).toBe(false);
  });
  it('espera hasta cumplirse el plazo', () => {
    expect(btCoolingDown(1000, 1000 + BT_RETRY_COOLDOWN_MS - 1)).toBe(true);
    expect(btCoolingDown(1000, 1000 + BT_RETRY_COOLDOWN_MS)).toBe(false);
  });
  it('un reloj que va hacia atrás no bloquea para siempre', () => {
    expect(btCoolingDown(5000, 1000)).toBe(false);
  });
});

describe('ajustes guardados', () => {
  it('parseTransportMode: valores válidos o auto', () => {
    expect(parseTransportMode('wifi')).toBe('wifi');
    expect(parseTransportMode('bluetooth')).toBe('bluetooth');
    expect(parseTransportMode('usb')).toBe('usb');
    expect(parseTransportMode('auto')).toBe('auto');
    expect(parseTransportMode('otro')).toBe('auto');
    expect(parseTransportMode(undefined)).toBe('auto');
    expect(parseTransportMode(3)).toBe('auto');
  });

  it('parseBtAddress: mayúsculas con dos puntos o null', () => {
    expect(parseBtAddress(BT)).toBe(BT);
    expect(parseBtAddress('aa:bb:cc:dd:ee:ff')).toBeNull();
    expect(parseBtAddress('AA:BB:CC:DD:EE')).toBeNull();
    expect(parseBtAddress('')).toBeNull();
    expect(parseBtAddress(null)).toBeNull();
    expect(parseBtAddress(12)).toBeNull();
  });
});

describe('modeChangeAction (cambio de modo con transferencias, R2)', () => {
  it('sin sesión o con un medio que el modo admite: solo se despierta el bucle', () => {
    expect(modeChangeAction('usb', null, false)).toBe('wake');
    expect(modeChangeAction('usb', null, true)).toBe('wake');
    expect(modeChangeAction('auto', 'bluetooth', true)).toBe('wake');
    expect(modeChangeAction('wifi', 'wifi', true)).toBe('wake');
  });

  it('sesión por un medio no admitido y libre: se reinicia', () => {
    expect(modeChangeAction('bluetooth', 'wifi', false)).toBe('restart');
    expect(modeChangeAction('wifi', 'usb', false)).toBe('restart');
  });

  it('sesión por un medio no admitido con transferencias: se aplaza, no se corta', () => {
    expect(modeChangeAction('bluetooth', 'wifi', true)).toBe('defer');
    expect(modeChangeAction('usb', 'bluetooth', true)).toBe('defer');
  });

  it('al terminar lo pendiente, la misma decisión pasa de aplazar a reiniciar', () => {
    expect(modeChangeAction('usb', 'wifi', true)).toBe('defer');
    expect(modeChangeAction('usb', 'wifi', false)).toBe('restart');
  });

  it('volver a un modo que admite la sesión cancela el cambio aplazado', () => {
    expect(modeChangeAction('wifi', 'wifi', true)).toBe('wake');
    expect(modeChangeAction('auto', 'wifi', true)).toBe('wake');
  });
});

describe('modeChangePending', () => {
  it('solo si hay sesión por un medio que el modo no admite', () => {
    expect(modeChangePending('usb', 'wifi')).toBe(true);
    expect(modeChangePending('usb', 'usb')).toBe(false);
    expect(modeChangePending('auto', 'bluetooth')).toBe(false);
    expect(modeChangePending('bluetooth', null)).toBe(false);
  });
});
