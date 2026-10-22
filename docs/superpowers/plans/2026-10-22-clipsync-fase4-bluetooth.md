# ClipSync — Fase 4: Bluetooth — Plan de implementación

> **For agentic workers:** modo barato (decisión de Javier): un implementador Sonnet por bloque, sin
> revisión por tarea, y una sola revisión final. Pasos con checkbox (`- [ ]`).

**Goal:** que el móvil se conecte al PC por Bluetooth Classic (RFCOMM) cuando no hay WiFi ni cable,
con el mismo canal cifrado Noise IK y el mismo protocolo, y que en la app se pueda fijar el medio
(«Auto / WiFi / USB / Bluetooth»).

**Architecture:** RFCOMM es otro tubo de bytes: el PC escucha con el UUID del servicio y entrega
cada conexión a `Hub::accept_stream(stream, Transport::Bluetooth)`; el móvil abre el socket con un
módulo nativo Kotlin y lo envuelve en un `Link` (`rfcommLink.ts`). Nada por encima de `Link` cambia.
El QR gana `bt` (dirección del adaptador del PC) para que el móvil sepa a qué dispositivo conectar.

**Tech Stack:** Rust `bluer` (BlueZ, Linux), crate `windows` (WinRT `RfcommServiceProvider` +
`StreamSocketListener`, Windows), Kotlin (`BluetoothDevice.createRfcommSocketToServiceRecord`) dentro
de `apps/mobile/modules/clipsync-native`, TS en `packages/protocol` y `apps/mobile`.

**Spec:** `docs/superpowers/specs/2026-10-16-clipsync-v2-design.md` §2 (tabla de medios), §3.3
(QR, campo `bt`), §4 (selección de medio), §5 (`listeners/rfcomm_*`), §6 (módulo nativo, ajustes),
§8–§9. Registros con decisiones vigentes: `docs/superpowers/plans/2026-10-16-clipsync-v2-fase1-registro.md`,
`…-fase2-registro.md`, `…-fase2b-registro.md`.

## Requisito de hardware

**Este PC no tiene adaptador Bluetooth** (`/sys/class/bluetooth` está vacío). Para probar la parte
de Linux hace falta un adaptador USB Bluetooth. Sin él, el PC arranca igual y el medio Bluetooth
queda «no disponible»; el código se verifica con tests y compilación.

## Global Constraints

- Commits a nombre de Javier, **sin** `Co-Authored-By` ni «Generated with». Sin push.
- Comentarios y toda la interfaz en español. Release de Rust con `panic = "abort"`: nada alcanzable
  desde la red puede entrar en pánico; registros con `let _ = writeln!(std::io::stderr(), …)`.
- UUID del servicio RFCOMM: `fd256337-cbf3-43ea-a04f-eed132b4a1d6` (constante `RFCOMM_SERVICE_UUID`
  en `packages/protocol/src/constants.ts` y `protocol/mod.rs`).
- Dirección Bluetooth en el QR: parámetro `bt`, formato `AA:BB:CC:DD:EE:FF` (mayúsculas, 6 octetos);
  si el PC no tiene adaptador, el QR no lo lleva. El parser ignora un `bt` mal formado.
- Selección de medio (spec §4):
  - **Auto** prueba WiFi (2 s) → USB (2 s) → Bluetooth (8 s).
  - Conectado por un medio peor, cada 30 s comprueba uno mejor. Si lo hay, cambia sin cortar un
    archivo en curso: espera a que termine.
  - **Modo fijo** usa solo ese medio y muestra el motivo si falla.
- Ajuste nuevo en el móvil: `transportMode: 'auto' | 'wifi' | 'usb' | 'bluetooth'` (por defecto
  `'auto'`), persistido en `settings.json`.
- `Transport` gana `bluetooth` en TS y `Bluetooth` en Rust (serializado `"bluetooth"`). Texto de la UI:
  «por Bluetooth».
- Permisos Android: `BLUETOOTH_CONNECT` (12+, pedido en tiempo de ejecución al primer uso);
  `BLUETOOTH` y `BLUETOOTH_ADMIN` con `maxSdkVersion 30`. Sin `BLUETOOTH_SCAN`: solo se usan
  dispositivos ya emparejados en el sistema.
- Textos:
  - «Empareja el móvil y el PC en los ajustes de Bluetooth del sistema»;
  - «Bluetooth apagado»;
  - «Este PC no tiene Bluetooth»;
  - «Permite el acceso a Bluetooth para conectar sin WiFi».
- Comandos de prueba (los de la fase 2b), más `cargo check --target x86_64-pc-windows-msvc` para la
  parte de Windows. Hay que instalar el target con `rustup target add`. Si falla por entorno, se anota.

## Review Focus

1. **Sin adaptador o con el Bluetooth apagado**: el PC y el móvil siguen funcionando por WiFi/USB,
   sin bloqueos ni reintentos agresivos.
2. **Cambio de medio con un archivo en curso**: no se corta ni se duplica la sesión (dos sesiones
   del mismo dispositivo → regla `replaced` existente).
3. **Datos fragmentados en RFCOMM**: el `Link` entrega trozos arbitrarios; el framing ya lo admite,
   pero el puente nativo no debe perder ni reordenar bytes.
4. **Permiso `BLUETOOTH_CONNECT` denegado**: se salta Bluetooth en Auto y se avisa en modo fijo.
5. **QR antiguo sin `bt`**: Bluetooth se ofrece eligiendo el PC de la lista de emparejados.

---

### Bloque A: Protocolo y PC Linux

**Files:**
- `packages/protocol/src/constants.ts`, `packages/protocol/src/pairing.ts` (+ tests): `RFCOMM_SERVICE_UUID`, `bt` en `PairingInfo` y `parsePairingUri`/creación del QR.
- `apps/desktop/src-tauri/src/protocol/mod.rs`, `core/pairing.rs` (QR con `bt`), `core/session.rs` (`Transport::Bluetooth`).
- Crear `apps/desktop/src-tauri/src/listeners/mod.rs`, `listeners/rfcomm_linux.rs` (`#[cfg(target_os = "linux")]`).
- `apps/desktop/src-tauri/src/lib.rs` (arranque del listener), `app/mod.rs` (aviso en `UiState`), `apps/desktop/src/render.ts` («por Bluetooth», aviso).

- [ ] **Step 1: Protocolo.**
  - Tests TS y Rust:
    - un QR con `bt` válido se lee;
    - un `bt` mal formado se ignora;
    - un QR sin `bt` sigue valiendo.
  - Implementar.
- [ ] **Step 2: Listener Linux.**
  - `pub async fn serve_rfcomm(hub: Hub) -> Result<(), String>`:
    1. `bluer::Session` y adaptador por defecto.
    2. Registrar un `Profile` RFCOMM con el UUID y rol servidor.
    3. Por cada conexión, `hub.accept_stream(stream, Transport::Bluetooth)`.
  - Sin adaptador o con BlueZ apagado: no hay listener y `UiState.bluetooth_notice` vale
    «Este PC no tiene Bluetooth» o «Bluetooth apagado». Reintento cada 30 s, por si se enchufa
    un adaptador.
  - `bt` del QR = dirección del adaptador si existe.
- [ ] **Step 3: Tests.**
  - Unitario: elección de aviso según el estado del adaptador, con la lógica pura extraída.
  - Integración con `tokio::io::duplex` simulando el stream RFCOMM.
  - Con adaptador real, prueba manual en la Tarea D.
- [ ] **Step 4:** `cargo test`, `cargo build --all-targets` sin warnings, tests TS del protocolo y del escritorio.
- [ ] **Step 5:** `git commit -m "feat: RFCOMM en el PC (Linux) y dirección Bluetooth en el QR"`

### Bloque B: PC Windows

**Files:** crear `apps/desktop/src-tauri/src/listeners/rfcomm_windows.rs` (`#[cfg(windows)]`), `Cargo.toml` (crate `windows` con las features de `Devices_Bluetooth_Rfcomm`, `Networking_Sockets`, `Storage_Streams` solo para `cfg(windows)`).

- [ ] **Step 1:** `serve_rfcomm` para Windows con la misma firma:
  - `RfcommServiceProvider::CreateAsync(RfcommServiceId::FromUuid(UUID))`;
  - `StreamSocketListener` enlazado con `BindServiceNameAsync`, más `StartAdvertising`;
  - cada `StreamSocket` se adapta a `AsyncRead + AsyncWrite` (hilo puente o `tokio::io::duplex`) y se pasa a `accept_stream`.
- [ ] **Step 2:** `cargo check --target x86_64-pc-windows-msvc`. Si no puede ejecutarse aquí, se deja anotado y queda para el CI de la fase 5.
- [ ] **Step 3:** `git commit -m "feat(desktop): RFCOMM en Windows"`

### Bloque C: Móvil

**Files:**
- `apps/mobile/modules/clipsync-native/android/…` (Kotlin):
  - `bondedDevices(): {name, address}[]`;
  - `connect(address, uuid): Promise<number>`, que devuelve un id;
  - `write(id, base64)`;
  - `close(id)`;
  - eventos `onData {id, base64}` y `onClosed {id, error?}`.
  - Lectura en un hilo propio con búfer de 64 KiB. Ni pérdida ni reordenación de bytes.
  - `index.ts` con los tipos.
- Crear `apps/mobile/src/lib/rfcommLink.ts`: `connectRfcomm(address, timeoutMs): Promise<Link>`. Mismo contrato que `tcpLink.ts`: `write` lanza tras el cierre y los bytes escritos se entregan antes de cerrar.
- Crear `apps/mobile/src/lib/transportPolicy.ts` (puro) + test:
  - `candidates(mode, ctx)`: lista ordenada de medios, según si hay `bt`, si hay permiso y si el Bluetooth está encendido;
  - `shouldUpgrade(current, mode, nowConnectedFor)`.
- `apps/mobile/src/lib/connection.ts`:
  - bucle de conexión según `candidates`, con 8 s para Bluetooth;
  - comprobación de medio mejor cada 30 s;
  - el cambio espera a que no haya transferencias en curso;
  - el motivo en modo fijo va en `lastError`.
- `apps/mobile/src/lib/settings.ts`: `transportMode` y `btAddress` (dirección del PC, del QR o elegida de la lista).
- `apps/mobile/app.json`: permisos.

- [ ] **Step 1:** Kotlin con todas las excepciones capturadas y convertidas en `onClosed {error}`. Probar con `./gradlew assembleDebug`.
- [ ] **Step 2:** `transportPolicy` con tests:
  - Auto con todo disponible → `wifi, usb, bluetooth`;
  - sin permiso → sin Bluetooth;
  - modo fijo `bluetooth` sin `bt` → motivo;
  - `shouldUpgrade` desde Bluetooth a WiFi.
- [ ] **Step 3:** `rfcommLink.ts` y el bucle de `connection.ts`.
- [ ] **Step 4:** tsc, lint, tests del móvil; `npx expo prebuild --platform android --no-install` y comprobar los permisos en el manifiesto.
- [ ] **Step 5:** `git commit -m "feat(mobile): conexión por Bluetooth y selección de medio"`

### Bloque D: Interfaz, comprobación y documentación

**Files:**
- `apps/mobile/src/app/index.tsx`, `src/app/settings.tsx`, `src/components/StatusCard.tsx`:
  - selector «Auto / WiFi / USB / Bluetooth» en Ajustes;
  - «Conectado … por Bluetooth»;
  - en Ajustes, «PC por Bluetooth»: la dirección del QR o elegir de los dispositivos emparejados;
  - aviso de permiso con «Abrir ajustes».
- `docs/testing-checklist.md`, `README.md`.

- [ ] **Step 1:** Interfaz con los textos de los Global Constraints.
- [ ] **Step 2:** Lista de comprobación, sección «Bluetooth»:
  - [ ] PC sin adaptador → aviso, y WiFi/USB siguen;
  - [ ] emparejar en el sistema y conectar con el WiFi apagado;
  - [ ] texto y una captura por Bluetooth;
  - [ ] archivo de 5 MB, anotando la velocidad;
  - [ ] encender el WiFi con la sesión por Bluetooth → cambia a WiFi en ≤ 30 s sin cortar un archivo;
  - [ ] modo fijo Bluetooth;
  - [ ] permiso denegado.
- [ ] **Step 3:** Todos los comandos de prueba → verde. `./gradlew assembleRelease` y ofrecer instalarlo en el móvil.
- [ ] **Step 4:** `git commit -m "feat(mobile): selector de medio y lista de comprobación de Bluetooth"`

### Revisión final

Una sola revisión (Sonnet) del rango completo de la fase. Foco: los cinco puntos de Review Focus y
que nada alcanzable desde la red pueda tumbar el PC o el móvil. Después, una tanda única de arreglos
y verificación de tests por el controlador.
