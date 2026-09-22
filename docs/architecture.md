# Arquitectura — Portapapeles Universal P2P (ClipSync)

> Nota de naming: el codename interno del repo/monorepo sigue siendo `portapapeles-universal-p2p` (así se llama en GitHub y en `package.json` raíz). El nombre comercial de las apps es **ClipSync** (ver `apps/mobile/app.json` y `apps/desktop/src-tauri/tauri.conf.json`). Este documento usa ambos indistintamente según el contexto.

## 0. Restricciones críticas de plataforma (leer primero)

- **Android 10+**: el acceso al portapapeles en background está bloqueado salvo que la app esté en foreground, tenga el foco de la ventana, o corra como foreground service con notificación persistente.
- **iOS 14+**: leer el portapapeles sin un "paste" explícito del usuario dispara un banner del sistema; el acceso en background también está restringido.
- **iOS + Bluetooth Classic**: sin acceso de terceros a RFCOMM/SPP salvo certificación MFi. El fallback de Bluetooth Classic para archivos **solo es viable en Android**; iOS queda limitado a BLE (bajo throughput, impracticable para archivos grandes).
- **Modo Invitado (Fase 5)**: al ser HTTP plano sin cliente en el otro extremo, sacrifica el modelo de cifrado end-to-end del resto del sistema (ver §6). Es un modo explícito y acotado en el tiempo, nunca un fallback automático.

Consecuencia: no hay sincronización 100% silenciosa. Se requiere uno de: app en foreground, foreground service con notificación (Android), disparo manual (share extension, widget, tap), o —en Modo Invitado— una acción explícita del usuario para exponer el servidor HTTP temporal.

## 1. Hoja de ruta de transportes (fallback dinámico)

La app "todoterreno" no elige un único medio: prueba medios en orden de preferencia (mejor throughput/seguridad primero) y cae al siguiente si el anterior no está disponible. Cada fase de desarrollo añade un medio a ese triaje, salvo la Fase 5, que es un modo manual y no forma parte del fallback automático.

| Fase | Medio | Cuándo se usa | Estado |
|---|---|---|---|
| **2** | WiFi/LAN — mDNS + TCP | Ambos dispositivos en la misma red local; caso por defecto y de mejor rendimiento | ✅ Implementado (`LanTransport`) |
| **3** | Cable USB — túnel ADB | Sin red compartida pero con cable disponible (ej. WiFi corporativo con aislamiento de clientes) | 🔜 Pendiente |
| **4** | Bluetooth — BLE / Classic | Sin red ni cable, en movilidad (ej. exteriores, coche) | 🔜 Pendiente |
| **5** | Modo Invitado — servidor HTTP efímero | El **PC no puede** (o no debe) instalar el cliente Tauri — equipos públicos, de empresa con permisos restringidos, kioscos | ✅ Implementado (`guestServer.ts`), modo manual (no entra en el triaje automático) |

El triaje automático (Fases 2–4) vive en el móvil como una cadena de intentos: LAN → USB → Bluetooth. El Modo Invitado (Fase 5) es una acción explícita del usuario ("no encuentro mi PC / no puedo instalar nada ahí") y se lanza desde una pantalla separada, no desde el flujo de auto-descubrimiento — ver §6.

## 2. Stack

### Móvil — Expo (React Native, `apps/mobile`)

| Necesidad | Librería | Fase |
|---|---|---|
| Clipboard | `expo-clipboard` | todas |
| mDNS/ZeroConf | `react-native-zeroconf` | 2 |
| TCP sockets (cliente y servidor — LAN, túnel USB, y el propio servidor HTTP del Modo Invitado) | `react-native-tcp-socket` | 2, 3, 5 |
| BLE | `react-native-ble-plx` | 4 |
| Bluetooth Classic | `react-native-bluetooth-classic` (Android only) | 4 |
| Archivos | `expo-file-system`, `expo-sharing` | todas |
| Dev build | `expo-dev-client` (obligatorio: hay código nativo, Expo Go no sirve) | todas |

`react-native-tcp-socket` expone tanto un cliente (`createConnection`, usado en Fase 2) como un servidor (`createServer`, clase `Server`) — el Modo Invitado (Fase 5) reutiliza esa misma librería en modo servidor para hablar HTTP/1.1 a mano, sin sumar una dependencia nueva.

### Escritorio — Tauri 2 / Rust (`apps/desktop`)

| Necesidad | Crate | Fase |
|---|---|---|
| Clipboard | `arboard` | todas |
| mDNS/ZeroConf | `mdns-sd` | 2 |
| BLE | `btleplug` | 4 |
| Runtime async / TCP | `tokio` (features `full`) | 2, 3 |
| Serialización | `serde`, `serde_json` | todas |

Elegido sobre Node/Electron y Python por footprint (proceso vivo permanentemente en bandeja del sistema en dos SO) y por la calidad de los bindings de Bluetooth/mDNS en Windows. El costo es no compartir código con el móvil; se compensa con el contrato de protocolo en `packages/protocol`. El escritorio no participa en absoluto en la Fase 5 (Modo Invitado): por definición, esa fase existe para los PCs donde el cliente Tauri **no** está instalado.

## 3. Fase 2 — WiFi/LAN (mDNS + TCP) ✅ Implementado

- Desktop anuncia `_p2pclip._tcp.local.` con `mdns-sd` (`apps/desktop/src-tauri/src/discovery.rs`) y sirve un servidor TCP con `tokio` (`.../src/transport.rs`) que lee `SyncMessage` en framing NDJSON (una línea = un mensaje; JSON ya escapa saltos de línea embebidos, así que el framing es seguro sin un length-prefix).
- Mobile escanea con `react-native-zeroconf` y se conecta con `react-native-tcp-socket` (`apps/mobile/src/lib/lanTransport.ts`).
- Puerto por defecto: `52847` (`packages/protocol/src/constants.ts` → `DEFAULT_TCP_PORT`, y su espejo en `protocol.rs`).
- Sin cifrado ni pairing todavía (ver §7) — pendiente antes de considerar el sistema listo para redes no confiables.

## 4. Fase 3 — Cable USB (túnel ADB)

El túnel USB no es un transporte nuevo: es una tubería para el mismo `LanTransport` (TCP). `adb reverse tcp:PORT tcp:PORT` (o `forward`) expone el socket ya usado por LAN; el código de transporte no distingue WiFi de cable — solo cambia cómo se estableció la ruta hasta el `localhost:PORT` del móvil.

Lo único específico por SO vive en un módulo `usb_driver_check`:
- **Windows**: requiere el driver "Google USB Driver" (o el OEM) para exponer la interfaz ADB.
- **Linux**: requiere reglas udev (`/etc/udev/rules.d/51-android.rules`) para acceso sin root.

Cliente ADB puro (sin depender del binario del sistema): `forensic-adb`/`mozdevice` en Rust, o platform-tools oficiales empaquetados por SO como fallback.

Disparo del triaje: el desktop detecta un dispositivo Android por USB (vía el cliente ADB) y, si no hay ya una conexión LAN activa con ese `deviceId`, intenta el túnel antes de caer a Bluetooth.

## 5. Fase 4 — Bluetooth (BLE / Classic)

Único medio que funciona sin ninguna red compartida ni cable — pensado para movilidad (exteriores, coche, dos dispositivos que nunca compartieron WiFi).

- **BLE** (`BleTransport`, `react-native-ble-plx` ↔ `btleplug`): disponible en Android e iOS. Throughput bajo (decenas de KB/s incluso con BLE 5 y MTU negociado), así que se reserva para: mensajes de texto cortos, tokens/OTP, y como **canal de handshake** para negociar una conexión Classic cuando el archivo es grande y el dispositivo es Android.
- **Bluetooth Classic (RFCOMM/SPP)** (`BtClassicTransport`, `react-native-bluetooth-classic`, Android only): mayor throughput, usable para archivos. **No disponible en iOS** para apps de terceros sin certificación MFi (§0) — en iOS, un archivo grande sin LAN/USB simplemente no tiene medio viable en este sistema; se lo comunicamos al usuario en vez de fallar en silencio.
- Pairing: igual que LAN (§7), reutiliza el mismo intercambio ECDH sobre el canal BLE antes de mover datos, para no depender del emparejamiento del sistema operativo (que es por dispositivo, no por app, y no distingue "confío en este teléfono para mi portapapeles").

Orden de intento dentro de la fase: BLE primero (para confirmar que el peer sigue siendo el mismo dispositivo emparejado) y, solo si el payload es de tipo `file` y ambos extremos son Android, se promueve la conexión a Classic.

## 6. Fase 5 — Modo Invitado (client-less, servidor HTTP efímero)

Para el caso "estoy en un PC público/de la oficina, sin permisos de instalación, y necesito pasar un texto o un token" — no hay cliente Tauri en el otro extremo, así que el rol se invierte: **el móvil expone un servidor**, y el PC actúa como cliente usando herramientas que ya tiene instaladas (navegador, `curl`, PowerShell).

**Activación:** exclusivamente manual (botón "Modo Invitado" en la app). Nunca se levanta como parte del triaje automático de las Fases 2–4, porque cambia el modelo de seguridad del sistema (ver riesgo abajo).

**Transporte:** `GuestHttpTransport`, HTTP/1.1 hablado a mano sobre `TcpSocket.createServer()` (misma librería que ya usa `LanTransport`, sin dependencias nuevas). Escucha en la IP LAN del móvil, puerto propio (ej. `52848`, distinto del `52847` de `LanTransport` para poder correr ambos a la vez).

**Token de sesión:** al activarse, la app genera un token corto (ej. 6 caracteres alfanuméricos) y lo muestra en pantalla junto con la URL completa y un QR. Todas las rutas exigen el token; sin descubrimiento por mDNS (un PC público probablemente no lo tiene habilitado o no queremos que cualquiera en esa red lo encuentre solo), así que el usuario teclea la IP:puerto o escanea el QR. La sesión expira sola a los N minutos (ej. 10) y el servidor se apaga — acota la ventana de exposición.

**Endpoints** (bajo `/t/<token>/...`; cualquier request sin el token correcto se descarta):
- `GET /t/<token>` → página HTML mínima autocontenida (sin JS externo): textarea + botón para pegar texto hacia el móvil, y el contenido actual del portapapeles del móvil para copiarlo manualmente. **Pendiente** — hoy no hay ruta de navegador, solo las dos de abajo.
- `POST /t/<token>/clipboard` (body = texto plano) → el móvil escribe ese texto en su portapapeles nativo vía `expo-clipboard`. ✅ Implementado.
- `GET /t/<token>/clipboard` → devuelve el portapapeles actual del móvil como `text/plain`, pensado para `curl`/`Invoke-RestMethod` sin necesidad de abrir un navegador. ✅ Implementado.
  ```bash
  curl http://192.168.1.23:52848/t/7f3a2b/clipboard
  ```

**Estado de implementación** (`apps/mobile/src/lib/guestServer.ts`): servidor HTTP/1.1 mínimo (una petición por conexión, sin keep-alive, sin `Content-Length` — el cuerpo se delimita cerrando la conexión) sobre `TcpSocket.createServer()`, con las dos rutas de arriba. El token hoy son 4 caracteres (no 6) y no hay QR ni expiración por temporizador — la "expiración" real es que el servidor se apaga al cerrar el modal del Modo Invitado (`handleCloseGuestMode` en `index.tsx`), lo cual ya acota la ventana de exposición aunque de forma menos fina que un timer. Sin la página HTML de `GET /t/<token>` todavía.

**Riesgo aceptado y por qué:** este modo sirve HTTP plano, sin el intercambio ECDH que protege las Fases 2–4 (no hay programa cliente al otro lado con quien negociar una clave). El texto viaja sin cifrar dentro de la LAN local del PC público durante la ventana de la sesión. Mitigaciones: token de un solo uso por sesión, expiración corta, activación explícita y visible (el usuario ve en pantalla que el servidor está expuesto y puede apagarlo a mano), y documentar claramente que **no es apto para tokens/contraseñas de alto valor** — solo para texto de conveniencia. Si en el futuro se necesita subir el nivel de seguridad, la vía es TLS con un certificado autofirmado + que el usuario acepte la advertencia del navegador, pero eso empeora la experiencia "sin fricción" que es la razón de ser de este modo, así que se deja fuera del alcance inicial.

## 7. Protocolo de sincronización

Ver [`packages/protocol/schema/sync-message.schema.json`](../packages/protocol/schema/sync-message.schema.json) — fuente única de verdad, consumida por el cliente móvil (`packages/protocol/src/types.ts`) y replicada a mano en Rust (`apps/desktop/src-tauri/src/protocol.rs`).

- Capa de transporte abstraída: `LanTransport` (Fase 2, ✅), `UsbTransport` (Fase 3, reutiliza `LanTransport` tras el túnel adb), `BleTransport` / `BtClassicTransport` (Fase 4, Classic solo Android), `GuestHttpTransport` (Fase 5, fuera del triaje automático — ver §6).
- Triaje automático: LAN (mDNS) → USB (túnel activo) → Bluetooth (BLE para texto/handshake, Classic solo Android para archivos). El Modo Invitado no participa: es una acción explícita del usuario, no un fallback.
- Pairing (Fases 2–4): QR o PIN en el primer emparejamiento, intercambio ECDH (X25519) para derivar clave de sesión (ChaCha20-Poly1305). Sin esto, cualquier dispositivo en la misma LAN podría anunciarse por mDNS y recibir el portapapeles. **Pendiente de implementar** — la Fase 2 actual envía `SyncMessage` en claro; no considerar el sistema listo para redes no confiables hasta que esto exista.

## 8. Monorepo

```
apps/mobile      Expo (React Native + TypeScript) — @clipsync/mobile
apps/desktop     Tauri (Rust + vanilla-ts) — @clipsync/desktop
packages/protocol  JSON Schema compartido (SyncMessage) — @clipsync/protocol
docs/            Este documento y futuras ADRs
```

Gestionado con pnpm workspaces. Justificación: el protocolo de sync necesita una única fuente de verdad versionada junto a ambos clientes; con dos repos separados, mantener ambos lados sincronizados en cada cambio de protocolo añade fricción sin beneficio en esta etapa.

## 9. Prerrequisitos pendientes en esta máquina

- Rust/cargo: instalado vía `rustup` (toolchain `stable`).
- Tauri en Linux necesita además `webkit2gtk` y `librsvg2` a nivel de sistema (paquetes apt) — ya instalados en esta máquina. Ver https://tauri.app/start/prerequisites/#linux.
