# Portapapeles Universal P2P (ClipSync)

Sincronización del portapapeles (texto, tokens, archivos, imágenes y capturas de pantalla) entre móvil y escritorio **sin nube**:
los dispositivos hablan directamente por LAN, USB o Bluetooth. De momento solo para **Android**.

## Qué hace

- **Texto**: lo que copias en un dispositivo se puede pegar en el otro, en los dos sentidos.
- **Archivos**: del PC al móvil y del móvil al PC, con «Compartir → ClipSync» desde la Galería.
  Probado con 50 MB por USB, con comprobación de integridad (SHA-256).
- **Imágenes**: una imagen copiada en el PC llega al portapapeles del móvil y a su galería (álbum
  «ClipSync»); una copiada en el móvil llega al portapapeles del PC. Máximo 20 MB por imagen.
- **Capturas de pantalla**: las capturas nuevas del móvil se envían solas al PC al abrir o volver a
  ClipSync (Android no permite vigilarlas en segundo plano sin un servicio permanente). Las del PC
  viajan al móvil con ClipSync abierto.
- **Historial** en las dos apps, con miniatura de las imágenes: tocar una la vuelve a poner en el
  portapapeles de ese dispositivo.

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
| WiFi / LAN (mDNS + TCP) | ✅ Bidireccional (texto, archivos, imágenes y capturas) |
| Cable USB (túnel ADB) | ✅ Con el `adb` del sistema. 50 MB a unos 4 MiB/s en los dos sentidos (móvil de pruebas, cifrado nativo de Android) |
| Bluetooth (RFCOMM, dispositivos ya emparejados) | 🟡 Implementado (PC Linux y Windows, móvil Android); aún sin probar con hardware real |

No hay Modo Invitado: ClipSync necesita estar instalado en los dos dispositivos.

## Seguridad

| Función | Estado |
|---|---|
| Emparejamiento por QR | ✅ |
| Cifrado Noise IK (`Noise_IK_25519_ChaChaPoly_SHA256`) | ✅ |

Todo lo que viaja entre el móvil y el PC va cifrado, por el medio que sea. El móvil solo habla con
el PC que escaneó, y el PC solo acepta móviles emparejados.

## Cómo emparejar

1. En el PC, abre ClipSync y pulsa **«Emparejar móvil»**: aparece un QR que vale 5 minutos y se
   puede usar una sola vez.
2. En el móvil, abre ClipSync y pulsa **«Escanear QR del PC»** (la primera vez pide permiso de
   cámara).
3. Escanea el QR. Desde entonces los dos se reconectan solos, sin QR.

Para quitar un móvil, usa «Olvidar» en el PC o en el móvil. Si escaneas el QR del mismo PC otra
vez, se vuelve a emparejar sin preguntar; si es el de otro PC, la app pregunta antes de sustituir
el actual.

## Estado

Fases 1 y 2 (sesión por WiFi/USB, emparejamiento y cifrado) y fase 2b (imágenes y capturas)
implementadas. Las pruebas manuales de imágenes y capturas están en curso; la lista está en
[`docs/testing-checklist.md`](docs/testing-checklist.md). Fase 4 (Bluetooth) implementada, pendiente de
probar con hardware real.

## Comprobación manual

La lista de pruebas a mano está en [`docs/testing-checklist.md`](docs/testing-checklist.md).

## Limitaciones conocidas

Android 10+ e iOS 14+ restringen el acceso al portapapeles en segundo plano, así que no hay
sincronización 100 % silenciosa. Detalles en [`docs/architecture.md`](docs/architecture.md).

## Licencia

MIT © Javier Cortés Vidal
