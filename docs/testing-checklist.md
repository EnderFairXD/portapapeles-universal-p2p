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

## Emparejamiento y cifrado (fase 2)

Se hace una sola vez, por WiFi.

- [x] emparejar con el QR (primera vez, con permiso de cámara) — 2026-10-18
- [x] cerrar y abrir las dos apps: reconecta sin QR — 2026-10-18 (reinicio de la app del móvil y de la del PC)
- [ ] QR caducado (esperar 5 min) → «QR caducado»
- [ ] el mismo QR en un segundo móvil (si lo hay) → rechazado
- [ ] «Olvidar» en el PC con el móvil conectado → el móvil vuelve a la bienvenida con «Este PC no
  te reconoce»
- [ ] «Olvidar» en el móvil → bienvenida; el PC sigue listándolo hasta que Javier lo olvide
- [ ] borrar `identity.key` en el PC y reiniciarlo → el móvil, al tercer intento, muestra «No se
  pudo verificar el PC»
- [ ] con el PC sin mDNS (otra subred o cortafuegos), conecta por la IP del QR
- [ ] texto y foto de 5 MB en ambos sentidos, ya cifrados

### Medidas de la fase 2

Criterio: **handshake ≤ 1 s y ≥ 2 MB/s en los dos sentidos** (spec §9). Si no se cumple, se apunta
como seguimiento (ChaCha20/X25519 nativos sin cambiar el protocolo) y no bloquea la fase.

Las medidas del móvil se toman en un build de **release o preview**, no en desarrollo: Hermes en
modo dev es mucho más lento y falsearía el resultado. El tiempo del handshake sale del registro
`[clipsync] enlace abierto → ready: N ms` (un `console.log` de `connection.ts`, que no depende de
`__DEV__`); se lee con `adb logcat -s ReactNativeJS` mientras se conecta el móvil.

| Medida | Resultado |
|---|---|
| Bench en Node (`pnpm --filter @clipsync/protocol bench`, @noble en JS puro) | ~84 handshakes/s ≈ 11,8 ms por handshake; ~69 MB/s cifrando y descifrando tramas de 48 KiB |
| Handshake en el móvil (build release, REDMI Note 15, 2026-10-18) | 190–640 ms (USB y WiFi) ✅ |
| Archivo de 50 MB móvil → PC (USB, build release) | 88 s ≈ **0,56 MiB/s**, hash correcto ❌ |
| Archivo de 50 MB PC → móvil (USB, build release) | ~115 s ≈ **0,44 MiB/s**, hash correcto ❌ |
| Archivo de 109 MB móvil → PC (WiFi a −85 dBm) | ~0,5 MiB/s; se cortó a la mitad al apagarse la pantalla |

La velocidad es la misma por USB que por WiFi: el límite está en el JavaScript del móvil (cifrado y
SHA-256 de cada trozo en Hermes), no en la red. Queda como seguimiento: perfilar qué parte pesa más
y pasarla a código nativo sin cambiar el protocolo (spec §9).

Hallazgos de la prueba en el móvil (2026-10-18):

- Corregido: `expo-file-system` 57.0.7 no retenía el `ParcelFileDescriptor` de los `content://`;
  al pasar el recolector se cerraba y los archivos grandes fallaban a mitad («no se pudo leer el
  archivo», `Bad file descriptor`), al enviar y al recibir. Se arregla con `patches/` y compilando
  ese módulo desde el código (`expo.autolinking.android.buildFromSource` en `apps/mobile/package.json`).
- Corregido: tras cerrar el selector de carpeta, `AppState.currentState` seguía en `background`
  y el móvil pausaba y reconectaba ~200 ms después. Causa: `createFile` en la carpeta SAF es
  síncrono y bloqueó el hilo de JS 3 s (`binderTransact: time=3059ms` en logcat); al soltarse, el
  temporizador de la pausa diferida corrió antes que el evento `active` ya encolado. Ahora, antes
  de pausar, se pregunta a Android (`getCurrentAppState`), que se actualiza en `onHostResume`.
  Falta repetirlo en el móvil (recibir un archivo eligiendo la carpeta).
- Pendiente: con la pantalla apagada a mitad de un envío por WiFi la conexión se cortó.
- Corregido: el QR incluía la IP de `lxcbr0` (10.0.3.1); el filtro descarta ya `lxcbr*` y `lxdbr*`.
- Corregido: un intent de compartir con una URI cuya consulta da un cursor vacío (o nulo, o sin
  tipo MIME) cerraba la app con `CursorIndexOutOfBoundsException` en `expo-share-intent` 8.0.1
  (la última publicada). Se parchea en `patches/` para avisar del error («No se pudo recibir lo
  compartido») en vez de cerrarse; las medidas de imagen/vídeo pasan a ser opcionales. Este
  módulo no viene precompilado, así que no hace falta `buildFromSource`. Compila; falta repetir el
  `am start … SEND` en el móvil.
