import { describe, expect, it } from 'vitest';

import {
  classifySendError,
  createPauseCheck,
  localSendOutcome,
  NO_CONNECTION_MESSAGE,
  reconnectDelayMs,
  sendFailureMessage,
  STABLE_SESSION_MS,
} from '../src/lib/connectionPolicy';

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

describe('sendFile: sin sesión o rechazado', () => {
  it('RangeError es un rechazo; el resto, falta de sesión', () => {
    expect(classifySendError(new RangeError('Tamaño de archivo inválido'))).toBe('rejected');
    expect(classifySendError(new Error('La sesión no está lista'))).toBe('no_session');
    expect(classifySendError('x')).toBe('no_session');
  });

  it('«sin conexión» solo si no había sesión; con rechazo o éxito no se pisa el error', () => {
    expect(sendFailureMessage({ ok: false, reason: 'no_session' })).toBe(NO_CONNECTION_MESSAGE);
    expect(sendFailureMessage({ ok: false, reason: 'rejected' })).toBeNull();
    expect(sendFailureMessage({ ok: true, id: 'x' })).toBeNull();
  });
});

describe('createPauseCheck', () => {
  function harness(initial: { appState: string; pickerOpen: boolean }) {
    const env = { ...initial, now: 0, timer: null as null | { at: number; fn: () => void }, paused: 0 };
    const check = createPauseCheck({
      delayMs: 1000,
      setTimer: (fn, ms) => (env.timer = { at: env.now + ms, fn }),
      clearTimer: (h) => {
        if (env.timer === h) env.timer = null;
      },
      appState: () => env.appState,
      pickerOpen: () => env.pickerOpen,
      pause: () => (env.paused += 1),
    });
    const advance = (ms: number) => {
      env.now += ms;
      if (env.timer && env.timer.at <= env.now) {
        const { fn } = env.timer;
        env.timer = null;
        fn();
      }
    };
    return { env, check, advance };
  }

  it('no pausa al instante: espera el margen', () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.advance(999);
    expect(h.env.paused).toBe(0);
    h.advance(1);
    expect(h.env.paused).toBe(1);
  });

  it('no pausa si la app volvió a primer plano en ese margen', () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.appState = 'active';
    h.advance(1000);
    expect(h.env.paused).toBe(0);
  });

  it('cancel() anula la comprobación pendiente', () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.check.cancel();
    expect(h.env.timer).toBeNull();
    h.advance(5000);
    expect(h.env.paused).toBe(0);
  });

  it('no pausa si se abrió otro selector', () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.pickerOpen = true;
    h.advance(1000);
    expect(h.env.paused).toBe(0);
  });

  it('una nueva comprobación sustituye a la anterior', () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.advance(600);
    h.check.schedule();
    h.advance(600);
    expect(h.env.paused).toBe(0);
    h.advance(400);
    expect(h.env.paused).toBe(1);
  });
});
