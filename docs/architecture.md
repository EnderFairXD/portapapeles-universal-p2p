# Arquitectura — Portapapeles Universal P2P

## 0. Restricciones críticas de plataforma (leer primero)

- **Android 10+**: el acceso al portapapeles en background está bloqueado salvo que la app esté en foreground, tenga el foco de la ventana, o corra como foreground service con notificación persistente.
- **iOS 14+**: leer el portapapeles sin un "paste" explícito del usuario dispara un banner del sistema; el acceso en background también está restringido.
- **iOS + Bluetooth Classic**: sin acceso de terceros a RFCOMM/SPP salvo certificación MFi. El fallback de Bluetooth Classic para archivos **solo es viable en Android**; iOS queda limitado a BLE (bajo throughput, impracticable para archivos grandes).

Consecuencia: no hay sincronización 100% silenciosa. Se requiere uno de: app en foreground, foreground service con notificación (Android), o disparo manual (share extension, widget, tap). Fase 1 asume **Android-first** para USB y Bluetooth Classic; iOS soporta LAN + BLE.

## 1. Stack

### Móvil — Expo (React Native, `apps/mobile`)

| Necesidad | Librería |
|---|---|
| Clipboard | `expo-clipboard` |
| mDNS/ZeroConf | `react-native-zeroconf` |
| TCP sockets (LAN y túnel USB) | `react-native-tcp-socket` |
| BLE | `react-native-ble-plx` |
| Bluetooth Classic | `react-native-bluetooth-classic` (Android only) |
| Archivos | `expo-file-system`, `expo-sharing` |
| Dev build | `expo-dev-client` (obligatorio: hay código nativo, Expo Go no sirve) |

### Escritorio — Tauri 2 / Rust (`apps/desktop`)

| Necesidad | Crate |
|---|---|
| Clipboard | `arboard` |
| mDNS/ZeroConf | `mdns-sd` |
| BLE | `btleplug` |
| Runtime async / TCP | `tokio` (features `full`) |
| Serialización | `serde`, `serde_json` |

Elegido sobre Node/Electron y Python por footprint (proceso vivo permanentemente en bandeja del sistema en dos SO) y por la calidad de los bindings de Bluetooth/mDNS en Windows. El costo es no compartir código con el móvil; se compensa con el contrato de protocolo en `packages/protocol`.

## 2. Aislamiento Windows/Linux vía USB

El túnel USB no es un transporte nuevo: es una tubería para el mismo `LanTransport` (TCP). `adb reverse tcp:PORT tcp:PORT` (o `forward`) expone el socket ya usado por LAN; el código de transporte no distingue WiFi de cable.

Lo único específico por SO vive en un módulo `usb_driver_check`:
- **Windows**: requiere el driver "Google USB Driver" (o el OEM) para exponer la interfaz ADB.
- **Linux**: requiere reglas udev (`/etc/udev/rules.d/51-android.rules`) para acceso sin root.

Cliente ADB puro (sin depender del binario del sistema): `forensic-adb`/`mozdevice` en Rust, o platform-tools oficiales empaquetados por SO como fallback.

## 3. Protocolo de sincronización

Ver [`packages/protocol/schema/sync-message.schema.json`](../packages/protocol/schema/sync-message.schema.json) — fuente única de verdad, consumida por ambos clientes.

- Capa de transporte abstraída: `LanTransport`, `UsbTransport` (reutiliza `LanTransport` tras el túnel adb), `BleTransport`, `BtClassicTransport` (Android only).
- Triaje: LAN (mDNS) → USB (túnel activo) → Bluetooth (BLE para texto/handshake, Classic solo Android para archivos).
- Pairing: QR o PIN en el primer emparejamiento, intercambio ECDH (X25519) para derivar clave de sesión (ChaCha20-Poly1305). Sin esto, cualquier dispositivo en la misma LAN podría anunciarse por mDNS y recibir el portapapeles.

## 4. Monorepo

```
apps/mobile      Expo (React Native + TypeScript)
apps/desktop     Tauri (Rust + vanilla-ts)
packages/protocol  JSON Schema compartido (SyncMessage)
docs/            Este documento y futuras ADRs
```

Gestionado con pnpm workspaces. Justificación: el protocolo de sync necesita una única fuente de verdad versionada junto a ambos clientes; con dos repos separados, mantener ambos lados sincronizados en cada cambio de protocolo añade fricción sin beneficio en esta etapa.

## 5. Prerrequisitos pendientes en esta máquina

- Rust/cargo: instalado vía `rustup` (toolchain `stable`).
- Tauri en Linux necesita además `webkit2gtk` y `librsvg2` a nivel de sistema (paquetes apt) antes de poder compilar `apps/desktop` — no instalado en este scaffold porque requiere `sudo`. Ver https://tauri.app/start/prerequisites/#linux.
