import { describe, expect, it } from 'vitest';

import { localSendOutcome, reconnectDelayMs, STABLE_SESSION_MS } from '../src/lib/connectionPolicy';

describe('reconnectDelayMs', () => {
  it('reintenta al instante si la sesión aguantó lo suficiente', () => {
    expect(reconnectDelayMs(true, STABLE_SESSION_MS, 5000)).toBe(0);
    expect(reconnectDelayMs(true, 60_000, 5000)).toBe(0);
  });

  it('espera el intervalo normal si cayó a los pocos segundos de estar lista', () => {
    expect(reconnectDelayMs(true, STABLE_SESSION_MS - 1, 5000)).toBe(5000);
    expect(reconnectDelayMs(true, 0, 5000)).toBe(5000);
  });

  it('espera el intervalo si la sesión nunca llegó a estar lista', () => {
    expect(reconnectDelayMs(false, 0, 5000)).toBe(5000);
    expect(reconnectDelayMs(false, 99_999, 5000)).toBe(5000);
  });
});

describe('localSendOutcome', () => {
  it('registra el envío si la sesión sigue abierta', () => {
    expect(localSendOutcome('send', true)).toBe('record');
  });

  it('no registra nada si la sesión se cerró durante el envío', () => {
    expect(localSendOutcome('send', false)).toBe('none');
  });

  it('avisa del texto demasiado grande esté o no abierta la sesión', () => {
    expect(localSendOutcome('too_large', true)).toBe('too_large');
    expect(localSendOutcome('too_large', false)).toBe('too_large');
  });

  it('ignora duplicados y demás decisiones', () => {
    expect(localSendOutcome('duplicate', true)).toBe('none');
    expect(localSendOutcome('empty', false)).toBe('none');
  });
});
