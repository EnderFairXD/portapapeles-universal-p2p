# ClipSync v2 — Fase 2: emparejamiento por QR y canal Noise IK — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el móvil solo hable con el PC con el que se emparejó escaneando un QR, que el PC
rechace a cualquier dispositivo no emparejado y que todo el tráfico vaya cifrado con
`Noise_IK_25519_ChaChaPoly_SHA256`.

**Architecture:** El `hello` en claro de la fase 1 pasa a ser la carga de los dos mensajes del
handshake Noise IK. El móvil inicia y conoce la clave del PC por el QR. El PC autoriza al
terminar el mensaje 1, con `paired.json` o con el token del QR. Tras el handshake, cada payload
de trama (byte de tipo + contenido, sin cambios) viaja cifrado. En Rust se usa `snow`. En
TypeScript, `packages/protocol` implementa el estado de handshake sobre `@noble/*` y se valida
con vectores que genera `snow`. Ya no hay modo en claro.

**Tech Stack:** lo de la fase 1, y además: Rust `snow` 0.10, `x25519-dalek` 2 (`static_secrets`),
`qrcode` 0.14 (solo `svg`), `if-addrs` 0.15, `getrandom` 0.3; TS `@noble/curves` y
`@noble/ciphers` 2.x; móvil `expo-camera` y `expo-secure-store` (SDK 57).

**Spec:** `docs/superpowers/specs/2026-10-16-clipsync-v2-design.md`: §3.2, §3.3, la fase 2 de
§12, §8 (errores de handshake), §9 (riesgo de rendimiento del cifrado en JS) y §10 (vectores de
`snow`). El registro de la fase 1 (`2026-10-16-clipsync-v2-fase1-registro.md`, R1–R30) sigue
vigente.

**Requisito previo:** la lista de la fase 1 en el móvil real (R28) sigue pendiente. Conviene
pasarla antes de la Tarea 11, para no mezclar fallos de la fase 1 con los del cifrado.

## Decisiones de este plan (para que Javier las revise)

Concretan la spec donde no dice nada o la amplían un poco. La Tarea 13 las pasa a la spec.

- **D1. Prólogo Noise** `clipsync/2` (bytes UTF-8). Es parte del patrón estándar y ata el
  handshake a esta versión del protocolo.
- **D2. Respuesta del PC** con aceptación: `{ "v": 2, "accepted": true, "deviceId": "<id del PC>", "pcName": "…" }`.
  Se añade `deviceId` porque la `Session` necesita un `PeerInfo` completo.
- **D3. Motivos de rechazo**:
  - `not_paired`: sin token, o con un token que no es el del QR.
  - `pairing_expired`: el token es el del último QR, pero caducó o ya lo usó otro móvil.

  Así el móvil puede decir «QR caducado».
- **D4. Identidad de un móvil en el PC** = su clave pública en hex (`device_key`), no el
  `deviceId` que declara. El Hub indexa por ella las sesiones, el anti-rebote y «Olvidar», y
  `PeerConnected.deviceId` lleva ese valor. Un móvil emparejado no puede hacerse pasar por otro.
- **D5. Se elimina el modo en claro**. `hello` deja de ser un mensaje de control; si llega uno
  tras el handshake, la sesión se cierra con `protocol_error`.
- **D6. Payload máximo de trama** = 65 519 bytes (65 535 − 16 de la etiqueta Poly1305). Los
  fragmentos de control pasan de 65 534 a 65 518 bytes de contenido. Los datos de archivo
  (17 + 49 152) ya cabían.
- **D7. Huella mDNS** (spec §4) desde esta fase. La TXT incluye `fp=<16 hex>`, y el móvil solo
  usa servicios cuyo `fp` coincide con el de su PC: dos PCs en la misma red no se confunden.
  Si mDNS no encuentra el PC, el móvil prueba las IPs del QR.
- **D8. Tras un rechazo** (`not_paired`, `pairing_expired`), o tras 3 handshakes fallidos
  seguidos con el PC alcanzable, el móvil borra el emparejamiento, deja de reintentar y vuelve
  a la pantalla de bienvenida con el motivo (§8).
- **D9. El PC no tiene Bluetooth hasta la fase 4**: el QR no lleva `bt` y el parser ignora
  parámetros desconocidos.
- **D10. Sin enlace profundo**: un `clipsync://pair` que llegue de fuera no empareja nada. Solo
  empareja el escáner de la app, porque si no una web podría cambiar el PC emparejado.
- **D11. Archivos del PC** (en `app_data_dir`):
  - `identity.key`: los 32 bytes de la clave privada, en crudo y con permisos `600`.
  - `paired.json`: `{ "v": 1, "devices": [{ "publicKey", "deviceId", "deviceName", "pairedAtMs" }] }`.

  Si uno está dañado, se aparta como `.bad` y se crea uno nuevo; la app no cae.

## Global Constraints

- Commits con la identidad del repo (Javier Cortés Vidal). **Nunca** líneas `Co-Authored-By` ni
  «Generated with Claude Code». No hacer push.
- Dependencias de Expo siempre con `npx expo install <paquete>` (dentro de `apps/mobile`).
- Patrón Noise exacto `Noise_IK_25519_ChaChaPoly_SHA256`, prólogo `clipsync/2`. Sin variantes
  propias. El móvil es el iniciador y el PC el respondedor.
- Trama: `u16` big-endian + datos, máximo 65 535. Tras el handshake, cada trama es un mensaje
  Noise de transporte (AD vacío, nonce por contador de 64 bits) cuyo texto en claro es el payload
  de la fase 1 (byte de tipo + contenido). Payload en claro ≤ 65 519.
- Mensaje 1 (móvil → PC), carga JSON:
  `{ "v": 2, "deviceId", "deviceName", "willSendClip"?: bool, "pairingToken"?: "<22 base64url>" }`.
  Mensaje 2 (PC → móvil): `{ "v": 2, "accepted": true, "deviceId", "pcName" }` o
  `{ "v": 2, "accepted": false, "reason": "not_paired" | "pairing_expired" }`.
- Token: 128 bits aleatorios en base64url sin relleno (22 caracteres), válido **5 minutos**
  (300 000 ms) y **un solo uso**. Un QR nuevo invalida el anterior.
- QR: `clipsync://pair?v=2&pk=<clave PC, base64url sin relleno, 43 car.>&t=<token>&n=<nombre, %-codificado>&ip=<IPv4 separadas por coma>&port=52847`.
- Huella: `fp` = 16 hex minúscula (los 8 primeros bytes del SHA-256 de la clave pública).
- Claves en ficheros y JSON internos, en hex minúscula (64 caracteres). Base64url solo en el QR.
- Motivos de cierre nuevos: `not_paired`, `pairing_expired`, `handshake_failed`, `forgotten`.
- Toda la interfaz en español. Límites de la fase 1 sin cambios (`device_id` ≤ 128 B, nombre
  ≤ 64 caracteres, 8 conexiones sin handshake a la vez).
- Comandos de prueba:
  - TS: `pnpm --filter @clipsync/protocol test`
  - Rust: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - e2e: `pnpm --filter @clipsync/protocol test:e2e`
  - PC: `pnpm --filter @clipsync/desktop test`
  - Móvil: `pnpm --filter @clipsync/mobile test`, `… exec tsc --noEmit`, `… lint`

## Review Focus

1. **QR caducado o ya usado por otro móvil**: el segundo móvil recibe `pairing_expired` y ve
   «QR caducado»; el primero sigue emparejado (Tarea 7, Tarea 8).
2. **PC reinstalado (otra clave)**: el móvil no reintenta para siempre. Al tercer handshake
   fallido muestra «No se pudo verificar el PC. Vuelve a emparejar.» (Tarea 11).
3. **«Olvidar» en el PC con el móvil conectado**: la sesión se cierra al momento y la
   reconexión recibe `not_paired` (Tarea 7, Tarea 8).
4. **Trama cifrada alterada a mitad de un archivo**: se cierra con `protocol_error`, se borra el
   parcial y ambos lados marcan la transferencia como `failed` (Tarea 6, Tarea 7).
5. **Dos PCs con ClipSync en la misma red**: el móvil solo intenta conectar con el suyo
   (Tarea 11).

---

## Estructura de archivos

```
packages/protocol/
  package.json                 + @noble/curves, @noble/ciphers; script bench
  src/constants.ts             + NOISE_TAG_BYTES, MAX_PAYLOAD_BYTES, PAIRING_TTL_MS
  src/noise.ts                 NoiseIK, CipherState, claves X25519
  src/hello.ts                 ClientHello / ServerHello (cargas del handshake)
  src/pairing.ts               parsePairingUri, fingerprint, base64url
  src/messages.ts              fragmentos de 65 518; sin 'hello' (Tarea 7)
  src/session.ts               handshake + cifrado; opciones de seguridad
  test/noise.test.ts, test/hello.test.ts, test/pairing.test.ts, test/session-secure.test.ts
  test/helpers.ts              rawClient / rawServer cifrados (sustituyen a rawPeer)
  test-vectors/noise-ik.json   generado por snow (Tarea 1)
  test-vectors/hello.json      cargas válidas e inválidas
  test-vectors/pairing.json    URIs y huellas
  bench/noise.bench.ts         rendimiento en Node
  e2e/headless.e2e.test.ts     emparejar, rechazar, olvidar
apps/desktop/src-tauri/
  Cargo.toml                   + snow, x25519-dalek, qrcode, if-addrs, getrandom
  src/protocol/secure.rs       StaticKeys, initiator/responder, SecureChannel, vectores
  src/protocol/hello.rs        ClientHello / ServerHello
  src/core/identity.rs         identity.key
  src/core/pairing.rs          PairingTokens, PairedStore, URI, QR, IPs, huella
  src/core/session.rs          handshake antes del bucle; tramas cifradas
  src/core/hub.rs, hub_tests.rs autorización, emparejar, olvidar
  src/app/mod.rs               UiState.paired / pairing / pair_notice; comandos nuevos
  src/discovery.rs             TXT fp
  src/lib.rs                   identidad y paired.json al arrancar
  examples/headless.rs         --data-dir, órdenes pair/forget
apps/desktop/src/              render.ts, main.ts, types.ts, styles.css: QR y emparejados
apps/mobile/
  app.json, package.json       expo-camera, expo-secure-store, permiso CAMERA
  src/lib/identity.ts          clave del móvil en SecureStore
  src/lib/pairing.ts           PairedPc (puro)
  src/lib/settings.ts          campo pc
  src/lib/pcAddress.ts         filtro fp e IPs del QR
  src/lib/connectionPolicy.ts  closeOutcome
  src/lib/connection.ts        pair / forgetPc, estado 'unpaired'
  src/app/scan.tsx             escáner
  src/app/index.tsx, settings.tsx, components/Welcome.tsx, components/StatusCard.tsx
docs/testing-checklist.md, README.md, spec §3.2–3.3
```

---

### Task 1: Rust — canal Noise con `snow` y vectores de prueba

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (`snow = "0.10.0"`, `x25519-dalek = { version = "2", features = ["static_secrets"] }`, `getrandom = "0.3"`), `src/protocol/mod.rs` (`pub mod secure;` y constantes)
- Create: `apps/desktop/src-tauri/src/protocol/secure.rs`, `packages/protocol/test-vectors/noise-ik.json` (generado)

**Interfaces:**
- Produces:
  ```rust
  // protocol/mod.rs
  pub const NOISE_TAG_BYTES: usize = 16;
  pub const MAX_PAYLOAD_BYTES: usize = 65_519; // MAX_FRAME_BYTES - NOISE_TAG_BYTES
  // protocol/secure.rs
  pub const NOISE_PARAMS: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
  pub const PROLOGUE: &[u8] = b"clipsync/2";
  #[derive(Clone)] pub struct StaticKeys { pub private: [u8; 32], pub public: [u8; 32] }
  impl StaticKeys { pub fn from_private(private: [u8; 32]) -> Self; pub fn generate() -> Self; }
  pub fn initiator(keys: &StaticKeys, server_public: &[u8; 32]) -> Result<snow::HandshakeState, snow::Error>;
  pub fn responder(keys: &StaticKeys) -> Result<snow::HandshakeState, snow::Error>;
  pub struct SecureChannel { … }
  impl SecureChannel {
      pub fn new(hs: snow::HandshakeState) -> Result<Self, snow::Error>;              // into_transport_mode
      pub fn encrypt(&mut self, payload: &[u8]) -> Result<Vec<u8>, ProtocolError>;    // > MAX_PAYLOAD_BYTES → Err
      pub fn decrypt(&mut self, msg: &[u8]) -> Result<Vec<u8>, ProtocolError>;
  }
  ```
  `from_private` deriva la pública con `x25519_dalek::PublicKey::from(&StaticSecret::from(..))`.
  `generate` toma los 32 bytes de `getrandom::fill`.
- Formato de `noise-ik.json` (lo consume la Tarea 2):
  ```json
  { "protocol": "Noise_IK_25519_ChaChaPoly_SHA256", "prologueHex": "…",
    "cases": [{ "name": "…", "initStaticHex": "…", "initEphemeralHex": "…",
                "respStaticHex": "…", "respEphemeralHex": "…", "handshakeHashHex": "…",
                "messages": [{ "from": "initiator" | "responder", "payloadHex": "…", "messageHex": "…" }] }] }
  ```
  Los dos primeros mensajes de cada caso son el handshake; el resto, de transporte.

- [ ] **Step 1: Escribir los tests** en `secure.rs`
  ```rust
  #[test] fn handshake_ik_y_transporte_ida_y_vuelta() { /* initiator/responder con StaticKeys::generate; 2 mensajes; encrypt/decrypt en ambos sentidos */ }
  #[test] fn clave_de_servidor_equivocada_falla_en_el_mensaje_1() { /* responder.read_message → Err */ }
  #[test] fn un_bit_cambiado_no_descifra() { /* decrypt → Err(ProtocolError) */ }
  #[test] fn payload_de_65519_cabe_y_65520_no() { /* encrypt(65519).len() == 65535; encrypt(65520) → Err */ }
  #[test] fn from_private_deriva_la_publica() { /* vector RFC 7748 §6.1: privada de Alice 77076d0a…2c2a → pública 8520f009…4e6a */ }
  #[test] fn vectores_noise_coinciden_con_snow() { /* ver Step 3 */ }
  ```
- [ ] **Step 2: Verificar que fallan** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml protocol::secure` → FAIL (no compila).
- [ ] **Step 3: Implementar `secure.rs`**. El test de vectores construye en memoria 3 casos y
  los compara con el JSON del repo. Con `CLIPSYNC_WRITE_VECTORS=1`, en vez de comparar, escribe
  el archivo. Claves fijas: `sha256("clipsync-vector/<caso>/<rol>/<s|e>")`, con las efímeras vía
  `fixed_ephemeral_key_for_testing_only`.
  - `vacio`: cargas vacías en el handshake; transporte de 0 y 1 bytes.
  - `hello`: el JSON de un `ClientHello` con `pairingToken` y el de un `ServerHello` aceptado;
    transporte i→r de 3 bytes, r→i de 3 bytes e i→r de 65 519 bytes.
  - `orden`: 4 mensajes de transporte seguidos del mismo lado, para probar el contador de nonce.
- [ ] **Step 4: Generar y verificar** — `CLIPSYNC_WRITE_VECTORS=1 cargo test … vectores_noise`,
  luego sin la variable: todo → PASS. El JSON queda con 2 espacios de sangría.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): canal Noise IK con snow y vectores compartidos"`

---

### Task 2: TypeScript — Noise IK sobre `@noble`, validado con los vectores

**Files:**
- Modify: `packages/protocol/package.json` (`@noble/curves`, `@noble/ciphers`; script `"bench": "vitest bench --run"`), `src/constants.ts`, `src/index.ts`
- Create: `packages/protocol/src/noise.ts`, `packages/protocol/test/noise.test.ts`, `packages/protocol/bench/noise.bench.ts`

**Interfaces:**
- Consumes: `noise-ik.json` (Tarea 1), `ProtocolError` (`messages.ts`).
- Produces:
  ```ts
  // constants.ts
  export const NOISE_TAG_BYTES = 16;
  export const MAX_PAYLOAD_BYTES = 65519;
  export const PAIRING_TTL_MS = 300000;
  // noise.ts
  export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
  export const NOISE_PROLOGUE: Uint8Array;                    // UTF-8 de 'clipsync/2'
  export interface KeyPair { privateKey: Uint8Array; publicKey: Uint8Array }
  export type RandomBytes = (n: number) => Uint8Array;
  export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair;   // RangeError si no son 32 bytes
  export function generateKeyPair(randomBytes?: RandomBytes): KeyPair;
  export class NoiseError extends ProtocolError {}
  export class CipherState {                                  // AD vacío; nonce = 4 ceros + contador u64 little-endian
    encrypt(plaintext: Uint8Array): Uint8Array;               // RangeError si plaintext > MAX_PAYLOAD_BYTES
    decrypt(ciphertext: Uint8Array): Uint8Array;              // NoiseError si no autentica
  }
  export interface HandshakeOptions { s: KeyPair; prologue?: Uint8Array; randomBytes?: RandomBytes; fixedEphemeral?: KeyPair }
  export class NoiseIK {
    static initiator(o: HandshakeOptions & { rs: Uint8Array }): NoiseIK;
    static responder(o: HandshakeOptions): NoiseIK;
    writeMessage(payload: Uint8Array): Uint8Array;            // Error si no es su turno
    readMessage(message: Uint8Array): Uint8Array;             // NoiseError si falla
    get remoteStatic(): Uint8Array | null;
    get handshakeHash(): Uint8Array;
    get isFinished(): boolean;
    split(): { send: CipherState; recv: CipherState };        // Error si no ha terminado
  }
  ```
  `randomBytes` por defecto: `randomBytes` de `@noble/hashes/utils.js`. El móvil pasa
  `expo-crypto`.
- Primitivas:
  - X25519: `x25519` de `@noble/curves/ed25519.js`.
  - AEAD: `chacha20poly1305` de `@noble/ciphers/chacha.js`.
  - Hash: `sha256`.
  - HKDF de Noise (2 salidas): `hkdf(sha256, ikm, ck, new Uint8Array(0), 64)` partido en dos.
    Es equivalente a la definición de Noise con HMAC-SHA256.
  - `MixHash`, `MixKey`, `EncryptAndHash` y `Split` se implementan tal como dice el §5 de la
    especificación de Noise, sin atajos.

- [ ] **Step 1: Escribir los tests**
  ```ts
  test.each(vectors.cases)('vector $name: el iniciador produce los mismos bytes', (c) => {
    // NoiseIK.initiator con s=initStatic, fixedEphemeral=initEphemeral, rs=pública de respStatic;
    // cada mensaje 'initiator' → writeMessage(payload) === messageHex; cada 'responder' → readMessage(messageHex) === payloadHex
    // tras el handshake: split() y lo mismo con CipherState; handshakeHash === handshakeHashHex
  });
  test.each(vectors.cases)('vector $name: el respondedor produce los mismos bytes', (c) => { /* simétrico; remoteStatic === pública de initStatic */ });
  test('clave de servidor equivocada → readMessage del mensaje 1 lanza NoiseError', () => {});
  test('un bit cambiado en transporte → NoiseError y el nonce no avanza', () => {});
  test('keyPairFromPrivate cumple el vector de RFC 7748 §6.1', () => {});
  test('encrypt de 65519 bytes da 65535; de 65520 lanza RangeError', () => {});
  test('writeMessage fuera de turno y split antes de terminar lanzan', () => {});
  ```
- [ ] **Step 2: Verificar que fallan** — `pnpm --filter @clipsync/protocol test` → FAIL.
- [ ] **Step 3: Instalar dependencias** (`pnpm --filter @clipsync/protocol add @noble/curves @noble/ciphers`)
  **e implementar `noise.ts`**; añadir `export * from './noise'` a `index.ts`.
- [ ] **Step 4: Escribir `bench/noise.bench.ts`**: un handshake IK completo (las dos partes) y
  `encrypt` + `decrypt` de 49 169 bytes.
- [ ] **Step 5: Verificar** — `pnpm --filter @clipsync/protocol test` → PASS; `pnpm --filter @clipsync/protocol bench`
  imprime operaciones/s (anotar MB/s de cifrado en el commit).
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol): Noise IK en TypeScript validado con vectores de snow"`

---

### Task 3: Cargas del handshake y tramas que caben cifradas (TS y Rust)

**Files:**
- Create: `packages/protocol/src/hello.ts`, `packages/protocol/test/hello.test.ts`, `packages/protocol/test-vectors/hello.json`, `apps/desktop/src-tauri/src/protocol/hello.rs`
- Modify: `packages/protocol/src/messages.ts` y `apps/desktop/src-tauri/src/protocol/messages.rs` (fragmentos de `MAX_PAYLOAD_BYTES - 1`), sus tests, `src/index.ts`, `src/protocol/mod.rs`

**Interfaces:**
- Produces (TS):
  ```ts
  export interface ClientHello { v: 2; deviceId: string; deviceName: string; willSendClip?: boolean; pairingToken?: string }
  export type RejectReason = 'not_paired' | 'pairing_expired';
  export type ServerHello =
    | { v: 2; accepted: true; deviceId: string; pcName: string }
    | { v: 2; accepted: false; reason: RejectReason };
  export function encodeClientHello(h: ClientHello): Uint8Array;  export function decodeClientHello(b: Uint8Array): ClientHello;
  export function encodeServerHello(h: ServerHello): Uint8Array;  export function decodeServerHello(b: Uint8Array): ServerHello;
  ```
  Las funciones `decode*` lanzan `ProtocolError` si el JSON es inválido o si:
  - `v !== 2`;
  - falta `deviceId`, `deviceName` o `pcName`, o no son strings;
  - `willSendClip` no es booleano;
  - `pairingToken` no cumple `/^[A-Za-z0-9_-]{22}$/`;
  - `accepted` no es booleano;
  - `reason` no está en `RejectReason`.

  Los campos desconocidos se ignoran.
- Produces (Rust, `protocol/hello.rs`): `ClientHello` (serde `camelCase`, opcionales con
  `skip_serializing_if`), `ServerHello` con `ServerHello::accept(device_id, pc_name)` y
  `ServerHello::reject(reason)`, y
  `decode_client_hello(&[u8]) -> Result<ClientHello, ProtocolError>`,
  `encode_server_hello(&ServerHello) -> Vec<u8>`,
  `decode_server_hello(&[u8]) -> Result<ServerHello, ProtocolError>` (este último para el
  cliente de pruebas). Validación idéntica a la de TS.
- `hello.json`: `[{ "name", "side": "client" | "server", "json": "<texto>", "expect": <objeto> | { "error": true } }]`,
  con casos de cada campo inválido de arriba, un token de 21 y uno de 23 caracteres, un
  `ServerHello` aceptado sin `pcName` y uno rechazado con `reason: "otra"`.

- [ ] **Step 1: Escribir `hello.json` y los tests**: los vectores en TS (`hello.test.ts`) y en
  Rust (`hello.rs`, `include_str!("../../../../../packages/protocol/test-vectors/hello.json")`);
  ida y vuelta de cada variante. En `messages`, de los dos lados:
  ```ts
  test('un control de exactamente 65519 bytes de payload va en una trama y uno más se trocea', () => {});
  test('ningún payload de encodeControl pasa de MAX_PAYLOAD_BYTES (clip de 1 MiB de emojis)', () => {});
  ```
  El test de Rust `json_de_65534_bytes_cabe_en_una_trama_y_65535_se_trocea` pasa a 65 518 / 65 519.
- [ ] **Step 2: Verificar que fallan** — los dos comandos de prueba → FAIL.
- [ ] **Step 3: Implementar** `hello.ts`, `hello.rs` y el cambio de tamaño de fragmento.
  `MessageDecoder` sigue aceptando tramas de hasta 65 535 (no cambia).
- [ ] **Step 4: Verificar** → PASS en TS y Rust.
- [ ] **Step 5: Commit** — `git commit -m "feat(protocol): cargas del handshake y fragmentos que caben en un mensaje Noise"`

---

### Task 4: Rust — identidad del PC y emparejamiento

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (`qrcode = { version = "0.14.1", default-features = false, features = ["svg"] }`, `if-addrs = "0.15"`), `src/core/mod.rs`
- Create: `apps/desktop/src-tauri/src/core/identity.rs`, `apps/desktop/src-tauri/src/core/pairing.rs`, `packages/protocol/test-vectors/pairing.json`

**Interfaces:**
- Consumes: `StaticKeys` (Tarea 1).
- Produces:
  ```rust
  // identity.rs
  pub fn load_or_create(dir: Option<&Path>) -> StaticKeys;   // dir None → clave efímera
  // pairing.rs
  pub const PAIRING_TTL_MS: u64 = 300_000;
  #[derive(Clone, Debug, PartialEq)] pub struct PairingOffer { pub token: String, pub expires_at_ms: u64 }
  #[derive(Debug, PartialEq)] pub enum TokenCheck { Valid, Expired, Unknown }
  #[derive(Default)] pub struct PairingTokens { … }
  impl PairingTokens {
      pub fn offer(&mut self, now_ms: u64) -> PairingOffer;             // sustituye al anterior
      pub fn cancel(&mut self);
      pub fn active(&self, now_ms: u64) -> Option<PairingOffer>;
      pub fn check_and_consume(&mut self, token: &str, now_ms: u64) -> TokenCheck;
  }
  #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub struct PairedDevice { pub public_key: String, pub device_id: String, pub device_name: String, pub paired_at_ms: u64 }
  pub struct PairedStore { … }
  impl PairedStore {
      pub fn load(path: Option<PathBuf>) -> Self;                       // None → solo memoria (tests)
      pub fn contains(&self, public_key_hex: &str) -> bool;
      pub fn upsert(&mut self, d: PairedDevice) -> std::io::Result<()>; // misma clave → actualiza nombre e id
      pub fn remove(&mut self, public_key_hex: &str) -> std::io::Result<bool>;
      pub fn list(&self) -> Vec<PairedDevice>;                          // por paired_at_ms
  }
  pub fn fingerprint(public_key: &[u8; 32]) -> String;
  pub fn pairing_uri(public_key: &[u8; 32], token: &str, pc_name: &str, ips: &[Ipv4Addr], port: u16) -> String;
  pub fn qr_svg(uri: &str) -> String;                                   // EcLevel M, mínimo 240×240
  pub fn order_ips(ips: Vec<IpAddr>) -> Vec<Ipv4Addr>;                  // puro, para test
  pub fn lan_ipv4s() -> Vec<Ipv4Addr>;                                  // if_addrs + order_ips
  ```
- Reglas:
  - **Token**: 16 bytes de `getrandom::fill`, en base64url `URL_SAFE_NO_PAD` (crate `base64`
    0.23, ya presente).
  - **`check_and_consume`**:
    - `Valid` si es el token vigente y `now_ms < expires_at_ms`. Lo marca usado.
    - `Expired` si coincide con el último token emitido pero caducó o ya se usó.
    - `Unknown` en cualquier otro caso, también tras `cancel()`.
    - La comparación es en tiempo constante (OR de XOR sobre los bytes).
  - **Escritura de `paired.json` e `identity.key`**: en `<nombre>.tmp` con modo `0o600` en Unix
    (`OpenOptionsExt::mode`) y después `rename`.
  - **Archivo dañado** (`identity.key` que no tiene 32 bytes, JSON inválido): se renombra a
    `<nombre>.bad`, se escribe en stderr con `writeln!` sin `unwrap` y se empieza de cero.
  - **`order_ips`**: solo IPv4; fuera loopback y 169.254/16; primero las privadas (10/8,
    172.16/12, 192.168/16) y luego el resto, sin repetir.
  - **`pairing_uri`**:
    - `pk` en base64url sin relleno.
    - `n` recortado a 64 caracteres y %-codificado: se conservan `A–Z a–z 0–9 - . _ ~`; lo demás
      va como `%XX` en mayúsculas sobre UTF-8.
    - `ip` unidas por `,` sin codificar.
- `pairing.json`:
  ```json
  { "build": [{ "publicKeyHex", "token", "pcName", "ips": [..], "port", "uri" }],
    "parse": [{ "name", "uri", "expect": { "publicKeyHex", "token", "name", "ips", "port" } | { "error": true } }],
    "fingerprints": [{ "publicKeyHex", "fp" }] }
  ```
  - `build`: con un nombre con espacios, «ñ» y un emoji.
  - `parse`: la URI de `build`, parámetros en otro orden, un parámetro `bt` extra que se
    ignora, `ip` vacío, y errores: `v=1`, `pk` de 31 bytes, token de 21 caracteres, `port=0`,
    `port=70000`, IP `999.1.1.1`, sin `n` y esquema `https://`.

- [ ] **Step 1: Escribir los tests** (con `tempfile`, nunca `app_data_dir` real)
  ```rust
  #[test] fn identidad_se_crea_y_se_relee_igual() {}
  #[cfg(unix)] #[test] fn identidad_con_permisos_600() {}
  #[test] fn identidad_danada_se_aparta_y_se_crea_otra() { /* identity.key de 5 bytes → identity.key.bad existe y la nueva es válida */ }
  #[test] fn token_valido_una_sola_vez() { /* offer(0); check(t, 1) == Valid; check(t, 2) == Expired */ }
  #[test] fn token_caduca_a_los_5_minutos() { /* t1 = offer(0): check(t1, 299_999) == Valid; t2 = offer(0): check(t2, 300_000) == Expired */ }
  #[test] fn oferta_nueva_invalida_la_anterior_y_cancel_tambien() { /* token viejo → Unknown */ }
  #[test] fn paired_store_persiste_upsert_y_remove() {}
  #[test] fn paired_json_danado_se_aparta() {}
  #[test] fn order_ips_filtra_y_ordena() { /* [127.0.0.1, 169.254.1.2, 8.8.8.8, 192.168.1.5, ::1, 10.0.0.2] → [192.168.1.5, 10.0.0.2, 8.8.8.8] */ }
  #[test] fn pairing_json_build_y_huellas() { /* include_str! de pairing.json: pairing_uri(...) == uri; fingerprint == fp */ }
  #[test] fn qr_svg_es_un_svg() { /* empieza por "<?xml" o "<svg" y contiene "</svg>" */ }
  ```
- [ ] **Step 2: Verificar que fallan** — `cargo test … core::pairing core::identity` → FAIL.
- [ ] **Step 3: Escribir `pairing.json` e implementar** los dos módulos.
  - A mano: las entradas de `build`, la sección `parse` (el `expect` de la URI de `build` sale de
    sus entradas) y las claves de `fingerprints`.
  - Con `CLIPSYNC_WRITE_VECTORS=1`: el test rellena `build[].uri` y `fingerprints[].fp`, igual
    que en la Tarea 1, y conserva el resto del archivo.
- [ ] **Step 4: Verificar** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): identidad del PC, tokens de emparejamiento y QR"`

---

### Task 5: TypeScript — lectura del QR y huella

**Files:**
- Create: `packages/protocol/src/pairing.ts`, `packages/protocol/test/pairing.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `pairing.json` (Tarea 4), `sha256` de `@noble/hashes`.
- Produces:
  ```ts
  export interface PairingInfo { publicKey: Uint8Array; token: string; name: string; ips: string[]; port: number }
  export function parsePairingUri(text: string): PairingInfo | null;   // null = no es un QR de ClipSync válido
  export function fingerprint(publicKey: Uint8Array): string;           // 16 hex
  export function bytesToBase64Url(b: Uint8Array): string;
  export function base64UrlToBytes(s: string): Uint8Array | null;       // null si hay caracteres fuera del alfabeto
  ```
  Sin `URL` ni `URLSearchParams`, porque Hermes los implementa a medias: se separa a mano por
  `?`, `&` y el primer `=`, y se aplica `decodeURIComponent` dentro de un `try`.

- [ ] **Step 1: Escribir los tests**: recorrer `parse` y `fingerprints` de `pairing.json`, más:
  ```ts
  test('base64url ida y vuelta para 0..40 bytes', () => {});
  test('texto que no es una URI (p. ej. "hola") → null', () => {});
  test('%ZZ en el nombre → null, sin lanzar', () => {});
  ```
- [ ] **Step 2: Verificar que fallan** → FAIL.
- [ ] **Step 3: Implementar** `pairing.ts` y el `export *`.
- [ ] **Step 4: Verificar** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(protocol): lectura del QR de emparejamiento y huella del PC"`

---

### Task 6: TypeScript — `Session` con handshake Noise y tramas cifradas

**Files:**
- Modify: `packages/protocol/src/session.ts`, `packages/protocol/test/helpers.ts`, `packages/protocol/test/session.test.ts`, `packages/protocol/test/session-files.test.ts`
- Create: `packages/protocol/test/session-secure.test.ts`

**Interfaces:**
- Consumes: `NoiseIK`, `CipherState`, `KeyPair`, `RandomBytes` (Tarea 2); `ClientHello`,
  `ServerHello`, `encode/decode*Hello` (Tarea 3).
- Produces (cambios en `SessionOptions`; lo demás de la fase 1 no cambia):
  ```ts
  export type AuthDecision = { accepted: true } | { accepted: false; reason: RejectReason };
  interface SessionOptions {
    // … campos de la fase 1 …
    identity: KeyPair;
    randomBytes?: RandomBytes;
    /** Cliente: clave pública del PC (del QR). Obligatoria con role 'client'. */
    serverKey?: Uint8Array;
    /** Cliente: token del QR mientras el emparejamiento no se ha completado. */
    pairingToken?: string | null;
    /** Servidor (solo pruebas en TS; el servidor real es Rust). Obligatoria con role 'server'. */
    authorize?(req: { publicKey: Uint8Array; hello: ClientHello }): Promise<AuthDecision>;
  }
  ```
  El constructor lanza `Error` si falta `serverKey` (cliente) o `authorize` (servidor).
- **Flujo del cliente:**
  1. `start()` calcula `willSendClip` como en la fase 1.
  2. Escribe `encodeFrame(hs.writeMessage(encodeClientHello({ v: 2, ...self, willSendClip, pairingToken? })))`.
  3. En `onData`, la primera trama se lee de forma **síncrona** con `hs.readMessage`, y después
     `split()`, para que las tramas siguientes del mismo trozo ya se descifren en orden. Luego
     se encola el antiguo `onServerHello`, con `PeerInfo = { deviceId, deviceName: pcName }`.
  4. Si llega `accepted: false`, se cierra con `reason`.
  5. Si el enlace se cierra (o falla `readMessage`) después de enviar el mensaje 1 y antes del
     mensaje 2, se cierra con `'handshake_failed'`.
- **Flujo del servidor:**
  1. La primera trama se lee de forma síncrona (`readMessage` + `decodeClientHello`); un fallo
     cierra con `'handshake_failed'`.
  2. Se encola: `authorize` → `writeMessage(encodeServerHello(...))` → `split()`.
  3. Si se rechaza, se envía el mensaje 2 de rechazo y se cierra con `reason`. Si se acepta,
     sigue la regla de inicio de la fase 1 (sin enviar `hello`).
  4. Una trama que llegue antes del `split()` cierra con `'protocol_error'`.
- **Tras el handshake:**
  - Toda salida, también `pongNow`, pasa por `send.encrypt(payload)` antes de `encodeFrame`.
  - Toda entrada pasa por `recv.decrypt(frame)` antes de `MessageDecoder.push`.
  - Un fallo de descifrado cierra con `'protocol_error'`.
  - Si llega un `hello` como mensaje de control, cierra con `'protocol_error'`.
  - El plazo del latido (30 s) cubre el handshake, como cubría el saludo.
- `helpers.ts`: se cambia `rawPeer` por dos helpers que hacen el handshake con `NoiseIK` y
  devuelven la misma interfaz más tres cosas:
  - `sendRaw(payload)`: cifra y enmarca.
  - `sendWire(bytes)`: escribe tal cual, sin cifrar ni enmarcar.
  - `corruptNext()`: cambia un bit del siguiente mensaje cifrado que se envía.
  ```ts
  export const KEYS: { movil: KeyPair; pc: KeyPair; otro: KeyPair };   // keyPairFromPrivate de bytes fijos
  export function rawServer(link: Link, o?: { keys?: KeyPair; answer?: (h: ClientHello, pk: Uint8Array) => ServerHello; answerPings?: boolean }): RawPeer & { clientHello(): ClientHello | null };
  export function rawClient(link: Link, o?: { keys?: KeyPair; serverKey?: Uint8Array; hello?: Partial<ClientHello> }): Promise<RawPeer & { serverHello: ServerHello }>;
  ```
  `makeSession` en los tests de sesión pasa `identity`, `serverKey: KEYS.pc.publicKey` y un
  `authorize` que acepta por defecto. Las 13 apariciones de `kind: 'hello'` en los tests pasan a
  `rawClient`/`rawServer`, conservando lo que cada test comprueba.

- [ ] **Step 1: Migrar `helpers.ts` y los tests existentes** (`session.test.ts`,
  `session-files.test.ts`) a los helpers cifrados. Ninguna aserción de la fase 1 se debilita.
- [ ] **Step 2: Escribir `session-secure.test.ts`**
  ```ts
  test('handshake: ready en ambos; el cliente ve { deviceId: "pc-1", deviceName: "PC" }', async () => {});
  test('authorize recibe la clave pública del cliente y el hello con pairingToken y willSendClip', async () => {});
  test('rechazo not_paired: el cliente cierra con "not_paired" sin ready; el servidor también', async () => {});
  test('rechazo pairing_expired llega como "pairing_expired"', async () => {});
  test('clave del servidor equivocada → el cliente acaba en "handshake_failed"', async () => {});
  test('enlace cerrado tras el mensaje 1 → "handshake_failed"', async () => {});
  test('trama extra antes de la respuesta del servidor → "protocol_error"', async () => {});
  test('nada viaja en claro: los bytes del enlace no contienen el texto del clip ni el deviceName', async () => {});
  test('un bit cambiado en una trama a mitad de un archivo → protocol_error, sink abortado, ambos failed', async () => {});
  test('hello como mensaje de control tras el handshake → "protocol_error"', async () => {});
  test('clip de 1 MiB de emojis llega entero; ninguna trama del enlace pasa de 65537 bytes con su longitud', async () => {});
  test('sin respuesta al mensaje 1 en 30 s → "heartbeat_timeout"', async () => { /* fakeTimers */ });
  test('constructor sin serverKey (cliente) o sin authorize (servidor) lanza', () => {});
  ```
- [ ] **Step 3: Verificar que fallan** — `pnpm --filter @clipsync/protocol test` → FAIL.
- [ ] **Step 4: Implementar** los cambios de `session.ts`. `HelloMsg` deja de usarse aquí; su
  retirada de `messages.ts` llega en la Tarea 7.
- [ ] **Step 5: Verificar** → PASS (todas las pruebas de `packages/protocol`).
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol): Session cifrada con Noise IK y hello en el handshake"`

---

### Task 7: Rust — sesión cifrada, autorización en el Hub y retirada de `hello`

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/session.rs`, `src/core/hub.rs`, `src/core/hub_tests.rs`, `src/protocol/messages.rs`, `src/protocol/mod.rs` (quitar `MAX_PRE_HELLO_CONTROL_BYTES`)
- Modify (TS): `packages/protocol/src/messages.ts` (quitar `HelloMsg`), `packages/protocol/test-vectors/messages.json` (los vectores de `hello` pasan a `{"error": true}` por `kind` desconocido), `packages/protocol/test/messages.test.ts`, `packages/protocol/schema/sync-message.schema.json` (sin `hello`; se añaden las dos cargas del handshake en `$defs`)

**Interfaces:**
- Consumes: Tareas 1, 3 y 4.
- Produces:
  ```rust
  // HubConfig: campos nuevos
  pub keys: StaticKeys,
  pub paired: PairedStore,
  // HubEvent: variante nueva (PeerConnected.device_id pasa a ser la clave pública del móvil en hex, D4)
  DevicePaired { device_key: String, device_name: String },
  impl Hub {
      pub fn public_key(&self) -> [u8; 32];
      pub fn start_pairing(&self) -> PairingOffer;            // ahora_ms = SystemTime
      pub fn cancel_pairing(&self);
      pub fn pairing_offer(&self) -> Option<PairingOffer>;    // la vigente
      pub fn paired_devices(&self) -> Vec<PairedDevice>;
      pub fn forget_device(&self, device_key: &str) -> bool;  // quita, guarda, cierra sus sesiones con "forgotten" y borra su ClipboardSync
  }
  // SessionHost: método nuevo; clip_sync_for recibe la device_key
  fn authorize(&self, session_id: u64, public_key: &[u8; 32], hello: &ClientHello) -> Result<(), &'static str>;
  ```
- `authorize` en el Hub (spec §3.2, D3):
  1. Si la clave está en `paired` → `Ok`. Si además trae el token vigente, se consume, se
     actualizan el nombre y el id y se emite `DevicePaired`, para que el QR del PC se cierre.
  2. Si no está, según el token:
     - `Valid` → `upsert` y `Ok`. Si falla el guardado, se escribe en stderr y se acepta igual
       (queda en memoria). Se emite `DevicePaired`.
     - `Expired` → `Err("pairing_expired")`.
     - `Unknown` o sin token → `Err("not_paired")`.
- `session::run`:
  1. Antes del bucle principal, una función `handshake` lee la primera trama, con
     `HEARTBEAT_TIMEOUT_MS` de plazo desde que se aceptó la conexión.
  2. `responder.read_message`, `decode_client_hello` y los límites de `device_id` y nombre de
     la fase 1. Cualquier fallo → `Closed("handshake_failed")` sin `Ready`.
  3. `host.authorize`:
     - Si da `Err(reason)`: escribe el mensaje 2 de rechazo y termina con `Closed(reason)`.
     - Si da `Ok`: escribe el de aceptación (`cfg.device_id`, `cfg.device_name`), crea el
       `SecureChannel` y llama a `on_client_hello`. Esa función ya no envía `Hello`, y la
       `device_key` es `hex::encode(public_key)`.
  4. `write_frames` cifra cada payload; `on_frame` descifra antes del `MessageDecoder`; un fallo
     de descifrado → `PROTOCOL_ERROR`.
  5. El `MessageDecoder` arranca con `MAX_CONTROL_BYTES`.
- `hub_tests.rs`:
  - El `Client` hace el handshake con `secure::initiator` y guarda el `snow::TransportState` en
    un `Arc<Mutex<_>>` compartido con el hilo lector.
  - `send` y `send_data` cifran. Nuevos métodos `send_payload(&[u8])` y `send_corrupt(msg)`.
  - Las claves de prueba son `test_keys(device_id)` = `StaticKeys::from_private(sha256("test/" + device_id))`.
  - `setup()` crea `PairedStore::load(Some(tempdir/paired.json))` con `m1` y `m2` ya emparejados.
  - `Client::hello(device_id, will)` hace el handshake y comprueba que la respuesta es
    `ServerHello::accept("pc-1", "PC de prueba")`.
  - El envío de `[0x03, b' ']` en claro pasa a `send_payload`.
  - Los tests de mensajes antes del `hello` pasan a «trama que no es un mensaje 1 válido».

- [ ] **Step 1: Retirar `hello`** de `messages.ts`/`messages.rs`, los vectores y el esquema. Los
  tests de `messages` de los dos lados exigen error en esos vectores.
- [ ] **Step 2: Migrar `hub_tests.rs`** al cliente cifrado, sin debilitar ningún test existente,
  **y escribir los nuevos**:
  ```rust
  #[tokio::test] async fn peer_connected_lleva_la_clave_del_movil() { /* deviceId == hex(test_keys("m1").public) */ }
  #[tokio::test] async fn no_emparejado_recibe_not_paired_y_no_hay_eventos() {}
  #[tokio::test] async fn token_valido_empareja_guarda_y_emite_device_paired() { /* paired.json contiene la clave; reconectar sin token → aceptado */ }
  #[tokio::test] async fn token_usado_por_otro_movil_da_pairing_expired() { /* m3 empareja; m4 con el mismo token → pairing_expired; m3 sigue en paired */ }
  #[tokio::test] async fn emparejado_con_token_vigente_lo_consume_y_cierra_la_oferta() { /* pairing_offer() == None */ }
  #[tokio::test] async fn olvidar_cierra_la_sesion_y_rechaza_la_reconexion() { /* PeerDisconnected{reason:"forgotten"}; nuevo handshake → not_paired */ }
  #[tokio::test] async fn clave_de_pc_equivocada_cierra_sin_eventos() {}
  #[tokio::test] async fn trama_alterada_a_mitad_de_archivo_cierra_y_borra_el_parcial() { /* send_corrupt; sin .part en el tempdir; transfer failed */ }
  #[tokio::test] async fn hello_tras_el_handshake_cierra_con_protocol_error() { /* send_payload con el JSON de un hello de la fase 1 */ }
  #[tokio::test(start_paused = true)] async fn sin_mensaje_1_en_30s_se_cierra() {}
  ```
- [ ] **Step 3: Verificar que fallan** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` → FAIL.
- [ ] **Step 4: Implementar** `session.rs` y `hub.rs`. Actualizar `examples/headless.rs` y
  `lib.rs` lo justo para que compilen: `StaticKeys::generate()` y `PairedStore::load(None)`. Se
  completan en las Tareas 8 y 9.
- [ ] **Step 5: Verificar** → PASS en Rust y en TS (`pnpm --filter @clipsync/protocol test`).
- [ ] **Step 6: Commit** — `git commit -m "feat(desktop): sesiones cifradas con Noise IK y autorización por emparejamiento"`

---

### Task 8: Prueba extremo a extremo con emparejamiento

**Files:**
- Modify: `apps/desktop/src-tauri/examples/headless.rs`, `packages/protocol/e2e/headless.e2e.test.ts`

**Interfaces:**
- Consumes: `Hub` (Tarea 7), `Session` (Tarea 6), `generateKeyPair` y `fingerprint`.
- Produces (`headless`):
  - **Argumento nuevo** obligatorio, `--data-dir <dir>`: carga `identity::load_or_create` y
    `PairedStore::load(dir/paired.json)`.
  - **Primera línea**: `{"type":"listening","port":N,"publicKey":"<hex>"}`.
  - **Órdenes nuevas** por stdin:
    - `{"cmd":"pair"}` → responde con la línea `{"type":"pairing","token":"…","expiresAtMs":N}`.
    - `{"cmd":"forget","deviceKey":"…"}` → sin respuesta propia; los efectos llegan como eventos.

- [ ] **Step 1: Escribir los tests e2e**:
  - Un helper `pairedSession(local?)` empareja un cliente nuevo (orden `pair` + `pairingToken`)
    y devuelve la sesión lista.
  - Los tests de la fase 1 (clip en ambos sentidos, regla de inicio, archivos de 0, 147 456 y
    5 MiB + 7 bytes en ambos sentidos, nombre hostil) pasan a usarlo.
  - Tests nuevos:
  ```ts
  test('emparejar: ready, devicePaired con el deviceName y peerConnected con la clave del cliente en hex', async () => {});
  test('reconexión sin token tras emparejar → ready', async () => {});
  test('cliente no emparejado sin token → closed "not_paired" y ningún peerConnected', async () => {});
  test('el mismo token en un segundo cliente → "pairing_expired"', async () => {});
  test('clave del PC equivocada → closed "handshake_failed"', async () => {});
  test('forget → peerDisconnected "forgotten" y la reconexión da "not_paired"', async () => {});
  test('reiniciar headless con el mismo --data-dir conserva publicKey y emparejados', async () => {});
  ```
- [ ] **Step 2: Verificar que fallan** — `pnpm --filter @clipsync/protocol test:e2e` → FAIL.
- [ ] **Step 3: Implementar** los cambios de `headless.rs`.
- [ ] **Step 4: Verificar** → PASS. Cualquier diferencia entre TS y Rust que salga aquí se
  arregla en el lado que corresponda, con un test unitario nuevo en ese lado.
- [ ] **Step 5: Commit** — `git commit -m "test: e2e de emparejamiento y canal cifrado entre Rust y TypeScript"`

---

### Task 9: App de PC — identidad, mDNS con huella, comandos y estado de emparejamiento

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`, `src/discovery.rs`, `src/app/mod.rs`

**Interfaces:**
- Consumes: `Hub` (Tarea 7), `identity`, `pairing` (Tarea 4).
- Produces (los consume la Tarea 10):
  ```rust
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct PairedView { pub device_key: String, pub device_name: String, pub paired_at_ms: u64, pub connected: bool }
  #[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")]
  pub struct PairingView { pub qr_svg: String, pub expires_at_ms: u64 }
  // UiState: campos nuevos
  pub paired: Vec<PairedView>, pub pairing: Option<PairingView>, pub pair_notice: Option<String>,
  #[tauri::command] fn start_pairing(state) -> Result<(), String>;      // Err si no hay ninguna IPv4 de LAN: "No hay ninguna red disponible"
  #[tauri::command] fn cancel_pairing(state);
  #[tauri::command] fn forget_device(device_key: String, state) -> Result<(), String>;
  // AppState
  pub fn set_paired(&mut self, devices: Vec<PairedDevice>);
  pub fn set_pairing(&mut self, view: Option<PairingView>);
  pub const PAIR_NOTICE_MS: u64 = 5_000;
  ```
  - `HubEvent::DevicePaired` → `pairing = None`, `pair_notice = "«{device_name}» emparejado"`
    durante 5 s y se recarga `set_paired(hub.paired_devices())`.
  - `snapshot(now_ms)` omite `pairing` si `now_ms >= expires_at_ms`.
  - `connected` es true si hay un peer con esa `device_key`.
  - `start_pairing` llama a `hub.start_pairing()`, `pairing_uri(hub.public_key(), token, pc_name, lan_ipv4s(), DEFAULT_TCP_PORT)` y `qr_svg`.
  - `discovery::advertise(port, fp)`: TXT `[("v","2"), ("fp", fp)]`.
  - `lib.rs`:
    - `identity::load_or_create(data_dir)`.
    - `PairedStore::load(data_dir.map(|d| d.join("paired.json")))`.
    - `fingerprint` de la pública para mDNS.
    - Comandos nuevos en `generate_handler!`.

- [ ] **Step 1: Escribir los tests** de la lógica pura de `app/mod.rs`:
  - `DevicePaired` cierra `pairing` y pone el aviso.
  - El aviso desaparece a los 5 s.
  - `snapshot` sin `pairing` cuando ya caducó.
  - `connected` refleja los peers.
  - `PeerDisconnected { reason: "forgotten" }` quita el peer.
- [ ] **Step 2: Verificar que fallan** — `cargo test … app::` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Verificar** → PASS. Con `pnpm --filter @clipsync/desktop tauri dev`, en stderr
  aparece el anuncio mDNS con `fp`; `~/.local/share/<identificador>/identity.key` existe con
  permisos `-rw-------`.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): identidad, emparejamiento y huella mDNS en la app"`

---

### Task 10: App de PC — interfaz de emparejamiento

**Files:**
- Modify: `apps/desktop/src/types.ts`, `apps/desktop/src/render.ts`, `apps/desktop/src/render.test.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `UiState.paired/pairing/pairNotice` y los comandos de la Tarea 9.
- Produces: `render(root: HTMLElement, state: UiState, nowMs = Date.now()): void`.

Contenido (spec §5):
- **Estado sin emparejados**: «Pulsa «Emparejar móvil» y escanea el QR con ClipSync en el
  móvil». Con emparejados y sin conexión se mantiene el texto de la fase 1.
- **Botón «Emparejar móvil»**: invoca `start_pairing`; un error va al aviso existente.
- **Panel del QR**:
  - El QR va como `<img alt="Código QR de emparejamiento">` con
    `src="data:image/svg+xml;charset=utf-8," + encodeURIComponent(qrSvg)`, nunca con
    `innerHTML`.
  - Texto «Escanéalo con ClipSync en el móvil» y cuenta atrás «Caduca en m:ss».
  - Botón «Cancelar» (`cancel_pairing`).
  - `main.ts` vuelve a pintar cada segundo mientras haya `pairing`.
- **Dispositivos emparejados**:
  - Cada fila lleva el nombre, «Conectado» si `connected` y el botón «Olvidar» con
    `data-device-key`.
  - Al pulsarlo, `ask("¿Olvidar «{nombre}»? Tendrá que volver a escanear el QR.", { title: "ClipSync", kind: "warning" })`
    de `@tauri-apps/plugin-dialog` y, si acepta, `forget_device`.
  - Lista vacía: «Ningún móvil emparejado».
- **`pairNotice`**: se muestra como aviso, con el mismo estilo que `clipNotice`.

- [ ] **Step 1: Escribir los tests de `render`**
  ```ts
  test('sin emparejados ni peers: texto que invita a emparejar', () => {});
  test('pairing: img con src data:image/svg+xml y «Caduca en 4:59» con nowMs = expiresAtMs - 299_000', () => {});
  test('pairing con «<script>» en el SVG: no se crea ningún <script> en el DOM', () => {});
  test('emparejados: una fila por dispositivo con «Olvidar» y data-device-key; «Conectado» solo si connected', () => {});
  test('lista vacía → «Ningún móvil emparejado»', () => {});
  test('pairNotice visible', () => {});
  ```
- [ ] **Step 2: Verificar que fallan** — `pnpm --filter @clipsync/desktop test` → FAIL.
- [ ] **Step 3: Implementar** `render.ts`, `main.ts`, `types.ts` y los estilos (el QR, de 240 px
  como mínimo, sobre fondo blanco también en tema oscuro).
- [ ] **Step 4: Verificar** → PASS; `pnpm --filter @clipsync/desktop build` sin errores de
  tipos; con `tauri dev`, pulsar «Emparejar móvil» y comprobar que el QR se ve y lo lee la
  cámara de cualquier móvil (texto `clipsync://pair?...`). Sin capturas de pantalla del
  escritorio de Javier: se comprueba con él.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): QR de emparejamiento y lista de dispositivos"`

---

### Task 11: App móvil — identidad, emparejamiento y conexión cifrada

**Files:**
- Modify: `apps/mobile/package.json` y `app.json`:
  - Dependencias: `npx expo install expo-camera expo-secure-store`.
  - Plugin `["expo-camera", { "cameraPermission": "ClipSync usa la cámara para escanear el código QR del PC.", "recordAudioAndroid": false }]`.
  - Permiso `android.permission.CAMERA`.
- Modify: `src/lib/settings.ts`, `src/lib/pcAddress.ts`, `src/lib/discovery.ts` (`resolvedPcs(timeoutMs, fp)`), `src/lib/connectionPolicy.ts`, `src/lib/connection.ts`
- Create: `src/lib/identity.ts`, `src/lib/pairing.ts`, `test/pairing.test.ts`
- Modify: `test/pcAddress.test.ts`, `test/connectionPolicy.test.ts`

**Interfaces:**
- Consumes: `Session` (Tarea 6), `parsePairingUri`, `fingerprint`, `PairingInfo` (Tarea 5),
  `keyPairFromPrivate`.
- Produces:
  ```ts
  // identity.ts — SecureStore, clave 'clipsync_identity', valor 64 hex; se crea con Crypto.getRandomBytes(32)
  export function loadIdentity(): Promise<KeyPair>;          // en caché tras la primera vez
  // pairing.ts (puro)
  export interface PairedPc { publicKeyHex: string; name: string; ips: string[]; port: number; token: string | null }
  export function pairedPcFromInfo(info: PairingInfo): PairedPc;
  export function parsePairedPc(raw: unknown): PairedPc | null;   // valida lo leído de settings.json
  // settings.ts
  interface Settings { /* … fase 1 … */ pc: PairedPc | null }
  // pcAddress.ts
  export function servicePcs(service: ResolvedService, fp: string): PcAddress[];  // [] si txt.fp falta o difiere
  export function connectCandidates(last: PcAddress | null, resolved: PcAddress[], qr: PcAddress[]): PcAddress[];
  // connectionPolicy.ts
  export const MAX_HANDSHAKE_FAILURES = 3;
  export type CloseOutcome = { kind: 'retry'; handshakeFailures: number } | { kind: 'unpair'; message: string };
  export function closeOutcome(reason: string, ctx: { tokenSent: boolean; handshakeFailures: number }): CloseOutcome;
  // connection.ts
  export type ConnStatus = 'unpaired' | 'searching' | 'connecting' | 'connected';
  interface ConnState { /* … */ pc: { name: string; pairing: boolean } | null }
  class ConnectionManager {
    pair(info: PairingInfo): void;   // guarda pc con token, lastSyncedHash = null y lastPc = null; this.keeper = null
                                     // (el SyncKeeper se recrea desde settings) y reinicia el bucle
    forgetPc(): void;                // cierra la sesión, borra pc, status 'unpaired'
  }
  ```
- Mensajes de `closeOutcome` (D8):

  | Motivo | Contexto | Resultado |
  |---|---|---|
  | `not_paired` | con token | «El QR no es válido. Genera uno nuevo en el PC.» |
  | `not_paired` | sin token | «Este PC no te reconoce. Vuelve a emparejar.» |
  | `pairing_expired` | — | «QR caducado. Genera uno nuevo en el PC.» |
  | `handshake_failed` | 3.º seguido | «No se pudo verificar el PC. Vuelve a emparejar.» |
  | `handshake_failed` | antes del 3.º | `retry` con el contador + 1 |
  | otro motivo | — | `retry` con el contador sin cambios |

  `ready` pone el contador a 0.
- **Ciclo**:
  - Sin `pc`: `status: 'unpaired'` y el bucle no corre.
  - Candidatos: la última dirección, después mDNS filtrado por `fingerprint(pk)` y después las
    IPs del QR con su `port`; si no, USB.
  - `Session` con `identity`, `serverKey`, `pairingToken: pc.token` y `randomBytes: Crypto.getRandomBytes`.
  - En `ready` con token: se guarda `pc.token = null`.
  - Con token pendiente, si una vuelta entera no conecta con ningún candidato:
    `lastError = «PC no alcanzable. Comprueba que el móvil y el PC están en la misma red WiFi.»`
    y se sigue reintentando.
  - Si `closeOutcome` da `unpair`: `pc = null`, `status: 'unpaired'`, `lastError = message`.
  - En `__DEV__`, `console.log` de los ms desde el enlace abierto hasta `ready` (para la
    Tarea 13).

- [ ] **Step 1: Escribir los tests** (vitest del móvil, solo módulos puros)
  ```ts
  test('servicePcs: fp igual → direcciones; fp distinto o ausente → []', () => {});
  test('connectCandidates: última, mDNS y QR, sin repetir y en ese orden', () => {});
  test('parsePairedPc: válido; clave de 63 hex → null; port fuera de rango → null; token opcional', () => {});
  test('pairedPcFromInfo pasa la clave a hex y conserva token, ips y port', () => {});
  test.each([...])('closeOutcome(%s)', () => { /* cada fila de la tabla de arriba */ });
  ```
- [ ] **Step 2: Verificar que fallan** — `pnpm --filter @clipsync/mobile test` → FAIL.
- [ ] **Step 3: Implementar** los módulos.
- [ ] **Step 4: Verificar** — test, `tsc --noEmit` y lint del móvil sin errores.
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): identidad, emparejamiento y conexión cifrada con el PC"`

---

### Task 12: App móvil — bienvenida, escáner QR y ajustes

**Files:**
- Create: `apps/mobile/src/app/scan.tsx`, `apps/mobile/src/components/Welcome.tsx`
- Modify: `apps/mobile/src/app/index.tsx`, `apps/mobile/src/app/settings.tsx`, `apps/mobile/src/components/StatusCard.tsx`

**Interfaces:**
- Consumes: `connection.pair/forgetPc`, `ConnState.pc`, `status 'unpaired'` (Tarea 11),
  `parsePairingUri`.

Contenido (spec §6):
- **`index.tsx`**: con `status === 'unpaired'` muestra `Welcome`:
  - Título «Empareja ClipSync con tu PC».
  - Pasos: «1. Abre ClipSync en el PC y pulsa «Emparejar móvil». 2. Escanea el QR.».
  - `lastError` si lo hay.
  - Botón «Escanear QR del PC» (`router.push('/scan')`).

  Si no, la pantalla de la fase 1.
- **`StatusCard`**: con `pc.pairing`, «Emparejando con {pc.name}…».
- **`scan.tsx`**:
  - Usa `useCameraPermissions`. Sin permiso: «ClipSync necesita la cámara para leer el QR» y el
    botón «Permitir cámara»; si se denegó para siempre, «Abrir ajustes» (`Linking.openSettings()`).
  - `CameraView` con `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` y un `onBarcodeScanned`
    que ignora lecturas mientras procesa una.
  - Si `parsePairingUri` da `null`: «Este QR no es de ClipSync» y se vuelve a escanear a los 2 s.
  - Si ya hay otro PC emparejado, `Alert` «Ya estás emparejado con «{actual}». ¿Sustituirlo por
    «{nuevo}»?» (Cancelar / Sustituir).
  - Después: `connection.pair(info)` y `router.back()`.
- **`settings.tsx`**: sección «PC emparejado» con el nombre o «Ninguno». Botones:
  - «Olvidar»: `Alert` «¿Olvidar «{nombre}»? Tendrás que volver a escanear el QR.» y después
    `forgetPc`.
  - «Emparejar otro PC»: a `/scan`.

- [ ] **Step 1: Implementar** las pantallas y componentes.
- [ ] **Step 2: Verificar** — `tsc --noEmit` y lint del móvil sin errores.
- [ ] **Step 3: Compilar e instalar en el móvil de Javier** (nuevo módulo nativo: hace falta
  prebuild): `pnpm --filter @clipsync/mobile android`. La app abre en la bienvenida sin errores
  rojos y la cámara pide permiso.
- [ ] **Step 4: Commit** — `git commit -m "feat(mobile): bienvenida, escáner QR y PC emparejado en ajustes"`

---

### Task 13: Rendimiento, comprobación real y documentación

**Files:**
- Modify: `docs/testing-checklist.md`, `README.md`, `docs/superpowers/specs/2026-10-16-clipsync-v2-design.md` (§3.2–3.3 con D1–D11), `docs/superpowers/plans/2026-10-17-clipsync-v2-fase2-emparejamiento.md` (resultados de la medida, al final)

- [ ] **Step 1: Añadir a `docs/testing-checklist.md`** una sección «Emparejamiento y cifrado»:
  - [ ] emparejar con el QR (primera vez, con permiso de cámara);
  - [ ] cerrar y abrir las dos apps: reconecta sin QR;
  - [ ] QR caducado (esperar 5 min) → «QR caducado»;
  - [ ] el mismo QR en un segundo móvil (si lo hay) → rechazado;
  - [ ] «Olvidar» en el PC con el móvil conectado → el móvil vuelve a la bienvenida con «Este
    PC no te reconoce»;
  - [ ] «Olvidar» en el móvil → bienvenida; el PC sigue listándolo hasta que Javier lo olvide;
  - [ ] borrar `identity.key` en el PC y reiniciarlo → el móvil, al tercer intento, muestra «No
    se pudo verificar el PC»;
  - [ ] con el PC sin mDNS (otra subred o cortafuegos), conecta por la IP del QR;
  - [ ] texto y foto de 5 MB en ambos sentidos, ya cifrados.
- [ ] **Step 2: Medir** (spec §9) en el móvil de Javier, por WiFi:
  - el tiempo del handshake (registro `__DEV__` de la Tarea 11, media de 5 conexiones);
  - un archivo de 50 MB móvil → PC y PC → móvil, con cronómetro.

  Anotar MB/s y ms al final de este plan, junto a la cifra de `bench` de la Tarea 2.
  **Criterio**: handshake ≤ 1 s y ≥ 2 MB/s en los dos sentidos. Si no se cumple, se apunta como
  seguimiento («ChaCha20/X25519 nativos sin cambiar el protocolo») y no bloquea la fase.
- [ ] **Step 3: Recorrer la lista con Javier** (también la de la fase 1 si sigue pendiente).
  Cada fallo se trata con superpowers:systematic-debugging y su arreglo lleva un test.
- [ ] **Step 4: Documentación**:
  - `README.md`: emparejamiento por QR ✅, cifrado Noise IK ✅, y cómo emparejar.
  - Spec: §3.2–3.3 con D1–D11, y en la fase 2 de §12 una línea con el resultado de la medida.
- [ ] **Step 5: Verificación final** — los cinco comandos de prueba de Global Constraints, el
  lint y el `tsc` del móvil: todo en verde.
- [ ] **Step 6: Commit** — `git commit -m "docs: emparejamiento y cifrado de la fase 2, medidas y lista de comprobación"`
