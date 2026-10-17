// Ejecutar con: pnpm --filter @clipsync/protocol bench
// vitest.config.ts solo incluye test/**/*.test.ts, así que `pnpm test` no recoge este archivo.
// (Vitest 5: los benchmarks se registran dentro de un test con el fixture `bench`.)
import { expect, test } from 'vitest';
import { NoiseIK, generateKeyPair } from '../src/index';

const sInit = generateKeyPair();
const sResp = generateKeyPair();
const hola = new Uint8Array(100);

/** Trama de datos de archivo: 17 bytes de cabecera + 49 152 de datos. */
const TRAMA_BYTES = 49169;

function handshake() {
  const init = NoiseIK.initiator({ s: sInit, rs: sResp.publicKey });
  const resp = NoiseIK.responder({ s: sResp });
  resp.readMessage(init.writeMessage(hola));
  init.readMessage(resp.writeMessage(hola));
  return { a: init.split(), b: resp.split() };
}

test('Noise IK: handshake completo (iniciador y respondedor)', async ({ bench }) => {
  const r = await bench('handshake IK', () => {
    handshake();
  }).run();
  expect(r.throughput.mean).toBeGreaterThan(0);
});

test(`Noise IK: encrypt + decrypt de ${TRAMA_BYTES} bytes`, async ({ bench }) => {
  const { a, b } = handshake();
  const trama = new Uint8Array(TRAMA_BYTES).fill(0xab);
  const r = await bench('encrypt + decrypt', () => {
    b.recv.decrypt(a.send.encrypt(trama));
  }).run();
  const mbPorSegundo = (r.throughput.mean * TRAMA_BYTES) / 1e6;
  console.log(`encrypt + decrypt: ${mbPorSegundo.toFixed(1)} MB/s (cifrar y descifrar cada trama)`);
  expect(r.throughput.mean).toBeGreaterThan(0);
});
