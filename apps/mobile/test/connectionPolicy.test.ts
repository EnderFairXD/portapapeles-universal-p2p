import { describe, expect, it, test } from 'vitest';

import type { TransferUpdate } from '@clipsync/protocol';

import {
  backgroundDecision,
  classifySendError,
  closeOutcome,
  createPauseCheck,
  hasPendingWork,
  localSendOutcome,
  MAX_HANDSHAKE_FAILURES,
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
  // `appState` es lo que cree JS (AppState.currentState); `native`, lo que dice Android al
  // preguntarle; `nativeFails`, que la consulta nativa falle.
  function harness(initial: { appState: string; pickerOpen: boolean; native?: string }) {
    const env = {
      appState: initial.appState,
      pickerOpen: initial.pickerOpen,
      native: initial.native ?? initial.appState,
      nativeFails: false,
      now: 0,
      timer: null as null | { at: number; fn: () => void },
      queries: 0,
      paused: 0,
    };
    const answers: (() => void)[] = [];
    const check = createPauseCheck({
      delayMs: 1000,
      setTimer: (fn, ms) => (env.timer = { at: env.now + ms, fn }),
      clearTimer: (h) => {
        if (env.timer === h) env.timer = null;
      },
      appState: () => env.appState,
      confirmAppState: () => {
        env.queries += 1;
        return new Promise<string>((resolve, reject) => {
          // la respuesta nativa llega más tarde, cuando el test la suelta con `answer()`
          answers.push(() => (env.nativeFails ? reject(new Error('sin módulo')) : resolve(env.native)));
        });
      },
      pickerOpen: () => env.pickerOpen,
      pause: () => (env.paused += 1),
    });
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    /** Suelta las consultas nativas pendientes y deja correr sus `then`. */
    const answer = async () => {
      for (const a of answers.splice(0)) a();
      await flush();
    };
    const advance = async (ms: number) => {
      env.now += ms;
      if (env.timer && env.timer.at <= env.now) {
        const { fn } = env.timer;
        env.timer = null;
        fn();
      }
      await answer();
    };
    return { env, check, advance, answer };
  }

  it('no pausa al instante: espera el margen', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    await h.advance(999);
    expect(h.env.paused).toBe(0);
    await h.advance(1);
    expect(h.env.paused).toBe(1);
  });

  it('no pausa si la app volvió a primer plano en ese margen', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.appState = 'active';
    await h.advance(1000);
    expect(h.env.paused).toBe(0);
  });

  it('no pausa si JS aún cree que está en segundo plano pero Android ya la tiene activa', async () => {
    // el evento 'active' sigue en cola tras una llamada síncrona larga del hilo de JS
    const h = harness({ appState: 'background', pickerOpen: false, native: 'active' });
    h.check.schedule();
    await h.advance(1000);
    expect(h.env.queries).toBe(1);
    expect(h.env.paused).toBe(0);
  });

  it('con JS ya en primer plano ni pregunta a Android', async () => {
    const h = harness({ appState: 'active', pickerOpen: false });
    h.check.schedule();
    await h.advance(1000);
    expect(h.env.queries).toBe(0);
    expect(h.env.paused).toBe(0);
  });

  it('cancel() durante la consulta nativa anula la pausa', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.now += 1000;
    h.env.timer?.fn();
    expect(h.env.queries).toBe(1);
    h.check.cancel(); // llegó el evento 'active'
    await h.answer();
    expect(h.env.paused).toBe(0);
  });

  it('no pausa si se abrió otro selector mientras se consultaba', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.now += 1000;
    h.env.timer?.fn();
    h.env.pickerOpen = true;
    await h.answer();
    expect(h.env.paused).toBe(0);
  });

  it('si la consulta nativa falla, decide con lo que cree JS en ese momento', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.env.nativeFails = true;
    h.check.schedule();
    await h.advance(1000);
    expect(h.env.paused).toBe(1);

    const g = harness({ appState: 'background', pickerOpen: false });
    g.env.nativeFails = true;
    g.check.schedule();
    g.env.now += 1000;
    g.env.timer?.fn();
    g.env.appState = 'active';
    await g.answer();
    expect(g.env.paused).toBe(0);
  });

  it('cancel() anula la comprobación pendiente', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.check.cancel();
    expect(h.env.timer).toBeNull();
    await h.advance(5000);
    expect(h.env.paused).toBe(0);
  });

  it('no pausa si se abrió otro selector', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.pickerOpen = true;
    await h.advance(1000);
    expect(h.env.paused).toBe(0);
  });

  it('una nueva comprobación sustituye a la anterior', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    await h.advance(600);
    h.check.schedule();
    await h.advance(600);
    expect(h.env.paused).toBe(0);
    await h.advance(400);
    expect(h.env.paused).toBe(1);
  });

  it('una nueva comprobación anula la consulta nativa de la anterior', async () => {
    const h = harness({ appState: 'background', pickerOpen: false });
    h.check.schedule();
    h.env.now += 1000;
    h.env.timer?.fn();
    h.check.schedule(); // otro selector se cerró: su margen empieza de nuevo
    await h.answer();
    expect(h.env.paused).toBe(0);
    await h.advance(1000);
    expect(h.env.paused).toBe(1);
  });
});

describe('backgroundDecision (I1)', () => {
  const base = { appState: 'background', pickerOpen: false, busy: false };

  it('en segundo plano sin nada pendiente: pausa', () => {
    expect(backgroundDecision(base)).toBe('pause');
  });

  it('con transferencias o un compartir pendiente: solo para el vigilante del portapapeles', () => {
    expect(backgroundDecision({ ...base, busy: true })).toBe('watcher_only');
  });

  it('con un selector abierto no hace nada (lo decide la comprobación tras el selector)', () => {
    expect(backgroundDecision({ ...base, pickerOpen: true })).toBe('none');
    expect(backgroundDecision({ ...base, pickerOpen: true, busy: true })).toBe('none');
  });

  it('en primer plano no hace nada: al terminar lo pendiente con la app activa no se pausa', () => {
    expect(backgroundDecision({ ...base, appState: 'active' })).toBe('none');
    expect(backgroundDecision({ ...base, appState: 'inactive' })).toBe('none');
  });
});

describe('hasPendingWork', () => {
  const t = (state: TransferUpdate['state']): TransferUpdate => ({
    transferId: state,
    direction: 'in',
    name: 'a',
    size: 1,
    bytes: 0,
    state,
  });

  it('cuenta las transferencias en cola o activas y el compartir pendiente', () => {
    expect(hasPendingWork([], false)).toBe(false);
    expect(hasPendingWork([t('failed'), t('cancelled'), t('done')], false)).toBe(false);
    expect(hasPendingWork([t('queued')], false)).toBe(true);
    expect(hasPendingWork([t('failed'), t('active')], false)).toBe(true);
    expect(hasPendingWork([], true)).toBe(true);
  });
});

// --- cierre de la sesión: reintentar o desemparejar (D8) ---

describe('closeOutcome', () => {
  const notPairedToken = 'El QR no es válido. Genera uno nuevo en el PC.';
  const notPairedPlain = 'Este PC no te reconoce. Vuelve a emparejar.';
  const expired = 'QR caducado. Genera uno nuevo en el PC.';
  const unverified = 'No se pudo verificar el PC. Vuelve a emparejar.';

  test('MAX_HANDSHAKE_FAILURES es 3', () => {
    expect(MAX_HANDSHAKE_FAILURES).toBe(3);
  });

  test.each([
    ['not_paired', { tokenSent: true, handshakeFailures: 0, transport: 'wifi' }, { kind: 'unpair', message: notPairedToken }],
    ['not_paired', { tokenSent: false, handshakeFailures: 0, transport: 'wifi' }, { kind: 'unpair', message: notPairedPlain }],
    ['not_paired', { tokenSent: false, handshakeFailures: 0, transport: 'usb' }, { kind: 'unpair', message: notPairedPlain }],
    ['pairing_expired', { tokenSent: true, handshakeFailures: 1, transport: 'wifi' }, { kind: 'unpair', message: expired }],
    ['pairing_expired', { tokenSent: false, handshakeFailures: 0, transport: 'usb' }, { kind: 'unpair', message: expired }],
    ['handshake_failed', { tokenSent: false, handshakeFailures: 2, transport: 'wifi' }, { kind: 'unpair', message: unverified }],
    ['handshake_failed', { tokenSent: true, handshakeFailures: 5, transport: 'wifi' }, { kind: 'unpair', message: unverified }],
    ['handshake_failed', { tokenSent: false, handshakeFailures: 0, transport: 'wifi' }, { kind: 'retry', handshakeFailures: 1 }],
    ['handshake_failed', { tokenSent: true, handshakeFailures: 1, transport: 'wifi' }, { kind: 'retry', handshakeFailures: 2 }],
    // por USB (adb reverse) el PC puede no estar: no cuenta y nunca desempareja
    ['handshake_failed', { tokenSent: false, handshakeFailures: 2, transport: 'usb' }, { kind: 'retry', handshakeFailures: 2 }],
    ['handshake_failed', { tokenSent: true, handshakeFailures: 0, transport: 'usb' }, { kind: 'retry', handshakeFailures: 0 }],
    ['link_closed', { tokenSent: false, handshakeFailures: 2, transport: 'wifi' }, { kind: 'retry', handshakeFailures: 2 }],
    ['heartbeat_timeout', { tokenSent: true, handshakeFailures: 0, transport: 'usb' }, { kind: 'retry', handshakeFailures: 0 }],
    ['protocol_error', { tokenSent: false, handshakeFailures: 1, transport: 'wifi' }, { kind: 'retry', handshakeFailures: 1 }],
  ] as const)('closeOutcome(%s, %j)', (reason, ctx, expected) => {
    expect(closeOutcome(reason, ctx)).toEqual(expected);
  });
});
