# Lista de comprobación manual (fase 1)

Pruebas a mano con el PC (Pop!_OS / COSMIC) y el móvil Android. Se repite la lista una vez por
medio: primero WiFi y después USB.

## Preparación

- **App de escritorio**: `pnpm --filter @clipsync/desktop tauri dev`.
- **App móvil**: conecta el móvil por USB, activa «Depuración USB» y ejecuta
  `pnpm --filter @clipsync/mobile android`. Es una build de desarrollo (dev client), así que Metro
  tiene que estar en marcha mientras pruebas.
- **Red**: para WiFi, el móvil y el PC deben estar en la misma red. Para USB, basta el cable
  (con `adb` instalado en el sistema).

## WiFi

- [ ] texto PC → móvil
- [ ] texto móvil → PC al abrir la app
- [ ] texto móvil → PC con la app abierta
- [ ] un emoji y un texto de 500 KB
- [ ] foto de 5 MB móvil → PC
- [ ] PDF PC → móvil, primera vez con elección de carpeta
- [ ] «Compartir → ClipSync» desde Galería
- [ ] cancelar a mitad
- [ ] apagar el WiFi del móvil a mitad (transferencia fallida, reconexión)
- [ ] cerrar la app de PC y reabrirla (reconexión en ≤ 10 s)
- [ ] el mismo archivo dos veces → «nombre (1)»
- [ ] archivo vacío (0 bytes) en los dos sentidos
- [ ] compartir varios archivos a la vez desde la Galería
- [ ] abrir el selector de archivos y volver sin que se caiga la sesión
- [ ] ir al PC a abrir ClipSync mientras hay un envío pendiente por compartir, y volver
- [ ] portapapeles de Wayland/COSMIC en el PC (copiar y pegar en los dos sentidos)
- [ ] texto copiado en el PC con la app del móvil cerrada: llega al abrir la app

## USB

- [ ] texto PC → móvil
- [ ] texto móvil → PC al abrir la app
- [ ] texto móvil → PC con la app abierta
- [ ] un emoji y un texto de 500 KB
- [ ] foto de 5 MB móvil → PC
- [ ] PDF PC → móvil, primera vez con elección de carpeta
- [ ] «Compartir → ClipSync» desde Galería
- [ ] cancelar a mitad
- [ ] desenchufar el cable a mitad (transferencia fallida, reconexión)
- [ ] cerrar la app de PC y reabrirla (reconexión en ≤ 10 s)
- [ ] el mismo archivo dos veces → «nombre (1)»
- [ ] archivo vacío (0 bytes) en los dos sentidos
- [ ] compartir varios archivos a la vez desde la Galería
- [ ] abrir el selector de archivos y volver sin que se caiga la sesión
- [ ] ir al PC a abrir ClipSync mientras hay un envío pendiente por compartir, y volver
- [ ] portapapeles de Wayland/COSMIC en el PC (copiar y pegar en los dos sentidos)
- [ ] texto copiado en el PC con la app del móvil cerrada: llega al abrir la app
