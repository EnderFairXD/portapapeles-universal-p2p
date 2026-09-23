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
| **3** | Cable USB — túnel ADB | Sin red compartida pero con cable disponible (ej. WiFi corporativo con aislamiento de clientes) | ✅ Implementado (`usb.rs`, sondeo automático cada 5s — no hotplug real, pero suficiente) |
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

Para el caso "estoy en un PC público/de la oficina, sin permisos de instalación, y necesito sacar un archivo o un texto de mi móvil" — no hay cliente Tauri en el otro extremo, así que el rol se invierte: **el móvil expone un servidor**, y el PC actúa como cliente usando herramientas que ya tiene instaladas (navegador, `curl`).

**Rediseñado para fricción cero** (versión anterior con tokens y rutas `/t/<token>/clipboard` descartada — ver historial de commits): el flujo real de un técnico de sistemas es "elijo qué compartir → activo → alguien lo descarga en 5 segundos", no teclear una URL larga a mano. El diseño con token resultó exactamente lo contrario de eso.

**Flujo actual:**
1. El usuario elige qué compartir **dentro del propio modal del Modo Invitado** (texto o archivo — selección propia, independiente de lo que tenga puesto para enviar por P2P).
2. Pulsa "▶ Activar servidor". El móvil arranca un servidor HTTP en el puerto `8080` (deliberadamente distinto del `52847` de `LanTransport`, para poder correr ambos a la vez si hiciera falta).
3. El PC pide **la ruta raíz** (`GET /`, sin nada más que teclear) y recibe directamente el contenido — texto como `text/plain`, archivo con su `Content-Type`/`Content-Disposition` reales para que el navegador lo descargue con el nombre correcto.
4. El usuario para el servidor a mano ("■ Detener servidor") o cerrando el modal.

**Sin sistema de tokens.** Cualquiera que sepa la IP del móvil en esa red puede pedir `GET /` mientras el servidor esté activo — el modelo de seguridad ya no es "solo quien tiene el token", es "solo mientras el usuario lo deja activo, a propósito, viendo en pantalla que está expuesto". Coherente con el resto de la Fase 5: sigue siendo un modo manual, nunca un fallback automático, nunca deja el servidor corriendo en segundo plano sin que el usuario lo vea.

**Comandos que se muestran** (uno solo por medio, ya no hay distinción Windows/Linux — `curl` viene de serie en Windows 10+):
- Navegador: `http://<ip>:8080`
- Terminal: `curl http://<ip>:8080 -o "<nombre-real-del-archivo-o-compartido.txt>"`

**Transporte** (`apps/mobile/src/lib/guestServer.ts`): HTTP/1.1 hablado a mano sobre `TcpSocket.createServer()` (misma librería que ya usa `LanTransport`), una única ruta (`/`, GET). El texto se manda cerrando la conexión sin `Content-Length` (delimitado por cierre, válido en HTTP/1.1, evita medir bytes UTF-8 sin `Buffer`); el archivo sí lleva `Content-Length` real (el tamaño ya se conoce de antemano) y se transmite en crudo — sin base64 — vía `File.open()`/`FileHandle.readBytes()` en fragmentos de 1 MB, igual que `sendFileMessage` en `lanTransport.ts`, para no cargar archivos grandes enteros en memoria.

**Riesgo aceptado y por qué:** este modo sirve HTTP plano, sin el intercambio ECDH que protege las Fases 2–4 (no hay programa cliente al otro lado con quien negociar una clave), y ahora sin ni siquiera un token — cualquiera en la misma red que sepa la IP puede pedir `GET /` mientras el servidor esté activo. Es una decisión deliberada: el token anterior generaba más fricción de la que aportaba seguridad real para el caso de uso (compartir algo de forma rápida y visible, no un secreto). Mitigaciones que quedan: activación explícita y visible (el usuario ve en pantalla que el servidor está expuesto y lo apaga a mano), y **no es apto para contenido sensible** — solo para texto/archivos de conveniencia. Si en el futuro hace falta subir el nivel de seguridad, la vía es TLS con certificado autofirmado (empeora la fricción, por eso queda fuera del alcance inicial) o volver a un token opcional para quien lo pida explícitamente.

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
