# Portapapeles Universal P2P (ClipSync)

Sincronización del portapapeles (texto, tokens y archivos) entre móvil y escritorio **sin nube**:
los dispositivos hablan directamente por LAN, USB o Bluetooth.

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
| WiFi / LAN (mDNS + TCP) | Implementado |
| Cable USB (túnel ADB) | Implementado |
| Bluetooth (BLE / Classic) | Pendiente |
| Modo Invitado (servidor HTTP efímero para equipos donde no se puede instalar el cliente) | Implementado |

## Limitaciones conocidas

Android 10+ e iOS 14+ restringen el acceso al portapapeles en segundo plano, así que no hay
sincronización 100 % silenciosa. Detalles en [`docs/architecture.md`](docs/architecture.md).

## Licencia

MIT © Javier Cortés Vidal
