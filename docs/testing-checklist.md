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
`__DEV__`); se lee con `adb logcat -s ReactNativeJS` mientras se conecta el móvil. La velocidad
de cada archivo sale igual, de `[clipsync] archivo móvil→PC|PC→móvil: N MiB en T s → V MiB/s`, y
`[clipsync] cifrado y SHA-256 nativos` confirma que se usa el módulo nativo y no @noble.

| Medida | Resultado |
|---|---|
| Bench en Node (`pnpm --filter @clipsync/protocol bench`, @noble en JS puro) | ~84 handshakes/s ≈ 11,8 ms por handshake; ~69 MB/s cifrando y descifrando tramas de 48 KiB |
| Handshake en el móvil (build release, REDMI Note 15, 2026-10-18) | 190–640 ms (USB y WiFi) ✅ |
| Archivo de 50 MB móvil → PC (USB, build release) | 88 s ≈ **0,56 MiB/s**, hash correcto ❌ |
| Archivo de 50 MB PC → móvil (USB, build release) | ~115 s ≈ **0,44 MiB/s**, hash correcto ❌ |
| Archivo de 109 MB móvil → PC (WiFi a −85 dBm) | ~0,5 MiB/s; se cortó a la mitad al apagarse la pantalla |
| Coste por trozo de 48 KiB en Hermes (release, antes) | ChaCha20 @noble ~33 ms; SHA-256 @noble ~41 ms; base64 de `react-native-tcp-socket` (Buffer en JS) ~35 ms al leer y ~9 ms al escribir; lectura/escritura de archivo y framing < 0,2 ms |
| Coste por trozo de 48 KiB con el módulo nativo | ChaCha20 ~0,4 ms; SHA-256 ~0,1 ms; base64 ~1,6 ms al leer y ~0,8 ms al escribir; los 3 vectores de snow pasan en el móvil |
| Archivo de 50 MB móvil → PC (USB, release, módulo nativo, 2026-10-18) | 12,1 s ≈ **4,12 MiB/s** (4,3 MB/s), hash correcto ✅ |
| Archivo de 50 MB PC → móvil (USB, release, módulo nativo, 2026-10-18) | 12,9 s ≈ **3,87 MiB/s** (4,1 MB/s), hash correcto ✅ |
| Archivo de 50 MB móvil → PC (WiFi a −86 dBm, release, módulo nativo, 2026-10-18) | 27,5 s ≈ **1,82 MiB/s** (1,9 MB/s), hash correcto; justo por debajo del criterio, con una WiFi muy floja |
| Archivo de 50 MB PC → móvil (WiFi a −86 dBm, release, módulo nativo, 2026-10-18) | 12,4 s ≈ **4,04 MiB/s** (4,2 MB/s), hash correcto; el nombre repetido se guarda como «… (1).bin» ✅ |

La velocidad era la misma por USB que por WiFi: el límite estaba en el JavaScript del móvil. Medido
trozo a trozo, en el envío se iban ~85 ms (SHA-256 + ChaCha20 + base64) y en la recepción ~109 ms
(base64 + ChaCha20 + SHA-256), lo que da justo los 0,56 y 0,44 MiB/s de arriba. Se arregla con el
módulo local `apps/mobile/modules/clipsync-native` (ChaCha20-Poly1305 de Conscrypt, SHA-256 y base64
de Android) y un parche de `react-native-tcp-socket` para que las cadenas base64 no pasen por `Buffer`.
El protocolo no cambia: `setCryptoBackend` compara el backend nativo con @noble antes de usarlo y, si no
coincide, se sigue con @noble. Las medidas nuevas se tomaron contra el servidor `headless` del
escritorio en build de depuración; queda repetirlas por WiFi con la app de escritorio.

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
  Con la creación ya asíncrona (punto siguiente) no se puede reproducir; la consulta a Android
  queda como defensa ante cualquier otra llamada síncrona larga.
- Corregido: la creación del archivo ya no bloquea el hilo de JS. El parche de `expo-file-system`
  añade `Directory.createFileAsync`, que hace el `createDocument` de SAF en `Dispatchers.IO`, y
  `openSink` lo espera. Medido en el REDMI contra el `headless` por USB: la primera creación de
  cada proceso tardó 360 y 174 ms, la primera justo tras elegir carpeta 70 ms y las demás 53–112 ms,
  siempre en un hilo `DefaultDispatcher-worker`; durante la espera el hilo de JS no se paró más de
  25–130 ms seguidos (lo mide un `setInterval` de 20 ms). Los
  3 s no se repitieron: no pasa en cada creación, fue un caso puntual y lento del proveedor.
- Pendiente: con la pantalla apagada a mitad de un envío por WiFi la conexión se cortó.
- Corregido: el QR incluía la IP de `lxcbr0` (10.0.3.1); el filtro descarta ya `lxcbr*` y `lxdbr*`.
- Corregido: un intent de compartir con una URI cuya consulta da un cursor vacío (o nulo, o sin
  tipo MIME) cerraba la app con `CursorIndexOutOfBoundsException` en `expo-share-intent` 8.0.1
  (la última publicada). Se parchea en `patches/` para avisar del error («No se pudo recibir lo
  compartido») en vez de cerrarse; las medidas de imagen/vídeo pasan a ser opcionales. Este
  módulo no viene precompilado, así que no hace falta `buildFromSource`. Probado en el REDMI con
  `am start … SEND` y `content://media/external/file/45223`: sale el aviso y la app sigue abierta.

## Imágenes y capturas (fase 2b)

Se prueba por WiFi y otra vez por USB, con el móvil emparejado. Android 10 o anterior y Android 14
(permiso parcial) se prueban en la medida en que haya móvil.

- [ ] captura en el PC → portapapeles y Galería → ClipSync del móvil
- [ ] lo mismo con el móvil desconectado → llega al abrir ClipSync
- [ ] captura en el móvil → PC al volver a ClipSync (portapapeles y `~/Imágenes/ClipSync`)
- [ ] captura con ClipSync abierto → se envía sola y una sola vez
- [ ] «Copiar imagen» en el navegador del móvil → PC, sin la URL
- [ ] imagen de 20 MB y una de 21 MB (aviso «Imagen demasiado grande para sincronizar (máx. 20 MB)»)
- [ ] permiso de fotos denegado y parcial: sale «Permite el acceso a las fotos para enviar tus
  capturas» con «Abrir ajustes» y el resto de ClipSync (texto, archivos) sigue funcionando
- [ ] la imagen recibida no rebota
- [ ] imagen recibida con la app en segundo plano: no rebota al volver a primer plano (se escribe
  en el portapapeles al abrir ClipSync, una sola vez)
- [ ] texto copiado mientras se guarda una imagen en la galería: llega al PC (el guard del
  portapapeles solo cubre la escritura de la imagen)
- [ ] guardar en la galería en Android 10: sale el diálogo de permiso de fotos y, si se acepta, la
  imagen queda en el álbum «ClipSync»; si se rechaza, «No se pudo guardar en la galería» y la imagen
  llega igualmente al portapapeles
- [ ] ajustes del móvil: «Enviar capturas automáticamente» y «Guardar imágenes recibidas en la
  galería» (se conservan al cerrar la app y se aplican sin reiniciar)
- [ ] CPU del PC con una captura 4K en el portapapeles (< 5 % de un núcleo)

## Bluetooth (fase 4)

Implementado pero sin probar con hardware. Hace falta un PC con adaptador Bluetooth y el móvil
emparejado con él en los ajustes del sistema.

- [ ] PC sin adaptador → aviso, y WiFi/USB siguen
- [ ] emparejar en el sistema y conectar con el WiFi apagado
- [ ] texto y una captura por Bluetooth
- [ ] archivo de 5 MB, anotando la velocidad
- [ ] encender el WiFi con la sesión por Bluetooth → cambia a WiFi en ≤ 30 s sin cortar un archivo
- [ ] modo fijo Bluetooth
- [ ] permiso denegado
- [ ] conectar por Bluetooth con el PC que exige autenticación (si falla, anotar el error)
- [ ] cambiar de medio en Ajustes con un archivo en curso: no se corta, sale «Se cambiará al terminar
  la transferencia» y el cambio se aplica al terminar
