# ClipSync v2 — Diseño

Fecha: 2026-10-16 · Estado: pendiente de revisión

## 1. Objetivo

Dos apps instalables —una en el móvil Android y otra en el PC (Linux y Windows)— que
sincronizan el portapapeles de texto en ambas direcciones y permiten enviar archivos a mano,
conectándose por **WiFi, cable USB o Bluetooth**, sin nube y con cifrado de extremo a extremo
entre dispositivos emparejados.

### Decisiones tomadas con Javier

| Tema | Decisión |
|---|---|
| Móvil | Solo Android. Se elimina el soporte iOS (carpeta `apps/mobile/ios`). |
| PC | Linux y Windows. |
| Portapapeles | Texto, sincronizado automáticamente en ambas direcciones **mientras las dos apps están abiertas**. |
| Segundo plano en el móvil | Sin notificación fija ni servicio en primer plano. Con la app cerrada no se sincroniza. |
| Archivos | Siempre a mano: «Compartir → ClipSync» o botón en el móvil; arrastrar o botón en el PC. |
| App de PC | Ventana normal (sin bandeja ni arranque automático). Cerrar la ventana cierra la app. |
| Seguridad | Emparejamiento por QR y cifrado de todo el tráfico. |
| Bluetooth | Bluetooth Classic (RFCOMM), texto y archivos. Se abandona BLE. |
| USB | La app de PC incluye su propio `adb`. |
| Elección de medio | Automática WiFi → USB → Bluetooth, con opción de fijar uno a mano. |
| Modo Invitado | Se elimina. |
| Distribución | GitHub Actions genera instaladores de Windows, Linux y el `.apk` al subir una etiqueta `vX.Y.Z`. |

### Fuera de alcance

- Imágenes u otros formatos de portapapeles distintos de texto.
- Sincronización con la app del móvil cerrada o en segundo plano (ver §9).
- Varios PCs emparejados con el mismo móvil a la vez (el móvil guarda un único PC; emparejar
  otro sustituye al anterior). El PC sí admite varios móviles emparejados.
- Compatibilidad con el protocolo v1 actual.

## 2. Arquitectura general

```
 Móvil (cliente, siempre inicia)                 PC (servidor, siempre escucha)
 ┌──────────────────────────────┐                ┌──────────────────────────────┐
 │ UI (Expo Router)             │                │ UI (Tauri webview, TS)       │
 │ ClipboardWatcher             │                │ ClipboardWatcher (arboard)   │
 │ Session  ←→ mensajes         │                │ Session  ←→ mensajes         │
 │ SecureChannel (Noise IK)     │   bytes        │ SecureChannel (Noise IK)     │
 │ Framer (longitud + datos)    │ ◄────────────► │ Framer                       │
 │ Link: TCP | RFCOMM           │                │ Listeners: TCP | RFCOMM      │
 │ TransportSelector            │                │ AdbWatcher (adb reverse)     │
 └──────────────────────────────┘                └──────────────────────────────┘
```

Principio central: **los tres medios son tubos de bytes** y por todos viaja el mismo
protocolo. Nada por encima de `Link` sabe por dónde van los datos.

| Medio | Cómo llega el móvil al PC | Escucha en el PC |
|---|---|---|
| WiFi | TCP a `IP_del_PC:52847` (IP por mDNS o la última conocida) | TCP `0.0.0.0:52847` |
| USB | TCP a `127.0.0.1:52847` en el móvil; `adb reverse tcp:52847 tcp:52847` lo lleva al PC | el mismo listener TCP |
| Bluetooth | RFCOMM a la dirección Bluetooth del PC, servicio `fd256337-cbf3-43ea-a04f-eed132b4a1d6` | listener RFCOMM con ese UUID |

Bluetooth requiere que móvil y PC estén emparejados una vez en los ajustes de Bluetooth del
sistema operativo (además del emparejamiento propio de ClipSync).

## 3. Protocolo (versión 2)

### 3.1 Framing

Cada trama: `u16` big-endian con la longitud + datos. Máximo 65 535 bytes por trama (el límite
de un mensaje Noise). El framing es idéntico en todos los medios.

### 3.2 Canal seguro — `Noise_IK_25519_ChaChaPoly_SHA256`

Se implementa el patrón estándar IK del [Noise Protocol Framework](https://noiseprotocol.org/noise.html),
sin variantes propias:

- **Rust**: crate `snow`.
- **TypeScript**: implementación del estado de handshake de Noise sobre primitivas auditadas
  (`@noble/curves` X25519, `@noble/ciphers` ChaCha20-Poly1305, `@noble/hashes` SHA-256/HKDF).
  Se valida con vectores de prueba generados por `snow` (ver §10), así que si difiere en un
  solo byte del estándar, los tests fallan.

Cada dispositivo tiene un par de claves X25519 permanente (su identidad):

- PC: archivo `identity.key` en el directorio de datos de la app (permisos `600` en Linux).
- Móvil: `expo-secure-store` (respaldado por Android Keystore).

El móvil es el iniciador y conoce la clave pública del PC (por el QR). En el primer mensaje del
handshake el móvil envía su clave pública cifrada y una carga útil JSON:

```json
{ "v": 2, "deviceId": "…", "deviceName": "Pixel 8", "pairingToken": "…opcional…" }
```

El PC decide al terminar el handshake:

1. La clave del móvil está en `paired.json` → acepta.
2. No está, pero `pairingToken` coincide con el token vigente → la añade a `paired.json`,
   invalida el token y acepta.
3. En cualquier otro caso → responde `{ "accepted": false, "reason": "not_paired" }` y cierra.

Segundo mensaje (PC → móvil): `{ "v": 2, "accepted": true, "pcName": "…" }`.

### 3.3 Emparejamiento por QR

En el PC, «Emparejar móvil» genera un token aleatorio de 128 bits, válido **5 minutos y un
solo uso**, y muestra un QR con:

```
clipsync://pair?v=2&pk=<clave pública PC, base64url>&t=<token>&n=<nombre PC>
               &ip=<IPs LAN separadas por coma>&port=52847&bt=<dirección BT, si hay adaptador>
```

El móvil lo escanea (`expo-camera`), guarda `pk`, `n`, `ip`, `port` y `bt`, y conecta enviando el
token. Si el emparejamiento falla se muestra el motivo («QR caducado», «PC no alcanzable»…).

### 3.4 Mensajes de sesión

Tras el handshake, cada trama cifrada contiene 1 byte de tipo y el contenido:

| Tipo | Contenido | Dirección |
|---|---|---|
| `0x01` JSON | mensaje de control (abajo) | ambas |
| `0x02` datos de archivo | `transferId` (16 bytes) + bytes crudos (≤ 48 KiB) | emisor → receptor |

Mensajes de control (`kind`):

| `kind` | Campos | Uso |
|---|---|---|
| `clip` | `id`, `text` (≤ 1 MiB UTF-8), `hash` | nuevo texto copiado |
| `file_start` | `transferId`, `name`, `size`, `mime`, `sha256` | empieza un archivo |
| `file_ack` | `transferId`, `received` | el receptor confirma cada 1 MiB |
| `file_end` | `transferId` | el emisor terminó de enviar |
| `file_result` | `transferId`, `ok`, `error?` | el receptor verificó el SHA-256 y guardó (o no) |
| `file_cancel` | `transferId`, `reason` | cualquiera de los dos cancela |
| `ping` / `pong` | — | latido cada 10 s; sin respuesta en 30 s → sesión caída |

Control de flujo: el emisor no deja más de 2 MiB sin confirmar. Se transfiere un archivo
a la vez por sesión; los siguientes esperan en cola.

### 3.5 Sincronización del portapapeles

- Cada lado consulta su portapapeles cada 500 ms mientras la app está abierta.
- Se guarda por cada par `lastSyncedHash`: el SHA-256 del último texto enviado o recibido.
  Un texto cuyo hash coincide no se envía, y así se evitan los rebotes.
- Al recibir `clip`, se escribe en el portapapeles, se actualiza `lastSyncedHash` y se
  añade al historial.
- **Al empezar una sesión**, cada lado envía su portapapeles actual si difiere de
  `lastSyncedHash`. Si los dos cambiaron, gana el del móvil (quien acaba de abrir la app
  quiere enviar). El texto del PC no se pierde: queda en el historial del PC.

## 4. Selección de medio (móvil)

- **Modo automático** (por defecto): prueba WiFi → USB → Bluetooth, con un tiempo de
  espera de 2 s por medio para WiFi y USB y de 8 s para Bluetooth, y se queda con el primero
  que complete el handshake.
  - WiFi: la IP la da mDNS (servicio `_clipsync._tcp`, con TXT `fp=<8 primeros bytes del
    SHA-256 de la clave del PC, hex>` para reconocer al PC emparejado); si mDNS no responde,
    se prueban las IPs guardadas del QR.
  - Si se conecta por un medio de menor prioridad, cada 30 s comprueba si hay uno mejor y,
    si lo hay, abre la nueva sesión y cierra la vieja (sin perder un archivo en curso: el
    cambio espera a que termine).
- **Modo fijo**: el usuario elige WiFi, USB o Bluetooth y solo se usa ese.
- Sin sesión: reintento cada 5 s mientras la app está en primer plano.
- La UI muestra siempre el estado («Conectado por USB», «Buscando…») y el medio.

## 5. App de PC (`apps/desktop`, Tauri 2 + Rust + TypeScript sin framework)

### Módulos Rust

| Módulo | Responsabilidad |
|---|---|
| `identity.rs` | crea/carga la clave permanente; nombre del PC |
| `pairing.rs` | token de emparejamiento, `paired.json`, QR (crate `qrcode` → SVG) |
| `framing.rs` | tramas con longitud |
| `secure.rs` | handshake y canal Noise (`snow`) |
| `session.rs` | mensajes, latidos, transferencias, eventos hacia la UI |
| `listeners/tcp.rs` | listener TCP |
| `listeners/rfcomm_linux.rs` | RFCOMM vía BlueZ (crate `bluer`, perfil con el UUID del servicio) |
| `listeners/rfcomm_windows.rs` | RFCOMM vía WinRT (crate `windows`: `RfcommServiceProvider` + `StreamSocketListener`) |
| `discovery.rs` | anuncio mDNS `_clipsync._tcp` con TXT `fp` |
| `clipboard.rs` | sondeo de `arboard` (con la feature `wayland-data-control` en Linux) |
| `adb.rs` | localizar `adb` (sistema primero; si no, el incluido), `adb reverse` cada 5 s |
| `files.rs` | guardar en Descargas (`dirs`), nombres sin colisión «nombre (1).ext» |

Los listeners entregan a `session` un stream genérico (`AsyncRead + AsyncWrite`), así que la
sesión no sabe de qué medio viene.

Se usa primero el `adb` del sistema para no matar un servidor `adb` de otra versión que el
usuario ya tenga en marcha; el incluido (platform-tools oficiales de Google, en
`bundle.resources`) solo se usa si no hay ninguno.

### Interfaz (una sola ventana)

- **Estado**: «Conectado con Pixel 8 por WiFi» / «Esperando al móvil».
- **Emparejar móvil**: muestra el QR con una cuenta atrás de 5 minutos.
- **Historial**: últimos 50 elementos (texto o archivo, dirección, hora); clic en un texto lo
  copia al portapapeles.
- **Enviar archivo**: zona para soltar y botón «Elegir archivo» (`tauri-plugin-dialog`), con
  barra de progreso y botón de cancelar.
- **Dispositivos emparejados**: lista con botón «Olvidar».
- **Avisos**: Bluetooth apagado o sin adaptador; `adb` sin permisos (Linux: reglas udev) o
  móvil «sin autorizar» (aceptar la depuración USB en el móvil); en Windows, driver USB ausente.

Se elimina el ejemplo `greet` y los assets de plantilla de Tauri.

## 6. App de móvil (`apps/mobile`, Expo + dev build, solo Android)

### Módulos

| Módulo | Responsabilidad |
|---|---|
| `lib/identity.ts` | clave permanente en `expo-secure-store`, `deviceId` |
| `lib/pairing.ts` | parseo del QR, datos del PC emparejado |
| `lib/links/tcpLink.ts` | `react-native-tcp-socket` (WiFi y USB) |
| `lib/links/rfcommLink.ts` | envoltorio del módulo nativo Bluetooth |
| `lib/transportSelector.ts` | §4 |
| `lib/session.ts` | usa el código común de `packages/protocol` |
| `lib/clipboardWatcher.ts` | `expo-clipboard`, sondeo solo con `AppState` activo |
| `lib/files.ts` | leer archivos a enviar; guardar los recibidos |
| `modules/clipsync-bluetooth` | **módulo nativo Expo propio (Kotlin)**: lista dispositivos emparejados en el sistema, `createRfcommSocketToServiceRecord(UUID)`, conectar, leer/escribir bytes |

Se escribe un módulo nativo propio para RFCOMM en vez de usar `react-native-bluetooth-classic`
porque esa librería está orientada a texto con delimitadores y el protocolo es binario; el
módulo propio son unas 150 líneas de Kotlin con un comportamiento controlado.

Recepción de archivos: la primera vez se pide al usuario elegir una carpeta (sugerida:
Descargas) con el selector del sistema (SAF, API nueva de `expo-file-system`); el permiso queda
guardado. La escritura es por trozos, sin cargar el archivo entero en memoria.

«Compartir → ClipSync»: la app se registra como destino de compartir (`expo-share-intent`);
al recibir un archivo abre la app, conecta y lo envía.

### Interfaz

- **Sin emparejar**: pantalla de bienvenida con «Escanear QR del PC».
- **Principal**: estado y medio, selector «Auto / WiFi / USB / Bluetooth», botón «Enviar
  archivo», transferencia en curso con progreso, historial (tocar un texto lo copia).
- **Ajustes**: PC emparejado (con «Olvidar»), carpeta de recepción, dispositivo Bluetooth del PC
  (rellenado desde el QR; si no, elegir de la lista de emparejados del sistema).

### Permisos Android

`INTERNET`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `CAMERA`,
`BLUETOOTH_CONNECT` (Android 12+), y `BLUETOOTH`/`BLUETOOTH_ADMIN` solo hasta API 30.
Se pide cada permiso al usarlo por primera vez.

### Lo que se elimina

`ios/`, `guestServer.ts`, `bleTransport.ts`, `react-native-ble-plx`, el modal del Modo Invitado,
y `bluetooth.rs` (BLE) en el PC. `GUEST_MODE_PORT` desaparece de las constantes.

## 7. Código compartido (`packages/protocol`)

Pasa de contener solo tipos a ser la **implementación TypeScript** del protocolo, ejecutable en
Node para poder testearla: framing, Noise IK, mensajes de sesión, codificación del QR, cálculo
de `fp`. La app móvil la importa; Rust la replica en `apps/desktop/src-tauri`. El esquema JSON se
actualiza a la v2. Los vectores de prueba compartidos viven en `packages/protocol/test-vectors/`.

## 8. Manejo de errores

| Situación | Comportamiento |
|---|---|
| Sesión caída (latido, socket cerrado) | móvil: vuelve a §4; PC: vuelve a esperar. La transferencia en curso se marca fallida y se puede reintentar. |
| Handshake rechazado (`not_paired`) | móvil: «Este PC no te reconoce. Vuelve a emparejar.» y pantalla de escaneo. |
| Clave del PC distinta a la guardada | el PC no puede descifrar el primer mensaje y cierra. El móvil no distingue esto de un corte, así que tras 3 handshakes fallidos seguidos con el PC alcanzable muestra «No se pudo verificar el PC. Vuelve a emparejar.» |
| SHA-256 de archivo no coincide | se borra el archivo parcial y `file_result ok=false`; aviso en ambas UIs. |
| Texto > 1 MiB | no se sincroniza; aviso «Texto demasiado grande». |
| Sin Bluetooth / sin `adb` / sin permisos | ese medio se salta en modo automático; en modo fijo se muestra el motivo. |
| Trama malformada o descifrado fallido | se cierra la sesión (no se intenta recuperar dentro de un canal Noise). |

## 9. Limitaciones (a reflejar en la documentación)

- Android 10+ solo deja leer el portapapeles a la app en primer plano: lo copiado en el móvil
  se envía al abrir ClipSync. Esto corrige `docs/architecture.md` §0, que da a entender que un
  servicio en primer plano bastaría.
- Con la app del móvil en segundo plano la conexión se mantiene solo lo que Android permita;
  al volver se reconecta y se aplica §3.5.
- Bluetooth Classic: ~100–300 KB/s reales; adecuado para texto y archivos de pocos MB.
- **Riesgo de rendimiento**: el cifrado en JavaScript (Hermes) puede limitar la velocidad por
  WiFi/USB a unos pocos MB/s. Se mide en la fase 2; si es insuficiente, se sustituye ChaCha20 por
  una implementación nativa sin cambiar el protocolo.
- **Riesgo en Wayland**: la lectura del portapapeles en segundo plano depende de que el
  compositor soporte `wlr-data-control`/`ext-data-control`. Se comprueba en el escritorio de
  Javier (Pop!_OS) en la fase 1.

## 10. Pruebas

- **TypeScript** (`packages/protocol`, vitest): framing, mensajes, QR, Noise contra vectores
  generados por `snow` con efímeras fijas.
- **Rust** (`cargo test`): framing, sesión, emparejamiento, archivos (directorio temporal),
  y los mismos vectores compartidos.
- **Extremo a extremo** (`pnpm test:e2e`, también en CI): servidor Rust sin interfaz (ejemplo de
  cargo) + cliente Node de `packages/protocol` por TCP local: emparejar, intercambiar `clip` en
  ambos sentidos, enviar un archivo de 5 MB y verificar el hash, rechazar un dispositivo no
  emparejado.
- **Manual en el móvil real**, por cada fase: lista de comprobación por medio (WiFi, USB,
  Bluetooth) en `docs/testing-checklist.md`.

## 11. Distribución

Workflow `.github/workflows/release.yml`, disparado por etiquetas `v*`:

- **Linux** (ubuntu-22.04) y **Windows** (windows-latest) con `tauri-action`: `.deb`, AppImage,
  `.msi` y `.exe` (NSIS). Un paso previo descarga platform-tools de Google para cada SO.
- **Android**: `expo prebuild` + `./gradlew assembleRelease` firmado con un keystore guardado
  en los secretos del repo (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
- Todo se sube a una release en **borrador**; Javier la publica.
- Workflow `ci.yml` en cada push: tests TS, `cargo test`, e2e y lint.

Requisito previo: el repo debe pasar a privado (hoy es público); los minutos de Actions
gratuitos en privado (2000/mes) son suficientes.

## 12. Fases de implementación

Cada fase termina con algo usable y probado en el móvil real.

1. **Sesión bidireccional por WiFi**: framing, mensajes, sincronización de portapapeles y
   archivos en ambos sentidos, interfaz nueva de las dos apps, retirada del Modo Invitado,
   BLE e iOS. Sin QR todavía: el móvil encuentra el PC por mDNS (`_clipsync._tcp`) y
   conecta en claro. Las tramas ya llevan el byte de tipo, así que el cifrado se intercala
   en la fase 2 sin cambiar los mensajes.
2. **Emparejamiento por QR y cifrado Noise IK**, con vectores de prueba y e2e.
3. **USB**: `adb` incluido, avisos de permisos/driver, selección automática WiFi → USB.
4. **Bluetooth Classic**: módulo nativo Android, listeners RFCOMM de Linux y Windows,
   selector completo y modo fijo.
5. **Distribución**: workflows de CI y release, keystore, documentación final
   (`docs/architecture.md` y `README.md` reescritos para la v2).
