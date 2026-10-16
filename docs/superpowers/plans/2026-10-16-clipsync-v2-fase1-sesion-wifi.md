# ClipSync v2 — Fase 1: sesión bidireccional por WiFi — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el móvil Android y el PC (Linux/Windows) mantengan una conexión permanente por WiFi
(y por USB con el `adb` del sistema) que sincroniza el texto del portapapeles en ambos sentidos y
envía archivos a mano en ambos sentidos, con la interfaz nueva de las dos apps.

**Architecture:** El protocolo v2 (tramas con longitud `u16`, byte de tipo, JSON de control
fragmentable y datos de archivo binarios) se implementa en TypeScript en `packages/protocol`
(lo usa el móvil y se prueba en Node) y se replica en Rust en `apps/desktop/src-tauri`. En Rust,
un `Hub` sin dependencias de Tauri gestiona sesiones y archivos; la capa Tauri le añade
portapapeles e interfaz. Una prueba extremo a extremo enfrenta el `Hub` (ejemplo `headless`) al
cliente TypeScript.

**Tech Stack:** TypeScript 6, vitest 5, `@noble/hashes`; Rust 2021, tokio, `tokio-util` (codec),
serde, arboard, mdns-sd, Tauri 2 (+ `tauri-plugin-dialog`); Expo SDK 57, `react-native-tcp-socket`,
`react-native-zeroconf`, `expo-clipboard`, `expo-file-system` (API nueva), `expo-document-picker`,
`expo-device`, `expo-share-intent`.

**Spec:** `docs/superpowers/specs/2026-10-16-clipsync-v2-design.md` (fase 1 de §12). Las fases
2–5 tendrán su propio plan.

## Global Constraints

- Commits con la identidad ya configurada en el repo (Javier Cortés Vidal). **Nunca** añadir
  líneas `Co-Authored-By` ni «Generated with Claude Code».
- Solo Android. Dependencias de Expo siempre con `npx expo install <paquete>` (versiones de SDK 57).
- Protocolo `v = 2`; puerto TCP `52847`; mDNS `_clipsync._tcp.local.` (forma corta para
  zeroconf: nombre `clipsync`, protocolo `tcp`, dominio `local.`), TXT `v=2`.
- Trama: `u16` big-endian + datos, máximo 65 535 bytes de datos.
- Tipos de trama: `0x01` control (último fragmento), `0x03` control (continúa), `0x02` datos de archivo
  (`transferId` 16 bytes + ≤ 48 KiB = 49 152 bytes).
- Control reensamblado máximo 2 MiB; texto de portapapeles máximo 1 MiB (1 048 576 bytes UTF-8).
- Archivos: `file_ack` cada 1 MiB recibido; como mucho 2 MiB sin confirmar; un archivo a la vez por
  sesión, el resto en cola. `transferId` = 32 caracteres hex en JSON, 16 bytes en las tramas `0x02`.
- Latido: `ping` cada 10 s; sin tráfico entrante en 30 s → sesión caída.
- Móvil: reintento cada 5 s en primer plano; 2 s de espera por intento de conexión.
- PC: sondeo del portapapeles cada 500 ms. Historial: 50 elementos.
- Archivos recibidos: PC en Descargas (`dirs::download_dir()`), móvil en la carpeta elegida por SAF.
- Toda la interfaz en español.
- Comandos de prueba:
  - TS: `pnpm --filter @clipsync/protocol test`
  - Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - e2e: `pnpm --filter @clipsync/protocol test:e2e`

## Review Focus

1. **Nombres de archivo hostiles** (`../../x`, `a/b.txt`, `C:\x`, `CON`, vacío, 300 caracteres):
   se sanean y siempre se guardan dentro de la carpeta de destino (Tarea 7, Tarea 12).
2. **Colisión de nombres**: un archivo recibido nunca sobrescribe otro; se guarda como «nombre (1).ext»
   (Tarea 7).
3. **Conexión cortada a mitad de un archivo**: el parcial se borra, la transferencia queda `failed`
   en ambos lados y nada se queda colgado (Tarea 5, Tarea 8).
4. **Rebotes del portapapeles**: un texto recibido y escrito no se reenvía, tampoco con dos móviles
   conectados (Tarea 3, Tarea 8).
5. **Archivo vacío y archivo de tamaño múltiplo exacto de 48 KiB**: terminan con hash correcto
   (Tarea 5, Tarea 9).

---

## Estructura de archivos

```
packages/protocol/
  package.json              + scripts test/test:e2e, deps @noble/hashes, vitest
  vitest.config.ts          tests unitarios (excluye e2e/)
  vitest.e2e.config.ts      solo e2e/
  src/constants.ts          constantes v2 (reemplaza las de v1)
  src/framing.ts            encodeFrame, FrameDecoder
  src/messages.ts           tipos de control, encode/decode, ProtocolError
  src/hash.ts               sha256Hex, createSha256
  src/clipSync.ts           ClipboardSync (anti-rebote)
  src/session.ts            Session (hello, latido, clip, archivos)
  src/index.ts              re-exporta todo (se borran types.ts y builders v1)
  schema/sync-message.schema.json   reescrito para v2
  test/*.test.ts
  test-vectors/messages.json        vectores compartidos TS ↔ Rust
  e2e/headless.e2e.test.ts
apps/desktop/src-tauri/src/
  protocol/mod.rs           constantes
  protocol/messages.rs      ControlMessage, MessageDecoder, encode_*
  core/mod.rs
  core/clip_sync.rs         ClipboardSync (mismo comportamiento que TS)
  core/files.rs             sanitize_file_name, unique_path, FileReceiver
  core/session.rs           run_session
  core/hub.rs               Hub, HubEvent, TransferUpdate
  app/mod.rs                estado Tauri, comandos, historial
  app/clipboard.rs          vigilante de arboard
  discovery.rs              anuncio _clipsync._tcp (modificado)
  usb.rs                    solo puerto 52847 (modificado)
  lib.rs                    arranque (modificado)
  examples/headless.rs      servidor sin interfaz para e2e
  (se borran protocol.rs, transport.rs, bluetooth.rs)
apps/desktop/
  index.html, src/main.ts, src/styles.css   interfaz nueva (se borran assets de plantilla)
apps/mobile/
  (se borran ios/, src/lib/guestServer.ts, src/lib/bleTransport.ts, src/lib/lanTransport.ts)
  src/lib/tcpLink.ts        Link sobre react-native-tcp-socket
  src/lib/discovery.ts      discoverPc() por mDNS
  src/lib/settings.ts       ajustes persistentes (JSON en Paths.document)
  src/lib/files.ts          FileSource desde URI, abrir sumidero SAF
  src/lib/clipboardWatcher.ts
  src/lib/connection.ts     ConnectionManager (estado observable)
  src/lib/useConnection.ts  hook React
  src/components/StatusCard.tsx, TransferList.tsx, HistoryList.tsx
  src/app/_layout.tsx, src/app/index.tsx, src/app/settings.tsx
docs/testing-checklist.md   comprobación manual por medio
```

---

### Task 1: Base del paquete de protocolo: tests, constantes y framing

**Files:**
- Modify: `packages/protocol/package.json`, `packages/protocol/src/constants.ts`, `packages/protocol/src/index.ts`
- Delete: `packages/protocol/src/types.ts`
- Create: `packages/protocol/vitest.config.ts`, `packages/protocol/src/framing.ts`, `packages/protocol/test/framing.test.ts`

**Interfaces:**
- Produces:
  - `constants.ts`: `PROTOCOL_VERSION = 2`, `DEFAULT_TCP_PORT = 52847`, `MDNS_SERVICE_NAME = 'clipsync'`,
    `MDNS_SERVICE_PROTOCOL = 'tcp'`, `MDNS_SERVICE_DOMAIN = 'local.'`, `MDNS_FULL_SERVICE_TYPE`,
    `MAX_FRAME_BYTES = 65535`, `FILE_CHUNK_BYTES = 49152`, `FILE_ACK_EVERY_BYTES = 1048576`,
    `FILE_WINDOW_BYTES = 2097152`, `MAX_CLIP_BYTES = 1048576`, `MAX_CONTROL_BYTES = 2097152`,
    `HEARTBEAT_INTERVAL_MS = 10000`, `HEARTBEAT_TIMEOUT_MS = 30000`, `RECONNECT_INTERVAL_MS = 5000`,
    `CONNECT_TIMEOUT_MS = 2000`, `MAX_HISTORY = 50`. Se eliminan `GUEST_MODE_PORT` y `BLE_SERVICE_UUID`.
  - `framing.ts`: `encodeFrame(payload: Uint8Array): Uint8Array` (lanza `RangeError` si > 65 535);
    `class FrameDecoder { push(chunk: Uint8Array): Uint8Array[] }`.

- [ ] **Step 1: Preparar el paquete**

`package.json`: `"type": "module"`, scripts `"test": "vitest run -c vitest.config.ts"` y
`"test:e2e": "vitest run -c vitest.e2e.config.ts"`, dependencia `@noble/hashes`, devDependencies
`vitest` y `@types/node`. `vitest.config.ts` incluye `test/**/*.test.ts`. Borrar `types.ts` y los
builders/validador v1 de `index.ts` (quedará `export *` de cada módulo nuevo). Ejecutar `pnpm install`.

- [ ] **Step 2: Escribir los tests de framing**

```ts
test('encodeFrame antepone la longitud u16 big-endian', () => {
  expect(encodeFrame(Uint8Array.of(0xaa, 0xbb))).toEqual(Uint8Array.of(0x00, 0x02, 0xaa, 0xbb));
});
test('encodeFrame acepta 65535 bytes y rechaza 65536', () => {
  expect(encodeFrame(new Uint8Array(65535)).length).toBe(65537);
  expect(() => encodeFrame(new Uint8Array(65536))).toThrow(RangeError);
});
test('FrameDecoder reensambla tramas partidas en trozos arbitrarios', () => {
  const bytes = concat(encodeFrame(Uint8Array.of(1)), encodeFrame(new Uint8Array(0)), encodeFrame(Uint8Array.of(2, 3)));
  const d = new FrameDecoder();
  const out = [...bytes].flatMap((b) => d.push(Uint8Array.of(b)));   // byte a byte
  expect(out).toEqual([Uint8Array.of(1), new Uint8Array(0), Uint8Array.of(2, 3)]);
});
test('FrameDecoder devuelve varias tramas de un solo trozo', () => { /* las 3 de arriba en un push → 3 resultados */ });
```

- [ ] **Step 3: Verificar que fallan** — `pnpm --filter @clipsync/protocol test` → FAIL (módulo `framing` no existe).
- [ ] **Step 4: Implementar `constants.ts` y `framing.ts`** con las firmas de arriba.
- [ ] **Step 5: Verificar** — mismo comando → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol): base v2 con constantes y framing"`

---

### Task 2: Mensajes de control y datos, con vectores compartidos

**Files:**
- Create: `packages/protocol/src/messages.ts`, `packages/protocol/src/hash.ts`, `packages/protocol/test/messages.test.ts`, `packages/protocol/test-vectors/messages.json`
- Modify: `packages/protocol/schema/sync-message.schema.json` (reescrito para los mensajes v2)

**Interfaces:**
- Consumes: constantes de la Tarea 1.
- Produces:
  ```ts
  type HelloMsg = { kind: 'hello'; v: 2; deviceId: string; deviceName: string; willSendClip?: boolean };
  type ClipMsg = { kind: 'clip'; id: string; text: string; hash: string };
  type FileStartMsg = { kind: 'file_start'; transferId: string; name: string; size: number; mime: string };
  type FileAckMsg = { kind: 'file_ack'; transferId: string; received: number };
  type FileEndMsg = { kind: 'file_end'; transferId: string; sha256: string };
  type FileResultMsg = { kind: 'file_result'; transferId: string; ok: boolean; error?: string };
  type FileCancelMsg = { kind: 'file_cancel'; transferId: string; reason: string };
  type ControlMessage = HelloMsg | ClipMsg | FileStartMsg | FileAckMsg | FileEndMsg | FileResultMsg
    | FileCancelMsg | { kind: 'ping' } | { kind: 'pong' };
  type DecodedMessage = { type: 'control'; msg: ControlMessage } | { type: 'data'; transferId: string; bytes: Uint8Array };
  class ProtocolError extends Error {}
  function encodeControl(msg: ControlMessage): Uint8Array[];        // payloads de trama (sin longitud)
  function encodeFileData(transferId: string, bytes: Uint8Array): Uint8Array;
  class MessageDecoder { push(payload: Uint8Array): DecodedMessage | null }  // null = fragmento pendiente
  function sha256Hex(data: string | Uint8Array): string;            // hex minúscula, string en UTF-8
  function createSha256(): { update(b: Uint8Array): void; digestHex(): string };
  ```
  `transferId` válido = `/^[0-9a-f]{32}$/`. Los hashes (`hash`, `sha256`) = 64 hex minúscula.

- [ ] **Step 1: Escribir los vectores** en `test-vectors/messages.json`: lista de
  `{ "name", "framesHex": [...], "expect": <ControlMessage | {"data": {"transferId", "bytesHex"}} | {"error": true}> }`,
  con al menos un caso por `kind`, un `0x02`, un JSON inválido, un `kind` desconocido, un `transferId`
  de 31 hex, un byte de tipo `0x07` y un `clip` fragmentado en 2 tramas (`0x03` + `0x01`). Los usará
  también Rust (Tarea 6).

- [ ] **Step 2: Escribir los tests**

```ts
test.each(vectors)('vector $name', ({ framesHex, expect: exp }) => {
  const d = new MessageDecoder();
  const run = () => framesHex.map(hexToBytes).map((f) => d.push(f)).at(-1);
  if ('error' in exp) expect(run).toThrow(ProtocolError); else expect(normalize(run())).toEqual(exp);
});
test('ida y vuelta de cada kind', () => { /* encodeControl → MessageDecoder → mismo objeto */ });
test('un clip de 1 MiB de emojis se fragmenta en tramas ≤ 65535 y se reensambla igual', () => {
  const text = '😀'.repeat(262144);            // 1 MiB en UTF-8
  const frames = encodeControl({ kind: 'clip', id: 'a', text, hash: sha256Hex(text) });
  expect(frames.length).toBeGreaterThan(16);
  expect(frames.every((f) => f.length <= 65535)).toBe(true);
  expect(frames.slice(0, -1).every((f) => f[0] === 0x03) && frames.at(-1)![0] === 0x01).toBe(true);
  // reensamblar → msg.text === text
});
test('reensamblado de control > 2 MiB lanza ProtocolError', () => { /* 33 tramas 0x03 de 65534 bytes */ });
test('encodeFileData rechaza más de 49152 bytes', () => { /* RangeError */ });
test('sha256Hex de "abc"', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
```

- [ ] **Step 3: Verificar que fallan** — `pnpm --filter @clipsync/protocol test` → FAIL.
- [ ] **Step 4: Implementar `messages.ts` y `hash.ts`**: el JSON se codifica a bytes UTF-8 y se
  trocea en bytes (no en caracteres), con payloads de hasta 65 534 bytes + 1 byte de tipo; la validación
  comprueba la forma de cada `kind` (tipos de campos, `v === 2`, formato de `transferId` y de los hashes)
  y lanza `ProtocolError` en cualquier fallo.
- [ ] **Step 5: Verificar** → PASS. Reescribir el JSON Schema para que describa los mismos mensajes.
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol): mensajes v2 con fragmentación y vectores compartidos"`

---

### Task 3: ClipboardSync (anti-rebote)

**Files:**
- Create: `packages/protocol/src/clipSync.ts`, `packages/protocol/test/clipSync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ClipDecision = 'send' | 'duplicate' | 'empty' | 'too_large';
  class ClipboardSync {
    constructor(lastSyncedHash?: string | null);
    get lastSyncedHash(): string | null;
    check(text: string): ClipDecision;   // empty: '' o solo espacios; too_large: > MAX_CLIP_BYTES en UTF-8
    markSynced(text: string): void;      // tras enviar o tras recibir y escribir
  }
  ```

- [ ] **Step 1: Escribir los tests**

```ts
test('texto nuevo → send; tras markSynced → duplicate', () => {
  const s = new ClipboardSync(); expect(s.check('hola')).toBe('send');
  s.markSynced('hola'); expect(s.check('hola')).toBe('duplicate'); expect(s.check('adiós')).toBe('send');
});
test('recibido y escrito no rebota', () => { const s = new ClipboardSync(); s.markSynced('del PC'); expect(s.check('del PC')).toBe('duplicate'); });
test('vacío y solo espacios → empty', () => { expect(new ClipboardSync().check('  \n')).toBe('empty'); });
test('1 MiB exacto → send; 1 MiB + 1 byte → too_large', () => { /* 'a'.repeat(1048576) y +1 */ });
test('acepta un hash inicial', () => { expect(new ClipboardSync(sha256Hex('x')).check('x')).toBe('duplicate'); });
```

- [ ] **Step 2: Verificar que fallan** → FAIL.
- [ ] **Step 3: Implementar `ClipboardSync`** sobre `sha256Hex`.
- [ ] **Step 4: Verificar** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(protocol): ClipboardSync para evitar rebotes"`

---

### Task 4: Session — saludo, latido y portapapeles

**Files:**
- Create: `packages/protocol/src/session.ts`, `packages/protocol/test/session.test.ts`, `packages/protocol/test/helpers.ts`

**Interfaces:**
- Consumes: Tareas 1–3.
- Produces:
  ```ts
  interface Link { write(bytes: Uint8Array): void; close(): void;
    onData(cb: (bytes: Uint8Array) => void): void; onClose(cb: (error?: Error) => void): void }
  interface Timers { setInterval(cb: () => void, ms: number): unknown; clearInterval(h: unknown): void; now(): number }
  interface PeerInfo { deviceId: string; deviceName: string }
  interface FileMeta { name: string; size: number; mime: string }
  interface FileSource extends FileMeta { read(maxBytes: number): Promise<Uint8Array>; close(): Promise<void> }
  interface FileSink { write(bytes: Uint8Array): Promise<void>; finish(): Promise<string>; abort(): Promise<void> }
  type TransferState = 'queued' | 'active' | 'done' | 'failed' | 'cancelled';
  interface TransferUpdate { transferId: string; direction: 'in' | 'out'; name: string; size: number;
    bytes: number; state: TransferState; error?: string; location?: string }
  interface SessionOptions {
    role: 'client' | 'server';
    self: PeerInfo;
    clipSyncFor(peer: PeerInfo): ClipboardSync;
    getLocalClip(): Promise<string | null>;
    openSink(meta: FileMeta): Promise<FileSink>;
    newTransferId(): string;              // 32 hex
    timers?: Timers;                      // por defecto los globales y Date.now
  }
  type SessionEvents = {
    ready: (peer: PeerInfo) => void;
    clip: (text: string) => void;                     // ya marcado como sincronizado
    localClipSuperseded: (text: string) => void;      // regla de inicio, ver abajo
    transfer: (update: TransferUpdate) => void;
    closed: (reason: string) => void;
  };
  class Session {
    constructor(link: Link, opts: SessionOptions);
    on<E extends keyof SessionEvents>(event: E, cb: SessionEvents[E]): () => void;
    start(): Promise<void>;
    get peer(): PeerInfo | null;
    sendClip(text: string): ClipDecision;             // 'send' = enviado
    sendFile(src: FileSource): string;                // transferId (Tarea 5)
    cancelTransfer(transferId: string): void;         // Tarea 5
    close(reason?: string): void;
  }
  ```
- Regla de inicio (spec §3.5), dirigida por el `hello`:
  - El cliente calcula `willSendClip = check(getLocalClip()) === 'send'` y lo manda en su `hello`.
  - El servidor responde con su `hello` (sin `willSendClip`).
  - Si el cliente indicó `willSendClip`, envía su `clip` al recibir el `hello` del servidor. En ese
    caso, si el texto local del servidor también daba `send`, el servidor emite
    `localClipSuperseded(texto)` y no lo envía.
  - Si no, el servidor envía su `clip` cuando dé `send`.
  - Cualquier mensaje que no sea `hello` antes del saludo, un segundo `hello` o un `ProtocolError`
    cierran la sesión con un motivo legible.

- [ ] **Step 1: Escribir `helpers.ts`**: `linkPair(): [Link, Link]` (memoria, entrega asíncrona,
  cerrar uno cierra el otro), `fakeTimers()` controlables (`advance(ms)`), `memorySink()` y
  `memorySource(bytes, name)`.

- [ ] **Step 2: Escribir los tests**

```ts
test('saludo: ambos emiten ready con los datos del otro', async () => { /* client.peer.deviceName === 'PC', server.peer.deviceName === 'Pixel' */ });
test('clip del cliente llega al servidor y no rebota', async () => {
  // client.sendClip('hola') → server 'clip' con 'hola'; server.sendClip('hola') → 'duplicate'
});
test('clip del servidor llega al cliente', async () => { /* simétrico */ });
test('inicio: solo cambió el móvil → el PC recibe el texto del móvil', async () => {});
test('inicio: solo cambió el PC → el móvil recibe el texto del PC', async () => {});
test('inicio: cambiaron los dos → gana el móvil y el PC emite localClipSuperseded("pc")', async () => {
  // los dos acaban con lastSyncedHash = sha256Hex('móvil')
});
test('latido: sin tráfico 30 s → closed("heartbeat_timeout")', async () => { /* fakeTimers.advance(30_000) */ });
test('latido: un ping cada 10 s mantiene viva la sesión', async () => { /* advance(10_000) x5 con respuestas pong → sigue abierta */ });
test('mensaje antes del hello → closed("protocol_error")', async () => {});
test('enlace cerrado por el otro lado → closed("link_closed")', async () => {});
```

- [ ] **Step 3: Verificar que fallan** → FAIL.
- [ ] **Step 4: Implementar `Session`** (saludo, latido, clip, cierre) con un `FrameDecoder` y un
  `MessageDecoder` por sesión.
- [ ] **Step 5: Verificar** → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol): Session con saludo, latido y portapapeles"`

---

### Task 5: Session — transferencia de archivos

**Files:**
- Modify: `packages/protocol/src/session.ts`
- Create: `packages/protocol/test/session-files.test.ts`

**Interfaces:**
- Consumes: `Session`, `FileSource`, `FileSink`, `TransferUpdate` de la Tarea 4.
- Produces: `sendFile` y `cancelTransfer` operativos.
- Algoritmo del emisor:
  1. Envía `file_start`.
  2. Lee y envía trozos de `FILE_CHUNK_BYTES` mientras haya menos de `FILE_WINDOW_BYTES` sin
     confirmar, actualizando el hash incremental.
  3. Al llegar a EOF envía `file_end` con el `sha256`.
  4. Espera `file_result`.

  Algoritmo del receptor:
  1. Con `file_start`, llama a `openSink`.
  2. Escribe cada `0x02` y envía `file_ack` cada vez que acumula 1 MiB más.
  3. Con `file_end`, compara el hash: si coincide, `finish()` y `file_result ok`; si no,
     `abort()` y `ok:false, error:'checksum_mismatch'`.

  Las transferencias salientes van en cola FIFO. Se emite `transfer` en cada cambio de estado y,
  como mucho, una vez por cada MiB de progreso.

- [ ] **Step 1: Escribir los tests**

```ts
test.each([0, 1, 49152, 49152 * 3, 5 * 1024 * 1024 + 7])('archivo de %i bytes llega idéntico', async (n) => {
  // memorySink del servidor recibe exactamente los bytes; ambos lados emiten state 'done'; location del sink en el update 'in'
});
test('control de flujo: nunca más de 2 MiB sin confirmar', async () => {
  // link espía: cuenta bytes 0x02 enviados menos `received` del último file_ack ≤ 2 MiB en todo momento
});
test('dos archivos se envían en orden, el segundo queda queued mientras tanto', async () => {});
test('hash distinto → receptor aborta el sink y ambos lados terminan failed/checksum_mismatch', async () => {
  // source que miente en un byte tras calcular… (usar un link que corrompe un byte de la trama 0x02)
});
test('cancelar desde el emisor → file_cancel, sink abortado, ambos cancelled', async () => {});
test('enlace cerrado a mitad → sink abortado, ambos failed, closed emitido', async () => {});
test('datos 0x02 para un transferId desconocido → closed("protocol_error")', async () => {});
```

- [ ] **Step 2: Verificar que fallan** → FAIL.
- [ ] **Step 3: Implementar** emisor y receptor en `session.ts`.
- [ ] **Step 4: Verificar** — `pnpm --filter @clipsync/protocol test` → PASS (todas las tareas 1–5).
- [ ] **Step 5: Commit** — `git commit -m "feat(protocol): transferencia de archivos con control de flujo"`

---

### Task 6: Rust — limpieza y mensajes v2

**Files:**
- Delete: `apps/desktop/src-tauri/src/protocol.rs`, `transport.rs`, `bluetooth.rs`
- Create: `apps/desktop/src-tauri/src/protocol/mod.rs`, `apps/desktop/src-tauri/src/protocol/messages.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml` (quitar `btleplug`; añadir `tokio-util` con feature `codec`,
  `futures`, `thiserror`; dev: `tempfile`), `src/lib.rs` (módulos), `src/usb.rs` (`REVERSE_PORTS = [DEFAULT_TCP_PORT]`),
  `src/discovery.rs` (`_clipsync._tcp.local.`, TXT `v=2`)

**Interfaces:**
- Produces (`crate::protocol`):
  ```rust
  pub const PROTOCOL_VERSION: u32 = 2;  // y el resto de constantes de la Tarea 1 con los mismos valores
  pub fn frame_codec() -> tokio_util::codec::LengthDelimitedCodec; // u16, max 65535
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  #[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
  pub enum ControlMessage {
      Hello { v: u32, device_id: String, device_name: String,
              #[serde(skip_serializing_if = "Option::is_none", default)] will_send_clip: Option<bool> },
      Clip { id: String, text: String, hash: String },
      FileStart { transfer_id: String, name: String, size: u64, mime: String },
      FileAck { transfer_id: String, received: u64 },
      FileEnd { transfer_id: String, sha256: String },
      FileResult { transfer_id: String, ok: bool, #[serde(skip_serializing_if = "Option::is_none", default)] error: Option<String> },
      FileCancel { transfer_id: String, reason: String },
      Ping, Pong,
  }
  pub enum Decoded { Control(ControlMessage), Data { transfer_id: [u8; 16], bytes: Vec<u8> } }
  #[derive(Debug, thiserror::Error)] pub enum ProtocolError { … }
  pub fn encode_control(msg: &ControlMessage) -> Vec<Vec<u8>>;
  pub fn encode_file_data(transfer_id: &[u8; 16], bytes: &[u8]) -> Vec<u8>;
  pub struct MessageDecoder; impl MessageDecoder { pub fn new() -> Self;
      pub fn push(&mut self, payload: &[u8]) -> Result<Option<Decoded>, ProtocolError>; }
  ```
  La validación es la misma que en TS (`v == 2`, formato de `transferId` y de los hashes).

- [ ] **Step 1: Escribir los tests** en `messages.rs`: recorrer
  `include_str!("../../../../../packages/protocol/test-vectors/messages.json")` y exigir el mismo
  resultado que TS (mensaje igual o error); ida y vuelta de cada variante; un `Clip` de 1 MiB de emojis
  se fragmenta en tramas ≤ 65 535 y se reensambla igual; más de 2 MiB reensamblados → error.
- [ ] **Step 2: Verificar que fallan** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml protocol` → FAIL.
- [ ] **Step 3: Implementar** `protocol/` y aplicar las bajas y cambios de la lista de archivos
  (el `lib.rs` deja de arrancar el servidor v1; se cablea de nuevo en la Tarea 10).
- [ ] **Step 4: Verificar** → PASS, y `cargo build` sin warnings de código muerto de BLE.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): protocolo v2 en Rust y retirada de BLE y servidor v1"`

---

### Task 7: Rust — ClipboardSync y archivos en disco

**Files:**
- Create: `apps/desktop/src-tauri/src/core/mod.rs`, `core/clip_sync.rs`, `core/files.rs`

**Interfaces:**
- Produces:
  ```rust
  pub enum ClipDecision { Send, Duplicate, Empty, TooLarge }
  pub struct ClipboardSync { … } impl ClipboardSync {
      pub fn new(last: Option<String>) -> Self; pub fn check(&self, text: &str) -> ClipDecision;
      pub fn mark_synced(&mut self, text: &str); pub fn last_synced_hash(&self) -> Option<&str>; }
  pub fn sanitize_file_name(name: &str) -> String;
  pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf;
  pub struct FileReceiver { … } impl FileReceiver {
      pub fn create(dir: &Path, name: &str) -> std::io::Result<Self>;   // escribe en "<final>.part"
      pub fn write(&mut self, bytes: &[u8]) -> std::io::Result<()>;     // actualiza SHA-256
      pub fn received(&self) -> u64;
      pub fn finish(self, expected_sha256: &str) -> Result<PathBuf, String>; // renombra si coincide; si no, borra y Err("checksum_mismatch")
      pub fn abort(self); }                                             // borra el .part
  ```
  Saneamiento: quedarse con el último componente tras `/` y `\`; quitar `<>:"|?*` y caracteres de
  control; recortar puntos y espacios finales; prefijar `_` a los nombres reservados de Windows
  (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, también con extensión); limitar a 200 bytes
  UTF-8 conservando la extensión. Si queda vacío, `archivo`.

- [ ] **Step 1: Escribir los tests** (con `tempfile::tempdir()`, nunca la carpeta Descargas real)

```rust
#[test] fn clip_sync_mismo_comportamiento_que_ts() { /* los 5 casos de la Tarea 3 */ }
#[test] fn sanea_rutas_y_nombres_reservados() {
    assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
    assert_eq!(sanitize_file_name("C:\\x\\a.txt"), "a.txt");
    assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
    assert_eq!(sanitize_file_name(""), "archivo");
    assert_eq!(sanitize_file_name("a?b*.txt"), "ab.txt");
    assert!(sanitize_file_name(&format!("{}.pdf", "x".repeat(300))).ends_with(".pdf"));
}
#[test] fn unique_path_no_sobrescribe() { /* foto.jpg existe → "foto (1).jpg"; ambos existen → "foto (2).jpg"; sin extensión "notas (1)" */ }
#[test] fn receptor_ok_renombra_y_no_deja_part() {}
#[test] fn receptor_hash_malo_borra_todo() {}
#[test] fn receptor_abort_borra_part() {}
#[test] fn ruta_final_siempre_dentro_del_directorio() { /* para cada nombre hostil, path.parent() == dir */ }
```

- [ ] **Step 2: Verificar que fallan** — `cargo test … core::` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): ClipboardSync y recepción segura de archivos"`

---

### Task 8: Rust — sesión y Hub

**Files:**
- Create: `apps/desktop/src-tauri/src/core/session.rs`, `apps/desktop/src-tauri/src/core/hub.rs`

**Interfaces:**
- Consumes: Tareas 6–7.
- Produces:
  ```rust
  #[derive(Clone, Copy, Debug, Serialize, PartialEq)] #[serde(rename_all = "lowercase")]
  pub enum Transport { Wifi, Usb }   // Usb si la conexión TCP viene de 127.0.0.1/::1 (adb reverse)
  #[derive(Clone, Debug, Serialize)] #[serde(rename_all = "camelCase")]
  pub struct TransferUpdate { pub transfer_id: String, pub direction: Direction /* "in"|"out" */, pub name: String,
      pub size: u64, pub bytes: u64, pub state: TransferState /* queued|active|done|failed|cancelled */,
      pub error: Option<String>, pub location: Option<String> }
  #[derive(Clone, Debug, Serialize)] #[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
  pub enum HubEvent {
      PeerConnected { session_id: u64, device_id: String, device_name: String, transport: Transport },
      PeerDisconnected { session_id: u64, reason: String },
      ClipReceived { session_id: u64, text: String },
      LocalClipSuperseded { text: String },
      Transfer(TransferUpdate),
  }
  pub struct HubConfig { pub device_id: String, pub pc_name: String, pub download_dir: PathBuf,
      pub local_clip: Arc<dyn Fn() -> Option<String> + Send + Sync> }
  #[derive(Clone)] pub struct Hub { … }
  impl Hub {
      pub fn new(config: HubConfig) -> (Hub, tokio::sync::mpsc::UnboundedReceiver<HubEvent>);
      pub async fn serve_tcp(&self, listener: tokio::net::TcpListener);           // bucle de accept
      pub fn accept_stream<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(&self, stream: S, transport: Transport);
      pub fn broadcast_clip(&self, text: &str);           // a cada sesión cuya ClipboardSync diga Send
      pub fn send_file(&self, path: &Path) -> Result<String, String>; // a la sesión conectada más reciente; Err("no_peer") si no hay
      pub fn cancel_transfer(&self, transfer_id: &str);
  }
  ```
  - El Hub hace de servidor: aplica la regla de inicio y el latido de la Tarea 4, y el emisor/receptor
    de la Tarea 5 con los mismos límites.
  - Guarda una `ClipboardSync` por `device_id`, en memoria durante esta fase.
  - Al recibir `clip` de una sesión: emite `ClipReceived`, marca sincronizado para ese dispositivo y lo
    reenvía al resto de sesiones conectadas.
  - Si llega un `hello` con un `device_id` que ya tiene sesión, la vieja se cierra con `replaced`.

- [ ] **Step 1: Escribir los tests** con `tokio::io::duplex` como enlace y un cliente de prueba en
  Rust (framing + `MessageDecoder`) que habla el protocolo a mano:

```rust
#[tokio::test] async fn saludo_emite_peer_connected() {}
#[tokio::test] async fn clip_entrante_emite_evento_y_no_rebota() { /* después broadcast_clip(mismo texto) no envía nada */ }
#[tokio::test] async fn clip_de_un_movil_se_reenvia_al_otro_y_no_vuelve() { /* dos clientes duplex */ }
#[tokio::test] async fn regla_inicio_ambos_cambiaron_gana_movil() { /* local_clip = "pc", hello willSendClip → LocalClipSuperseded("pc") */ }
#[tokio::test] async fn regla_inicio_solo_pc_cambio_envia_clip() {}
#[tokio::test] async fn archivo_entrante_se_guarda_en_download_dir() { /* tempdir, 5 MiB+7, file_result ok */ }
#[tokio::test] async fn archivo_saliente_respeta_ventana_de_2_mib() {}
#[tokio::test] async fn corte_a_mitad_borra_part_y_emite_failed() {}
#[tokio::test(start_paused = true)] async fn latido_30s_sin_trafico_desconecta() {}
#[tokio::test] async fn hello_duplicado_reemplaza_la_sesion_vieja() {}
```

- [ ] **Step 2: Verificar que fallan** → FAIL.
- [ ] **Step 3: Implementar** `session.rs` (una tarea por sesión: lectura con `FramedRead`, escritura
  con `FramedWrite` alimentado por un `mpsc` de comandos) y `hub.rs`.
- [ ] **Step 4: Verificar** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): Hub con sesiones persistentes y archivos"`

---

### Task 9: Prueba extremo a extremo Rust ↔ TypeScript

**Files:**
- Create: `apps/desktop/src-tauri/examples/headless.rs`, `packages/protocol/vitest.e2e.config.ts`, `packages/protocol/e2e/headless.e2e.test.ts`, `packages/protocol/e2e/nodeLink.ts`

**Interfaces:**
- Consumes: `Hub` (Tarea 8), `Session` (Tareas 4–5).
- Produces: `headless`:
  - **Argumentos:** `--download-dir <dir>` y `--local-clip <texto>` (opcional).
  - **Arranque:** escucha en `127.0.0.1:0` y escribe primero `{"type":"listening","port":N}`.
  - **Salida:** cada `HubEvent` como una línea JSON por stdout.
  - **Entrada:** lee de stdin líneas `{"cmd":"clip","text":…}` y `{"cmd":"file","path":…}`.

  Como se conecta desde 127.0.0.1, `transport` sale `usb` (es lo esperado). `nodeLink.ts`:
  `connectNode(port): Promise<Link>` sobre `node:net`.

- [ ] **Step 1: Escribir los tests e2e** (`beforeAll` compila con
  `cargo build --example headless --manifest-path …` y lanza el binario con un `tmpdir`):

```ts
test('saludo → peerConnected con deviceName "Node e2e"', async () => {});
test('clip cliente → ClipReceived; clip "cmd" del PC → evento clip en el cliente', async () => {});
test('inicio con ambos cambiados: gana el cliente y el PC emite localClipSuperseded', async () => { /* --local-clip pc */ });
test.each([0, 49152 * 3, 5 * 1024 * 1024 + 7])('archivo de %i bytes cliente → PC llega idéntico', async (n) => {});
test('archivo PC → cliente llega idéntico al memorySink', async () => {});
test('nombre "../../fuera.txt" se guarda como fuera.txt dentro de download-dir', async () => {});
```

- [ ] **Step 2: Verificar que fallan** — `pnpm --filter @clipsync/protocol test:e2e` → FAIL.
- [ ] **Step 3: Implementar** `headless.rs` y `nodeLink.ts`.
- [ ] **Step 4: Verificar** → PASS. Corregir en el lado que corresponda cualquier diferencia
  entre TS y Rust que salga aquí, con un test unitario nuevo en ese lado.
- [ ] **Step 5: Commit** — `git commit -m "test: e2e entre el Hub de Rust y la Session de TypeScript"`

---

### Task 10: App de PC — portapapeles, comandos y eventos

**Files:**
- Create: `apps/desktop/src-tauri/src/app/mod.rs`, `apps/desktop/src-tauri/src/app/clipboard.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `Cargo.toml` (`arboard` con feature `wayland-data-control`; `tauri-plugin-dialog`), `capabilities/default.json` (`dialog:default`, `core:event:default`), `apps/desktop/package.json` (`@tauri-apps/plugin-dialog`)

**Interfaces:**
- Consumes: `Hub`, `HubEvent` (Tarea 8).
- Produces (comandos Tauri, usados en la Tarea 11):
  ```rust
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct HistoryItem { pub id: u64, pub kind: String /* "text"|"file" */, pub direction: String /* "in"|"out"|"local" */,
      pub text: Option<String>, pub file_name: Option<String>, pub location: Option<String>, pub at_ms: u64 }
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct UiState { pub pc_name: String, pub peers: Vec<PeerView>, pub history: Vec<HistoryItem>,
      pub transfers: Vec<TransferUpdate>, pub clipboard_error: Option<String>, pub clip_notice: Option<String> }
  #[tauri::command] fn get_state(state) -> UiState;
  #[tauri::command] fn send_files(paths: Vec<String>, state) -> Result<Vec<String>, String>;
  #[tauri::command] fn cancel_transfer(transfer_id: String, state);
  #[tauri::command] fn copy_text(text: String, state) -> Result<(), String>; // escribe y marca sincronizado (no se reenvía)
  ```
  Eventos al webview: `"ui-state"` con el `UiState` completo cada vez que cambia (como mucho
  4 veces por segundo durante transferencias).

  `clipboard.rs`:
  - Un hilo sondea `arboard::Clipboard::get_text()` cada 500 ms y, si cambió, llama a
    `hub.broadcast_clip` y lo añade al historial como `out`. Si el texto pasa de 1 MiB no se envía y
  `UiState` lleva `clip_notice: Some("Texto demasiado grande para sincronizar (máx. 1 MB)")`
  durante 5 s.
  - Con `ClipReceived` escribe con `set_text`, guarda el texto como «último escrito» para que el
    sondeo no lo trate como cambio, y lo añade al historial como `in`.
  - Si arboard falla al iniciar, `clipboard_error` lleva el motivo y la app sigue funcionando para
    archivos.

  `lib.rs` arranca el Hub, `serve_tcp` en `0.0.0.0:52847`, mDNS, el vigilante USB y el portapapeles.
  `device_id` es un UUID guardado en `app_data_dir/device_id`; `pc_name` es el hostname.

- [ ] **Step 1: Escribir los tests** de la lógica pura de `app/mod.rs`: historial limitado a 50
  (el 51.º expulsa al más antiguo); `HubEvent::Transfer` actualiza o inserta la transferencia por
  `transfer_id` y, al terminar en `done`, añade un `HistoryItem` de archivo; `LocalClipSuperseded`
  añade un item `local`.
- [ ] **Step 2: Verificar que fallan** → FAIL.
- [ ] **Step 3: Implementar** `app/` y el cableado de `lib.rs`.
- [ ] **Step 4: Verificar** — `cargo test …` → PASS; `pnpm --filter @clipsync/desktop tauri dev` arranca,
  y en la consola aparecen el anuncio mDNS `_clipsync._tcp` y el servidor en 52847.
- [ ] **Step 5: Comprobar el portapapeles en Wayland (COSMIC)**: con la app abierta, copiar texto
  en otra app y ver que el historial lo recoge. Si `clipboard_error` indica que falta el protocolo
  data-control, documentar en `docs/testing-checklist.md` que en COSMIC hay que añadir
  `COSMIC_DATA_CONTROL_ENABLED=1` a `/etc/environment` y reiniciar la sesión. Lo hace Javier, que
  es quien decide si cambia su sistema.
- [ ] **Step 6: Commit** — `git commit -m "feat(desktop): portapapeles, historial y comandos Tauri"`

---

### Task 11: App de PC — interfaz

**Files:**
- Modify: `apps/desktop/index.html`, `apps/desktop/src/main.ts`, `apps/desktop/src/styles.css`, `apps/desktop/src-tauri/tauri.conf.json` (ventana 480×720, mínimo 400×560, título «ClipSync»)
- Delete: `apps/desktop/src/assets/` (plantilla de Tauri)
- Create: `apps/desktop/src/render.ts`, `apps/desktop/src/render.test.ts`
- Modify: `apps/desktop/package.json` (devDependencies `vitest`, `happy-dom`; script `"test": "vitest run --environment happy-dom"`)

**Interfaces:**
- Consumes: comandos y evento `"ui-state"` de la Tarea 10.
- Produces: `render(root: HTMLElement, state: UiState): void` (pura sobre el DOM) en `render.ts`;
  `main.ts` solo conecta eventos y comandos.

Contenido (spec §5, sin QR ni dispositivos emparejados hasta la fase 2):
- **Estado**: «Conectado con {deviceName} por WiFi|USB», o «Esperando al móvil…» con el texto
  «Abre ClipSync en el móvil, conectado a la misma red WiFi o por cable USB».
- **Enviar archivo**: zona para soltar (`getCurrentWebview().onDragDropEvent` → `send_files`) y
  botón «Elegir archivo» (`open({ multiple: true })` de `@tauri-apps/plugin-dialog`). Desactivados,
  con el texto «Conecta el móvil para enviar», si no hay peer.
- **Transferencias activas**: nombre, barra de progreso, «x MB de y MB» y botón «Cancelar».
- **Historial**: texto recortado a 3 líneas (clic → `copy_text` y aviso «Copiado») o archivo
  (nombre + «Abrir carpeta» con `plugin-opener` `revealItemInDir`). Flecha ↑ enviado / ↓ recibido.
- **Aviso** si `clipboardError` o `clipNotice`.
- Tema claro/oscuro según el sistema, con la paleta de la app móvil.

- [ ] **Step 1: Escribir los tests de `render`**: sin peers → muestra «Esperando al móvil…» y el
  botón está desactivado; con peer USB → «Conectado con Pixel 8 por USB»; una transferencia de
  2 621 440 de 5 242 880 bytes → barra al 50 % y «2,5 MB de 5,0 MB»; historial con texto de 10 líneas
  → elemento con la clase de recorte; `clipboardError` → aviso visible.
- [ ] **Step 2: Verificar que fallan** — `pnpm --filter @clipsync/desktop test` → FAIL.
- [ ] **Step 3: Implementar** `render.ts`, `main.ts`, `index.html` y `styles.css`.
- [ ] **Step 4: Verificar** → PASS; `pnpm --filter @clipsync/desktop build` sin errores de tipos;
  abrir con `tauri dev`, captura de pantalla de la ventana vacía y, a tamaño mínimo, comprobar que
  no hay scroll horizontal.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): interfaz nueva de ClipSync"`

---

### Task 12: App móvil — limpieza, enlace, conexión, portapapeles y archivos

**Files:**
- Delete: `apps/mobile/ios/`, `src/lib/guestServer.ts`, `src/lib/bleTransport.ts`, `src/lib/lanTransport.ts`
- Modify: `apps/mobile/package.json` (quitar `react-native-ble-plx`, `expo-blur` y `expo-network` si
  no se usan; añadir con `npx expo install`: `expo-device`, `expo-share-intent`), `app.json` (quitar el
  plugin `react-native-ble-plx`, el bloque `ios` y los permisos BLE; mantener `ACCESS_WIFI_STATE` y
  `CHANGE_WIFI_MULTICAST_STATE`; añadir el plugin `expo-share-intent` para `*/*`)
- Create: `src/lib/tcpLink.ts`, `src/lib/discovery.ts`, `src/lib/settings.ts`, `src/lib/files.ts`, `src/lib/clipboardWatcher.ts`, `src/lib/connection.ts`, `src/lib/useConnection.ts`

**Interfaces:**
- Consumes: `Session`, `Link`, `FileSource`, `FileSink`, `ClipboardSync`, constantes (Tareas 1–5).
- Produces:
  ```ts
  // tcpLink.ts
  function connectTcp(host: string, port: number, timeoutMs: number): Promise<Link>;
  // discovery.ts — resuelve el primer servicio _clipsync._tcp o null al agotar el tiempo
  function discoverPc(timeoutMs: number): Promise<{ host: string; port: number; name: string } | null>;
  // settings.ts — JSON en Paths.document/settings.json
  interface Settings { receiveDirUri: string | null }
  function loadSettings(): Settings; function saveSettings(s: Settings): void;
  // files.ts
  function fileSourceFromUri(uri: string, name: string, mime: string, size: number): FileSource; // File.open + readBytes
  function pickFileSource(): Promise<FileSource | null>;                                         // expo-document-picker
  function openSink(meta: FileMeta): Promise<FileSink>; // carpeta SAF de settings; si no hay, Directory.pickDirectoryAsync() y la guarda; nombre saneado igual que Rust
  // clipboardWatcher.ts — addClipboardListener + lectura al volver a primer plano; NO sondea (evita el aviso de Android 12+ en cada lectura)
  function startClipboardWatcher(onText: (text: string) => void): () => void;
  function writeClipboard(text: string): Promise<void>;
  // connection.ts
  type ConnStatus = 'searching' | 'connecting' | 'connected';
  interface ConnState { status: ConnStatus; transport: 'wifi' | 'usb' | null; peerName: string | null;
    transfers: TransferUpdate[]; history: HistoryEntry[]; lastError: string | null }
  interface HistoryEntry { id: string; kind: 'text' | 'file'; direction: 'in' | 'out'; text?: string; fileName?: string; location?: string; at: number }
  class ConnectionManager {
    start(): void; stop(): void;                 // ligado a AppState: activo → start, background → stop
    getState(): ConnState; subscribe(cb: () => void): () => void;
    sendFile(src: FileSource): string | null;    // null si no hay sesión
    cancelTransfer(id: string): void;
    copyFromHistory(text: string): Promise<void>; // escribe y marca sincronizado
  }
  export const connection: ConnectionManager;   // instancia única
  // useConnection.ts
  function useConnection(): ConnState;          // useSyncExternalStore
  ```
  - **Ciclo de `ConnectionManager`:**
    1. `discoverPc(2000)` → `connectTcp(host, port, 2000)` como `wifi`.
    2. Si falla, `connectTcp('127.0.0.1', 52847, 2000)` como `usb`.
    3. Si también falla, reintenta a los 5 s.

    Así sigue funcionando el USB que ya existe; el `adb` incluido y el modo fijo llegan en la fase 3.
  - **Sesión:** se crea con rol `client`, `deviceName` sacado de `expo-device`, `newTransferId` con
    `expo-crypto.getRandomBytes(16)` en hex, y una `ClipboardSync` en memoria.
  - **Portapapeles:** cambio local → `session.sendClip`; si devuelve `too_large`, `lastError` =
    «Texto demasiado grande para sincronizar (máx. 1 MB)». Evento `clip` → `writeClipboard`.

- [ ] **Step 1: Limpieza** — borrar los archivos y dependencias listados; `pnpm install`; comprobar
  que nada importa ya `guestServer`, `bleTransport` ni `lanTransport` (lo hará la pantalla nueva de
  la Tarea 13; mientras tanto `index.tsx` queda con un marcador «En construcción»).
- [ ] **Step 2: Comprobar `TextEncoder`/`TextDecoder` en Hermes** con un `console.log` temporal en un
  dev build. Si `TextDecoder` no existe, añadir el polyfill `text-encoding` en `_layout.tsx`.
- [ ] **Step 3: Implementar** los módulos con las firmas de arriba.
- [ ] **Step 4: Verificar** — `pnpm --filter @clipsync/mobile exec tsc --noEmit` y
  `pnpm --filter @clipsync/mobile lint` sin errores.
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): conexión persistente, portapapeles y archivos con el protocolo v2"`

---

### Task 13: App móvil — interfaz y «Compartir → ClipSync»

**Files:**
- Modify: `apps/mobile/src/app/_layout.tsx` (arranque de `connection` + `useShareIntent`), `apps/mobile/src/app/index.tsx` (reescrito)
- Create: `apps/mobile/src/app/settings.tsx`, `apps/mobile/src/components/StatusCard.tsx`, `TransferList.tsx`, `HistoryList.tsx`, `apps/mobile/src/theme.ts` (paleta actual de `index.tsx`)

**Interfaces:**
- Consumes: `connection`, `useConnection`, `pickFileSource`, `fileSourceFromUri`, `loadSettings`/`saveSettings` (Tarea 12).

Contenido (spec §6, sin QR ni selector de medio hasta las fases 2–4):
- **Principal**:
  - `StatusCard`: «Conectado con {peerName} por WiFi|USB», «Buscando tu PC…» o «Conectando…», y
    `lastError` si existe.
  - Botón «Enviar archivo»: desactivado sin conexión, con el texto «Abre ClipSync en el PC».
  - `TransferList`: progreso y «Cancelar».
  - `HistoryList`: tocar un texto → `copyFromHistory` y aviso «Copiado».
  - Icono de ajustes.
- **Ajustes**: «Carpeta de recepción» (ruta legible o «Sin elegir») con botón «Cambiar» y versión de
  la app.
- **Compartir**: al llegar un `shareIntent` con archivos, se encola cada uno con `fileSourceFromUri`
  cuando haya conexión (si no hay, se muestra «Esperando conexión para enviar N archivo(s)») y
  después `resetShareIntent()`.

- [ ] **Step 1: Implementar** las pantallas y los componentes.
- [ ] **Step 2: Verificar tipos y lint** — los comandos de la Tarea 12, Step 4.
- [ ] **Step 3: Compilar e instalar en el móvil de Javier** con el cable conectado:
  `pnpm --filter @clipsync/mobile android`. La app abre sin errores rojos.
- [ ] **Step 4: Commit** — `git commit -m "feat(mobile): interfaz nueva y compartir archivos con ClipSync"`

---

### Task 14: Comprobación real y documentación de la fase

**Files:**
- Create: `docs/testing-checklist.md`
- Modify: `README.md` (tabla de transportes: WiFi ✅ bidireccional, USB ✅ con `adb` del sistema, Bluetooth pendiente, sin Modo Invitado; solo Android), `docs/architecture.md` (añadir arriba una nota que remita a la spec v2 como fuente de verdad hasta su reescritura en la fase 5)

- [ ] **Step 1: Escribir `docs/testing-checklist.md`** con una sección por medio (WiFi y USB en esta
  fase) y casillas:
  - [ ] texto PC → móvil;
  - [ ] texto móvil → PC al abrir la app;
  - [ ] texto móvil → PC con la app abierta;
  - [ ] un emoji y un texto de 500 KB;
  - [ ] foto de 5 MB móvil → PC;
  - [ ] PDF PC → móvil, primera vez con elección de carpeta;
  - [ ] «Compartir → ClipSync» desde Galería;
  - [ ] cancelar a mitad;
  - [ ] apagar el WiFi del móvil a mitad (transferencia fallida, reconexión);
  - [ ] cerrar la app de PC y reabrirla (reconexión en ≤ 10 s);
  - [ ] el mismo archivo dos veces → «nombre (1)».
- [ ] **Step 2: Recorrer la lista con Javier** en su PC (Pop!_OS/COSMIC) y su móvil, marcando lo que
  pasa. Cada fallo se trata con superpowers:systematic-debugging y su arreglo lleva un test.
- [ ] **Step 3: Verificación final** — `pnpm --filter @clipsync/protocol test`,
  `pnpm --filter @clipsync/protocol test:e2e`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`,
  `pnpm --filter @clipsync/desktop test`, lint y `tsc` del móvil: todo en verde.
- [ ] **Step 4: Commit** — `git commit -m "docs: lista de comprobación y estado de la fase 1"`
