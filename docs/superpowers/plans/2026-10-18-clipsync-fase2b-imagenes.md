# ClipSync — Fase 2b: imágenes y capturas — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que las capturas y las imágenes copiadas pasen entre el PC y el móvil por el portapapeles:
del PC al portapapeles y la galería del móvil, y del móvil (capturas nuevas al volver a ClipSync, e
imágenes copiadas) al portapapeles del PC y a `~/Imágenes/ClipSync`.

**Architecture:** Las imágenes viajan por el canal de archivos existente con un campo nuevo
`purpose: "clipboard"` en `file_start`. Cada lado lleva un anti-rebote de imágenes propio
(`ImageSync`, por hash de lo que el portapapeles devuelve al leer) y aplica la «regla de lectura
de vuelta» al escribir. El `Hub` de Rust guarda las imágenes en `image_dir`, las difunde a todos
los móviles y hace el envío de inicio; la capa app del PC y el gestor de conexión del móvil leen
y escriben los portapapeles.

**Tech Stack:** igual que las fases 1–2, más el crate `image` (png, jpeg, webp) en el PC y
`expo-media-library` en el móvil.

**Spec:** `docs/superpowers/specs/2026-10-18-clipsync-fase2b-imagenes-design.md` (amplía
`docs/superpowers/specs/2026-10-16-clipsync-v2-design.md`). Registro de la fase 2:
`docs/superpowers/plans/2026-10-17-clipsync-v2-fase2-registro.md` (decisiones R* que siguen vigentes, p. ej. R17, R20, R21, R29).

## Global Constraints

- Commits con la identidad del repo (Javier Cortés Vidal). **Nunca** `Co-Authored-By` ni
  «Generated with». Sin push.
- Comentarios en español, breves; toda la interfaz en español.
- Release de Rust con `panic = "abort"`: nada alcanzable desde la red o el portapapeles puede
  entrar en pánico; registros con `let _ = writeln!(std::io::stderr(), …)`.
- Dependencias de Expo solo con `npx expo install`. Sin APIs de Node en código de app.
- `purpose` admitido: `"clipboard"`. Desconocido → se ignora (archivo normal). Con
  `"clipboard"`, `mime` ∈ {`image/png`, `image/jpeg`, `image/webp`}, si no → `protocol_error`.
- `MAX_CLIP_IMAGE_BYTES = 20971520` (20 MiB). Mayor: el emisor no envía y avisa «Imagen demasiado
  grande para sincronizar (máx. 20 MB)»; el receptor cancela con `file_cancel`
  `reason:"too_large"`.
- Hash de imagen: PC = SHA-256 de `ancho (u32 BE) ‖ alto (u32 BE) ‖ RGBA` de `arboard::get_image`;
  móvil = SHA-256 de los bytes PNG de `Clipboard.getImageAsync({ format: 'png' })`. Ambos en hex
  minúscula. Tras escribir una imagen en el portapapeles se lee de vuelta y se guarda **ese** hash.
- Imagen y texto en la misma copia → solo la imagen.
- PC: sondeo de texto cada 500 ms (sin cambios) y de imagen cada 1000 ms con huella barata
  (ancho, alto, SHA-256 de una fila de cada 64); SHA-256 completo solo si la huella cambia.
  Objetivo: < 5 % de un núcleo con una captura 4K en el portapapeles.
- PC: `image_dir` = `dirs::picture_dir()/ClipSync` (si no hay, `download_dir/ClipSync`); decodificación
  con límites 16384 × 16384 px y 512 MiB. Miniaturas: máx. 160 px de lado, PNG en data URL.
- Móvil: capturas = álbum cuyo título contenga «screenshot» o «captura» (sin distinguir
  mayúsculas); revisión al pasar a primer plano y cada 3000 ms en primer plano; como mucho las
  **5** más recientes de los últimos **15 minutos**, creadas después de `lastScreenshotCheck`;
  la primera vez `lastScreenshotCheck = ahora`. Álbum de destino «ClipSync».
- Ajustes del móvil nuevos, activados por defecto: «Enviar capturas automáticamente» y «Guardar
  imágenes recibidas en la galería».
- Textos: «No se pudo poner la imagen en el portapapeles», «No se pudo guardar en la galería»,
  «Permite el acceso a las fotos para enviar tus capturas» (con botón «Abrir ajustes»).
- Comandos de prueba: `pnpm --filter @clipsync/protocol test`, `… test:e2e`,
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`, `pnpm --filter @clipsync/desktop test`,
  `pnpm --filter @clipsync/mobile exec tsc --noEmit`, `… lint`, `… test`.

## Review Focus

1. **Rebote de imágenes**: una imagen recibida y escrita no vuelve al emisor aunque el
   portapapeles la recodifique; tampoco con dos móviles (Tareas 3, 5, 7, 9).
2. **Bomba de descompresión**: un PNG de 1 MB que declara 100 000 × 100 000 px no tumba el PC
   (Tarea 7).
3. **Avalancha de capturas**: tras días sin abrir la app no se envían cientos; con la app abierta
   una captura nueva se envía una sola vez (Tarea 10).
4. **Permiso de fotos denegado o parcial**: el resto de ClipSync sigue funcionando y se avisa
   (Tareas 10, 11).
5. **Copia con imagen y texto** (navegador): llega la imagen y no además la URL (Tareas 7, 9).

---

### Task 1: Protocolo TS — `purpose`, constantes, vectores e `ImageSync`

**Files:**
- Modify: `packages/protocol/src/messages.ts`, `packages/protocol/src/constants.ts`, `packages/protocol/test-vectors/messages.json`, `packages/protocol/schema/sync-message.schema.json`, `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/imageSync.ts`, `packages/protocol/test/imageSync.test.ts`
- Test: `packages/protocol/test/messages.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // constants.ts
  export const MAX_CLIP_IMAGE_BYTES = 20971520;
  export const CLIP_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
  export const PURPOSE_CLIPBOARD = 'clipboard';
  // messages.ts
  type FileStartMsg = { kind: 'file_start'; transferId: string; name: string; size: number; mime: string; purpose?: 'clipboard' };
  // imageSync.ts — mismo esquema tentativo/confirmado que ClipboardSync, pero sobre hashes dados
  export class ImageSync {
    constructor(lastConfirmedHash?: string | null, onConfirmedChange?: (h: string | null) => void);
    get lastSyncedHash(): string | null; get lastConfirmedHash(): string | null;
    isDuplicate(hash: string): boolean;
    markSent(hash: string): void;      // tentativo
    confirmSent(): void;               // tras file_result ok
    revertSent(): void;                // tras fallo: vuelve al confirmado
    markSynced(hash: string): void;    // recibido y escrito (hash de la lectura de vuelta)
  }
  ```

- [ ] **Step 1: Tests.** Vectores nuevos: `file_start` con `purpose:"clipboard"` y `mime:"image/png"`
  → mensaje con `purpose`; `purpose:"otro"` → mensaje **sin** `purpose`; `purpose:"clipboard"` con
  `mime:"text/plain"` → `{"error":true}`. En `messages.test.ts`, ida y vuelta con y sin `purpose`.
  En `imageSync.test.ts`: `markSent(h)` → `isDuplicate(h)` y `lastConfirmedHash` sin cambiar;
  `confirmSent()` lo confirma y llama a `onConfirmedChange(h)`; `revertSent()` → `lastSyncedHash`
  vuelve al confirmado; `markSynced` confirma al momento; `confirmSent` tras un `markSynced`
  posterior no hace nada.
- [ ] **Step 2:** `pnpm --filter @clipsync/protocol test` → FAIL.
- [ ] **Step 3:** Implementar; el validador aplica la regla de `mime` de los Global Constraints.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** `git commit -m "feat(protocol): purpose clipboard en file_start e ImageSync"`

---

### Task 2: Session TS — `purpose` de extremo a extremo y límite de 20 MiB

**Files:**
- Modify: `packages/protocol/src/session.ts`
- Test: `packages/protocol/test/session-files.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `FileMeta.purpose?: 'clipboard'` (lo lleva también `FileSource`, al ser `extends
  FileMeta`); `TransferUpdate.purpose?: 'clipboard'`. `sendFile(src)` envía `purpose` si viene.
  El receptor, si llega `purpose:'clipboard'` con `size > MAX_CLIP_IMAGE_BYTES`, responde
  `file_cancel` `reason:'too_large'` **sin** llamar a `openSink`, y emite `failed`/`too_large`.
  `sendFile` lanza `RangeError` si `purpose:'clipboard'` y `size > MAX_CLIP_IMAGE_BYTES`.

- [ ] **Step 1: Tests.** Una imagen con `purpose` llega al `openSink` del otro lado con `purpose` y
  los `TransferUpdate` de ambos lados lo llevan; un archivo sin `purpose` no lo lleva; un
  `file_start` crudo de 20 MiB + 1 con `purpose` → `file_cancel too_large` y `openSink` no se
  llama; `sendFile` de 20 MiB + 1 con `purpose` → `RangeError`.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS (suite completa).
- [ ] **Step 5:** `git commit -m "feat(protocol): imágenes para el portapapeles en la sesión"`

---

### Task 3: Rust — protocolo e `ImageSync`

**Files:**
- Modify: `apps/desktop/src-tauri/src/protocol/messages.rs`, `apps/desktop/src-tauri/src/protocol/mod.rs`
- Create: `apps/desktop/src-tauri/src/core/image_sync.rs` (y declararlo en `core/mod.rs`)

**Interfaces:**
- Produces: `ControlMessage::FileStart { …, #[serde(skip_serializing_if = "Option::is_none", default)] purpose: Option<String> }`
  con la misma validación que TS (desconocido → `None` al decodificar); constantes
  `MAX_CLIP_IMAGE_BYTES`, `CLIP_IMAGE_MIMES`, `PURPOSE_CLIPBOARD`;
  `pub struct ImageSync` con `new(Option<String>)`, `is_duplicate(&str)`, `mark_sent`,
  `confirm_sent`, `revert_sent`, `mark_synced`, `last_confirmed_hash()` — mismo comportamiento que TS.

- [ ] **Step 1: Tests:** los vectores nuevos de la Tarea 1 (el test de vectores existente los
  recorre) y los mismos casos de `ImageSync` que en TS.
- [ ] **Step 2:** `cargo test …` → FAIL. **Step 3:** implementar. **Step 4:** → PASS, `cargo build` sin warnings.
- [ ] **Step 5:** `git commit -m "feat(desktop): purpose clipboard e ImageSync en Rust"`

---

### Task 4: Hub — recepción en `image_dir`, difusión y envío de inicio

**Files:**
- Modify: `apps/desktop/src-tauri/src/core/hub.rs`, `apps/desktop/src-tauri/src/core/session.rs`, `apps/desktop/src-tauri/src/core/hub_tests.rs`

**Interfaces:**
- Consumes: Task 3.
- Produces:
  ```rust
  pub struct LocalImage { pub hash: String, pub png_path: PathBuf }
  // HubConfig: + pub image_dir: PathBuf, + pub local_image: Arc<dyn Fn() -> Option<LocalImage> + Send + Sync>
  // HubEvent: + ClipImageReceived { session_id: u64, location: String }
  // TransferUpdate: + purpose: Option<String>
  impl Hub {
      /// A cada sesión lista cuyo ImageSync no la tenga; marca tentativo por dispositivo.
      pub fn broadcast_clip_image(&self, image: &LocalImage) -> Result<(), String>;   // Err("too_large") si > 20 MiB
      /// La capa app escribió la imagen recibida y leyó `hash` de vuelta.
      pub fn mark_image_synced(&self, session_id: u64, hash: &str);
  }
  ```
  Un `ImageSync` por `device_id`, como el de texto, con los mismos restablecimientos (R17/R20).
  `file_result ok` de una imagen saliente → `confirm_sent` de ese dispositivo; fallo o cancelación
  → `revert_sent`. Al emitir `PeerConnected`, si `local_image()` existe y no es duplicada para ese
  dispositivo, se encola su envío a esa sesión. Las imágenes entrantes con `purpose:"clipboard"`
  se guardan en `image_dir` (mismo saneado y reserva atómica) y, al terminar bien, se emite
  `ClipImageReceived`. `file_start` entrante con `purpose` y `size` > 20 MiB → `file_cancel too_large`.

- [ ] **Step 1: Tests** (cliente de prueba a mano, como los existentes): imagen entrante se guarda
  en `image_dir` y emite `ClipImageReceived`; `broadcast_clip_image` llega a dos clientes con
  `purpose`; tras `file_result ok` de ambos, un segundo `broadcast` de la misma imagen no envía
  nada; tras un fallo, sí se reenvía; envío de inicio al conectar con `local_image` distinta;
  `mark_image_synced(A)` evita reenviarla a A pero no a B; > 20 MiB → `file_cancel too_large`
  y `Err("too_large")` al difundir.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS, sin warnings.
- [ ] **Step 5:** `git commit -m "feat(desktop): imágenes de portapapeles en el Hub"`

---

### Task 5: e2e de imágenes Rust ↔ TS

**Files:**
- Modify: `apps/desktop/src-tauri/examples/headless.rs` (comando stdin `{"cmd":"image","path":…,"hash":…}` y argumento `--image-dir`), `packages/protocol/e2e/headless.e2e.test.ts`

- [ ] **Step 1: Tests:** cliente TS envía un PNG de 3 MiB con `purpose:'clipboard'` → `clipImageReceived`
  y el archivo de `image_dir` es idéntico (SHA-256); el PC difunde un PNG → el `memorySink` del
  cliente lo recibe con `purpose:'clipboard'`; 20 MiB + 1 desde el cliente → `RangeError` en el
  cliente (no sale nada).
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS 3 veces seguidas.
- [ ] **Step 5:** `git commit -m "test: e2e de imágenes de portapapeles"`

---

### Task 6: PC — lectura y escritura de imágenes del portapapeles

**Files:**
- Create: `apps/desktop/src-tauri/src/app/images.rs` (lógica pura: huella, hash, codificar PNG, decodificar con límites, miniatura)
- Modify: `apps/desktop/src-tauri/src/app/clipboard.rs`, `apps/desktop/src-tauri/src/app/mod.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/Cargo.toml` (`image` con png, jpeg, webp)

**Interfaces:**
- Produces:
  ```rust
  pub fn fingerprint(w: usize, h: usize, rgba: &[u8]) -> [u8; 32];
  pub fn pixel_hash(w: usize, h: usize, rgba: &[u8]) -> String;
  pub fn encode_png(w: usize, h: usize, rgba: &[u8]) -> Result<Vec<u8>, String>;
  pub fn decode_limited(path: &Path) -> Result<(usize, usize, Vec<u8>), String>; // límites de los Global Constraints
  pub fn thumbnail_data_url(w: usize, h: usize, rgba: &[u8]) -> Result<String, String>;
  ```
  `HistoryItem` gana `kind: "image"` con `thumbnail: Option<String>`. Comando nuevo
  `copy_image(id: u64)`. `local_image` de `HubConfig` devuelve el último `LocalImage` cacheado.
  - Hilo del portapapeles: texto como ahora. Cada 1000 ms, imagen con huella. Si cambia y no es
    la última escrita: PNG a un temporal en `app_cache_dir/images/` (podado con el historial, 50),
    actualizar `local_image` y llamar a `broadcast_clip_image`. Hay que hacerlo antes de mirar el
    texto de esa misma copia; si en esa copia hay imagen, el texto no se envía.
  - Con `ClipImageReceived`: `decode_limited` → `set_image` → `get_image` → `pixel_hash` →
    `mark_image_synced`. Si falla, aviso «No se pudo poner la imagen en el portapapeles».

- [ ] **Step 1: Tests (pura):** la huella cambia si cambia una fila muestreada y no recorre todo el
  búfer; `pixel_hash` estable; ida y vuelta PNG; `decode_limited` rechaza un PNG que declara
  100 000 × 100 000 (bomba) sin reservar memoria; miniatura ≤ 160 px; historial con imágenes
  limitado a 50 y sus temporales borrados al podar.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar.
- [ ] **Step 4:** → PASS; medir el sondeo con una captura 4K en el portapapeles durante 60 s
  (`/proc/<pid>/stat` o `ps`), y anotar el resultado en el informe. Si supera el 5 %, aplicar la
  alternativa del §8 de la spec y volver a medir.
- [ ] **Step 5:** `git commit -m "feat(desktop): imágenes del portapapeles del PC"`

---

### Task 7: PC — interfaz para imágenes

**Files:**
- Modify: `apps/desktop/src/render.ts`, `apps/desktop/src/types.ts`, `apps/desktop/src/main.ts`, `apps/desktop/src/styles.css`, `apps/desktop/src/render.test.ts`

Historial: item `image` con `<img>` de la miniatura (`src` = data URL; solo se aceptan cadenas que
empiecen por `data:image/png;base64,`), clic → `copy_image`, botón «Abrir carpeta». Avisos nuevos.

- [ ] **Step 1: Tests:** item de imagen con miniatura; una miniatura que no sea `data:image/png;base64,`
  no se pinta; clic llama a `copy_image` con el id.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** → PASS; `pnpm --filter @clipsync/desktop build`.
- [ ] **Step 5:** `git commit -m "feat(desktop): imágenes en el historial"`

---

### Task 8: Móvil — imágenes del portapapeles y recepción a la galería

**Files:**
- Create: `apps/mobile/src/lib/images.ts`, `apps/mobile/src/lib/imagePolicy.ts` (pura), `apps/mobile/test/imagePolicy.test.ts`
- Modify: `apps/mobile/src/lib/connection.ts`, `apps/mobile/src/lib/clipboardWatcher.ts`, `apps/mobile/src/lib/files.ts`, `apps/mobile/src/lib/settings.ts`, `apps/mobile/app.json`, `apps/mobile/package.json` (`npx expo install expo-media-library`)

**Interfaces:**
- Produces:
  ```ts
  // settings.ts: + lastImageHash: string | null; lastScreenshotCheck: number | null;
  //              + sendScreenshots: boolean (true); saveToGallery: boolean (true)
  // imagePolicy.ts
  export function clipboardKind(contentTypes: string[]): 'image' | 'text' | 'none';  // imagen gana a texto
  export function isOwnWrite(hash: string, lastWritten: string | null): boolean;
  // images.ts
  export async function readClipboardImage(): Promise<{ hash: string; source: FileSource } | null>;
  export async function writeReceivedImage(path: string, saveToGallery: boolean): Promise<{ hash: string; galleryUri: string | null }>;
  ```
  - El gestor tiene un único `ImageSync` persistido (`lastImageHash`, R29), y lo usa así:
    1. Al cambiar el portapapeles: si es imagen y no duplicada, `sendFile` con
       `purpose:'clipboard'` y `markSent`; `done` → `confirmSent`; fallo → `revertSent`.
    2. Al quedar lista la sesión: también envía la imagen actual del portapapeles si no es
       duplicada.
  - `openSink` con `purpose:'clipboard'` escribe en `Paths.cache/images/`.
  - Al recibir una imagen (`done` entrante con `purpose`): `writeReceivedImage`, que hace lo
    siguiente:
    1. Galería: álbum «ClipSync», si está activado.
    2. `setImageAsync` y después `getImageAsync({ format: 'png' })`; con su hash, `markSynced`.
    3. Copia en `Paths.document/images/<id>.png` para el historial, podada a 50.
    4. Borra el archivo de la caché.

    Mientras dura esta escritura, el oyente del portapapeles ignora los eventos. Si falla la
    galería, la imagen sigue yendo al portapapeles y se avisa «No se pudo guardar en la galería».
  - `HistoryEntry.kind` gana `'image'` con `imageUri`.
  - `copyFromHistory` acepta imágenes: `setImageAsync` + lectura de vuelta.

- [ ] **Step 1: Tests (pura):** `clipboardKind(['plain-text','image'])` → `'image'`; con solo texto →
  `'text'`; `isOwnWrite`; los casos de inicio/rebote de imágenes con `ImageSync` (recibida →
  no se reenvía; enviada sin confirmar y sesión caída → se reenvía al reconectar).
- [ ] **Step 2:** → FAIL. **Step 3:** implementar.
- [ ] **Step 4:** tsc, lint y test del móvil → verde; `npx expo prebuild --platform android --no-install`
  y comprobar el permiso y el plugin de `expo-media-library` en el manifiesto.
- [ ] **Step 5:** `git commit -m "feat(mobile): imágenes del portapapeles y recepción a la galería"`

---

### Task 9: Móvil — capturas nuevas

**Files:**
- Create: `apps/mobile/src/lib/screenshots.ts`, `apps/mobile/src/lib/screenshotPolicy.ts` (pura), `apps/mobile/test/screenshotPolicy.test.ts`
- Modify: `apps/mobile/src/lib/connection.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ShotAsset { id: string; uri: string; creationTime: number; albumTitle: string }
  export function isScreenshotAlbum(title: string): boolean;
  export function pickScreenshots(assets: ShotAsset[], since: number | null, now: number, sentIds: Set<string>): ShotAsset[]; // ≤ 5, ≤ 15 min, > since, no enviadas, más recientes primero
  export function startScreenshotWatcher(onShots: (shots: ShotAsset[]) => void): () => void; // al activarse y cada 3000 ms en primer plano
  ```
  - El gestor arranca el vigilante en `resume()` y lo para en `pause()`, solo si
    `sendScreenshots` está activado y hay permiso.
  - Cada captura se envía con `fileSourceFromUri` y `purpose:'clipboard'`. Tras encolarla,
    `lastScreenshotCheck` se actualiza al `creationTime` más reciente enviado.
  - La primera vez, `lastScreenshotCheck` vale `Date.now()`.
  - Sin permiso, o con permiso parcial (`accessPrivileges !== 'all'`), aparece el aviso de los
    Global Constraints y el vigilante no arranca.

- [ ] **Step 1: Tests (pura):** `isScreenshotAlbum` («Screenshots», «Capturas de pantalla», «Camera» → no);
  `pickScreenshots`: 8 capturas en 10 min → las 5 más recientes; una de hace 20 min → fuera; una
  anterior a `since` → fuera; una ya enviada (`sentIds`) → fuera; `since` nulo con capturas de
  hace 1 min → dentro.
- [ ] **Step 2:** → FAIL. **Step 3:** implementar. **Step 4:** tsc, lint y test → verde.
- [ ] **Step 5:** `git commit -m "feat(mobile): envío de capturas nuevas al volver a ClipSync"`

---

### Task 10: Móvil — interfaz

**Files:**
- Modify: `apps/mobile/src/components/HistoryList.tsx`, `apps/mobile/src/app/settings.tsx`, `apps/mobile/src/app/index.tsx`

Historial con miniatura (`Image` de `imageUri`), tocar → `copyFromHistory`. Ajustes: los dos
interruptores (persisten en `settings.json`). Aviso de permiso con «Abrir ajustes»
(`Linking.openSettings()`).

- [ ] **Step 1:** implementar. **Step 2:** tsc, lint y test → verde; `./gradlew assembleDebug`
  (ANDROID_HOME desde `~/.bashrc`), y después `./gradlew --stop`.
- [ ] **Step 3:** `git commit -m "feat(mobile): imágenes en el historial y ajustes de capturas"`

---

### Task 11: Comprobación y documentación

**Files:**
- Modify: `docs/testing-checklist.md` (sección «Imágenes y capturas»), `README.md` (una línea: también imágenes y capturas)

- [ ] **Step 1:** Añadir a la lista de comprobación:
  - [ ] captura en el PC → portapapeles y Galería → ClipSync del móvil;
  - [ ] lo mismo con el móvil desconectado → llega al abrir ClipSync;
  - [ ] captura en el móvil → PC al volver a ClipSync (portapapeles y `~/Imágenes/ClipSync`);
  - [ ] captura con ClipSync abierto → se envía sola y una sola vez;
  - [ ] «Copiar imagen» en el navegador del móvil → PC, sin la URL;
  - [ ] imagen de 20 MB y una de 21 MB (aviso);
  - [ ] permiso de fotos denegado y parcial;
  - [ ] la imagen recibida no rebota;
  - [ ] CPU del PC con una captura 4K en el portapapeles.
- [ ] **Step 2:** Ejecutar todos los comandos de prueba de los Global Constraints → verde.
- [ ] **Step 3:** `git commit -m "docs: imágenes y capturas en la lista de comprobación"`
