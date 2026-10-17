# Portapapeles Universal P2P (ClipSync)

Sincronización del portapapeles (texto, tokens y archivos) entre móvil y escritorio **sin nube**:
los dispositivos hablan directamente por LAN, USB o Bluetooth. De momento solo para **Android**.

## Estructura del monorepo

| Carpeta | Contenido |
|---|---|
| `apps/mobile` | App móvil (Expo / React Native) |
| `apps/desktop` | App de escritorio (Tauri + Vite + TypeScript) |
| `packages/protocol` | Protocolo y esquemas compartidos |
| `docs/architecture.md` | Arquitectura, transportes y limitaciones de plataforma |

## Transportes

El móvil prueba los medios por orden de preferencia y cae al siguiente si el anterior no está disponible.

| Medio | Estado |
|---|---|
| WiFi / LAN (mDNS + TCP) | ✅ Bidireccional (texto y archivos) |
| Cable USB (túnel ADB) | ✅ Con el `adb` del sistema |
| Bluetooth (BLE / Classic) | Pendiente |

No hay Modo Invitado: ClipSync necesita estar instalado en los dos dispositivos.

## Comprobación manual

La lista de pruebas a mano está en [`docs/testing-checklist.md`](docs/testing-checklist.md).

## Limitaciones conocidas

Android 10+ e iOS 14+ restringen el acceso al portapapeles en segundo plano, así que no hay
sincronización 100 % silenciosa. Detalles en [`docs/architecture.md`](docs/architecture.md).

## Licencia

MIT © Javier Cortés Vidal
