# ClipSync — Fase 2b: imágenes y capturas — Diseño

Fecha: 2026-10-18 · Estado: pendiente de revisión · Amplía
[`2026-10-16-clipsync-v2-design.md`](2026-10-16-clipsync-v2-design.md) (la «spec v2»).

## 1. Objetivo

Pasar capturas de pantalla e imágenes copiadas entre el PC y el móvil tan rápido como el texto.
Hoy ClipSync solo sincroniza texto: una captura del PC (que COSMIC deja en el portapapeles como
imagen) se ignora, y en el móvil solo llega al PC con «Compartir → ClipSync», como un archivo
más en Descargas.

### Decisiones tomadas con Javier

| Tema | Decisión |
|---|---|
| PC → móvil | La imagen va al **portapapeles** del móvil (lista para pegar) **y** a la **galería**, en un álbum «ClipSync». |
| Móvil → PC | **Automático con la app abierta**: las capturas nuevas del móvil se envían solas al portapapeles del PC, y también las imágenes que se copien en el móvil. |

### Cómo se usa (lo que ve Javier)

- **Captura en el PC** (o imagen copiada en cualquier app del PC) → con ClipSync abierto en el
  móvil, aparece en su portapapeles y en Galería → ClipSync. Si el móvil no estaba conectado, le
  llega al abrir ClipSync.
- **Captura en el móvil** → al abrir (o volver a) ClipSync, las capturas hechas desde la última
  vez se envían al PC: quedan en su portapapeles y guardadas en `~/Imágenes/ClipSync`. Si la
  captura se hace con ClipSync en primer plano, se envía en el momento.
- **Imagen copiada en el móvil** (p. ej. «Copiar imagen» en el navegador) → se envía igual que
  un texto copiado.
- En el historial de las dos apps, las imágenes aparecen con miniatura; tocar una vuelve a
  ponerla en el portapapeles de ese dispositivo.

Android no deja a una app ver capturas nuevas mientras está en segundo plano sin un servicio
permanente (descartado en la spec v2), por eso el envío del móvil ocurre al volver a ClipSync.

## 2. Protocolo

Las imágenes viajan por el **canal de archivos** existente (cifrado, con control de flujo y
SHA-256), no como mensaje `clip`: una captura 4K pesa varios MB y `clip` está limitado a 1 MiB.

- `file_start` gana un campo opcional `purpose`:
  - ausente → archivo normal (comportamiento actual, a Descargas);
  - `"clipboard"` → imagen para el portapapeles; `mime` debe ser `image/png`, `image/jpeg` o
    `image/webp`, si no → `protocol_error`.
- `TransferUpdate` y `FileMeta` llevan también `purpose`, para que la UI y el sumidero sepan qué
  es (en TS opcional; en Rust `Option<String>`, serializado como `null` si falta — regla R21).
- Tamaño máximo de una imagen para el portapapeles: **20 MiB**. Mayor → el emisor no la envía
  y avisa «Imagen demasiado grande para sincronizar (máx. 20 MB)»; si el receptor recibe un
  `file_start` con `purpose:"clipboard"` y `size` mayor, cancela con `file_cancel`
  `reason:"too_large"`.
- Una imagen se envía a **cada** móvil conectado (como el texto), no solo al más reciente.
- Vectores compartidos TS↔Rust nuevos: `file_start` con `purpose` válido, con `purpose`
  desconocido (se ignora el campo, se trata como archivo normal) y con `mime` no permitido.

## 3. Anti-rebote y regla de inicio

Las imágenes tienen su **propio** estado anti-rebote, separado del texto (`ImageSync`): un hash
del último contenido de imagen sincronizado.

- **Qué se hashea.** No los bytes del PNG (cada lado puede recodificar), sino lo que el
  portapapeles **devuelve al leerlo**:
  - PC: SHA-256 de `ancho ‖ alto ‖ RGBA` tal como lo da `arboard::get_image`.
  - Móvil: SHA-256 de los bytes que devuelve `Clipboard.getImageAsync({ format: 'png' })`.
- **Regla de lectura de vuelta.** Al escribir una imagen recibida en el portapapeles, se lee
  inmediatamente y se guarda **el hash de esa lectura** como sincronizado. Así, aunque Android o
  el escritorio la recodifiquen, el vigilante no la reenvía.
- **Inicio de sesión.** Igual que el texto: cada lado envía su imagen de portapapeles actual si
  su hash difiere del sincronizado. Las imágenes no entran en la regla «gana el móvil» (no se
  pierden: quedan guardadas en la galería o en `~/Imágenes/ClipSync`).
- **Persistencia.** El móvil guarda en `settings.json` el hash de imagen confirmado (misma
  regla tentativo/confirmado que R29) y la marca de tiempo de la última captura revisada.
- **Texto e imagen a la vez.** Si una misma copia ofrece imagen y texto (p. ej. «Copiar imagen»
  con la URL como texto), se envía solo la imagen.

## 4. App de PC

- **Vigilante** (`app/clipboard.rs`):
  - Sigue sondeando texto cada 500 ms; las imágenes se sondean cada **1 s**.
  - Para no hashear 33 MB (RGBA de una pantalla 4K) en cada sondeo, se usa una **huella barata**
    (ancho, alto y hash de una fila de cada 64); el SHA-256 completo solo se calcula si la huella
    cambia.
  - Al detectar una imagen nueva: se codifica a PNG fuera del hilo del runtime
    (`spawn_blocking`), se escribe en un temporal y se envía con `purpose:"clipboard"`.
- **Recepción** (`Hub` + capa app):
  - El `Hub` guarda las imágenes con `purpose:"clipboard"` en `image_dir`
    (`dirs::picture_dir()/ClipSync`, creado si falta) en vez de Descargas, con el mismo saneado y
    reserva atómica de nombres.
  - Emite `HubEvent::ClipImageReceived { session_id, location }`; la capa app la decodifica
    (crate `image`, con límites: máx. 16 384 × 16 384 px y 512 MiB de memoria), la pone con
    `set_image` y aplica la regla de lectura de vuelta.
  - Si la decodificación falla: queda el archivo guardado y aviso «No se pudo poner la imagen
    en el portapapeles».
- **Interfaz.** El historial gana `kind: "image"` con miniatura (máx. 160 px de lado, PNG en
  data URL, generada al recibir o enviar). Clic → `copy_image(id)` la vuelve a poner en el
  portapapeles; botón «Abrir carpeta» como en archivos.

## 5. App de móvil

- **Dependencias:** `expo-media-library` (con `npx expo install`); `expo-clipboard` ya está.
- **Permiso de fotos** (`READ_MEDIA_IMAGES` en Android 13+, `READ_EXTERNAL_STORAGE` hasta 12),
  pedido la primera vez que hace falta. Si Javier concede «solo algunas fotos» (Android 14),
  se avisa de que las capturas nuevas no se verán y se ofrece abrir los ajustes.
- **Capturas nuevas** (`lib/screenshots.ts`):
  - Al pasar a primer plano y cada 3 s mientras está en primer plano, consulta con
    `MediaLibrary.getAssetsAsync` las fotos del álbum de capturas (título que contenga
    «screenshot» o «captura», sin distinguir mayúsculas) creadas después de
    `lastScreenshotCheck`.
  - Envía como mucho las **5 más recientes** y solo de los **últimos 15 minutos**, para no
    inundar el PC tras días sin abrir la app. La primera vez que se activa, `lastScreenshotCheck`
    empieza en «ahora».
  - Ajuste «Enviar capturas automáticamente» (activado por defecto).
- **Imágenes copiadas:** el oyente del portapapeles ya existente mira `contentTypes`; si incluye
  imagen, la lee con `getImageAsync({ format: 'png' })` y la envía con `purpose:"clipboard"`.
- **Recepción:**
  - `openSink` con `purpose:"clipboard"` escribe en la caché de la app (no en la carpeta SAF).
  - Al terminar: `MediaLibrary.createAssetAsync` + álbum «ClipSync» (ajuste «Guardar imágenes
    recibidas en la galería», activado por defecto), luego `Clipboard.setImageAsync` y regla de
    lectura de vuelta. Después se borra el archivo de la caché.
- **Interfaz:** el historial muestra las imágenes con miniatura; tocar una la vuelve a poner en
  el portapapeles. Ajustes: los dos interruptores de arriba.

## 6. Límites y errores

| Situación | Comportamiento |
|---|---|
| Imagen > 20 MiB | no se envía; aviso «Imagen demasiado grande para sincronizar (máx. 20 MB)» |
| `mime` no permitido con `purpose:"clipboard"` | `protocol_error` (como cualquier mensaje mal formado) |
| Imagen que no se puede decodificar en el PC | se conserva el archivo; aviso «No se pudo poner la imagen en el portapapeles» |
| Sin permiso de fotos | las capturas no se envían; aviso con acceso a los ajustes; lo demás sigue funcionando |
| Fallo al guardar en la galería | la imagen sigue yendo al portapapeles; aviso «No se pudo guardar en la galería» |
| Varias capturas seguidas | en cola, una transferencia a la vez (regla actual) |

## 7. Fuera de alcance

- Envío de capturas con la app del móvil cerrada o en segundo plano.
- Vídeos, GIF animados y otros formatos de portapapeles (HTML, archivos copiados en el explorador).
- Recortar o editar la imagen antes de enviarla.

## 8. Riesgos

- **Coste del sondeo de imágenes en el PC.** `arboard::get_image` transfiere la imagen entera en
  cada lectura (en Wayland, por el protocolo data-control). Se mide en la primera tarea; objetivo:
  menos del 5 % de un núcleo con una captura 4K en el portapapeles. Si no se cumple, se sondea
  solo cuando cambien los tipos ofrecidos o se baja la frecuencia.
- **`expo-clipboard` y `expo-media-library` en SDK 57 / Android 14–16**: el comportamiento de
  `getImageAsync`, del aviso de pegado y del acceso parcial a fotos se comprueba en el móvil de
  Javier.
- **Base64 por el puente de React Native**: `setImageAsync` recibe la imagen en base64 (≈ 27 MB
  para 20 MiB). Si es lento o falla con imágenes grandes, se reduce el límite para el
  portapapeles del móvil (la galería sigue recibiendo el original).

## 9. Pruebas

- **TS (`packages/protocol`):** validación de `purpose`/`mime`; `ImageSync` (rebote, lectura de
  vuelta, tentativo/confirmado); vectores nuevos.
- **Rust:** los mismos vectores; huella de imagen; límites de decodificación; destino
  `image_dir`; `ClipImageReceived`; envío a todos los móviles; `file_cancel` por tamaño.
- **e2e:** el cliente TS envía una imagen con `purpose:"clipboard"` → el `headless` emite
  `clipImageReceived` y el archivo en `image_dir` es idéntico; y al revés, el PC envía una imagen
  y el cliente la recibe con `purpose`.
- **Móvil (lógica pura):** selección de capturas (ventana de 15 min, máx. 5, desde la última
  revisión); decisión de envío texto/imagen.
- **En el móvil real:** captura en el PC → portapapeles y galería del móvil; captura en el móvil
  → PC al volver a ClipSync; «Copiar imagen» en el navegador del móvil → PC; imagen de 20 MB;
  permiso de fotos parcial.

## 10. Lugar en las fases

Fase **2b**, después de terminar la prueba en el móvil de la fase 2 y antes de la fase 3 (USB con
`adb` incluido). Tendrá su propio plan de implementación.
