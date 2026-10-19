# SDD ledger — plan: docs/superpowers/plans/2026-10-18-clipsync-fase2b-imagenes.md

Spec: docs/superpowers/specs/2026-10-18-clipsync-fase2b-imagenes-design.md (amplía la spec v2). Rama: main (Javier lo eligió en la fase 1; da la prueba de la fase 2 por terminada y no reanudará esa sesión mientras tanto). Base: 714ce36

## Pre-flight scan

| Par / tarea | Produce → consume | Hallazgo |
|---|---|---|
| T1→T2,T3 | purpose, constantes, vectores, ImageSync TS | T3 recorre los mismos vectores. OK |
| T2↔T4 | FileMeta/TransferUpdate.purpose ↔ Rust TransferUpdate.purpose | mismos nombres camelCase. OK |
| T3→T4 | ImageSync Rust, constantes | OK |
| T4→T5,T6 | HubConfig + image_dir + local_image, ClipImageReceived, broadcast_clip_image, mark_image_synced | T4 cambia HubConfig: headless.rs, lib.rs y tests deben seguir compilando → R1 |
| T4→T5 | headless necesita --image-dir y comando image | T5 los añade. OK |
| T6→T7 | HistoryItem.thumbnail, copy_image | OK |
| T2→T8 | FileSource/FileMeta.purpose, TransferUpdate.purpose en el móvil | OK |
| T8→T9 | ImageSync del gestor, envío con purpose | T9 reutiliza el envío de T8. OK |
| T8,T9→T10 | HistoryEntry kind image/imageUri, ajustes | OK |
| Review Focus | números de tarea desfasados (cita 3,5,7,9…) | R2 |
| T6 | medición de CPU necesita una sesión gráfica | R3 |
| T8–T10 | sin móvil conectado no hay prueba en dispositivo | R4 |

## Rulings
- Ruling R1: T4 actualiza todos los constructores de HubConfig (lib.rs, headless.rs, tests) con valores provisionales (image_dir = download_dir/ClipSync, local_image → None) para que todo compile; T5/T6 ponen los reales — coste si mal: ninguno.
- Ruling R2: el Review Focus del plan cita números de tarea antiguos; mapeo real: rebote → T1,T4,T6,T8; bomba → T6; avalancha → T9; permiso → T9,T10; imagen+texto → T6,T8 — coste: ninguno.
- Ruling R3: la medición de CPU de T6 se hace con el portapapeles real de la sesión gráfica de Javier solo copiando una imagen de prueba generada (no capturas de pantalla, que podrían mostrar contenido personal); si no se puede, se mide con un bucle sintético sobre el código de huella y se anota — coste: medida menos realista.
- Ruling R4: sin móvil conectado, T8–T10 verifican con tsc/lint/tests/gradle; la prueba en dispositivo queda en la lista de T11 — coste: comportamiento real de expo-clipboard/media-library sin verificar.
- Ruling R5: T1+T2 en un único despacho (mismo paquete, pequeñas, secuenciales) — coste: revisión menos granular.

## Progreso
- Ruling R6: cargo test falla con los vectores nuevos entre T1 y T3 (el espejo Rust llega en T3) — aceptado — coste: commits intermedios con cargo test rojo.
Task 1-2: complete (commits 714ce36..4c26d5c, review clean)
Task 1-2: minor (deferred): schema tipa purpose como string aunque se ignoran no-strings; faltan tests de purpose en failed/cancelled salientes y de too_large con otra transferencia en curso; sendFile no valida mime localmente (falla como internal_error); estilo de imports.
- Ruling R7: como ImageSync.confirmSent no lleva hash, por cada par hay como mucho una imagen de portapapeles en cola o en curso; una imagen nueva sustituye (cancela) a la que espera en cola; markSent al encolar la que queda — aplica en T4 (Rust) y T8 (móvil) — coste si mal: una imagen intermedia no se envía (solo importa la última del portapapeles).
Task 3: review 1 → Needs fixes (Important: el codificador Rust no valida purpose/mime)
Task 3: minor (deferred): Deserialize derivado acepta cualquier purpose si alguien deserializa sin el validador; línea de import larga; ImageSync sin re-exportar (T4).
Task 3: fix round 1/5 (1 addressed, 0 open; commits 45a576b..44373e5)
Task 3: complete (commits 4c26d5c..44373e5, review clean)
- Ruling R8: se acepta el cambio mínimo de T4 en app/mod.rs (brazo vacío ClipImageReceived y purpose: None en un test) — sin él no compila — coste: ninguno.
Task 4: review 1 → Needs fixes (Important: imagen en cola superada por una recibida sigue saliendo y desincroniza ImageSync)
- Ruling R9: Task 6 debe usar un PNG distinto por imagen (por hash), tolerar borrados fallidos en Windows y no hacer E/S bloqueante en hilos async al llamar a broadcast_clip_image — coste: ninguno.
Task 4: minor (deferred): anillo `ended` de 32 entradas; std::fs::metadata bloqueante en broadcast_clip_image; rustfmt de image_sync.rs.
Task 4: fix round 1/5 (2 addressed, 0 open; commits 00fc9bc..4d80f9d)
Task 4: complete (commits 44373e5..4d80f9d, review clean)
Task 4: minor (deferred): cierre tardío link_closed/heartbeat de la sesión vieja con la nueva ya activa puede revertir la marca (un reenvío extra); si la app no llama mark_image_synced (fallo al escribir), X queda sin confirmar.
Task 5: complete (commits 4d80f9d..e1fb56b, review clean)
Task 5: minor (deferred): el test de difusión PC→cliente no espera peerConnected (podría ir por el envío de inicio); sin comprobar que image_dir queda solo con el archivo; sin e2e del límite exacto de 20 MiB ni de comandos stdin mal formados.
Task 6: review 1 → Needs fixes (Important: el límite de 512 MiB no cubre la conversión a RGBA; bomba L8 de 16384² → ~1 GiB y aborto)
- Ruling R10: miniaturas del historial del PC en JPEG (máx. 160 px, calidad 75, data:image/jpeg;base64) en vez de PNG — ui-state se emite hasta 4/s con el historial completo — coste: miniaturas algo peores; T7 debe aceptar ese prefijo.
- Nota: la medición de CPU de T6 sustituyó y vació el portapapeles real de Javier dos veces (sin guardar el contenido previo); avisar a Javier. Otra sesión tiene un `tauri dev` corriendo en el puerto 1420 desde las 22:46.
Task 6: minor (deferred): reintentos de borrado solo en el siguiente discard; una segunda instancia vacía la caché de la primera; pequeña carrera de borrado al reemplazar local_image; arnés de medición no versionado.
Task 6: fix round 1/5 (5 addressed, 0 open; commits 7cfb2ed..54e9b62)
Task 6: complete (commits e1fb56b..54e9b62, review clean)
Task 6: minor (deferred): tras dos lecturas de vuelta fallidas, copy_image o una imagen recibida se reenvían una vez; last_store_error nunca se reinicia.
Task 7: review 1 → Needs fixes (Important: imágenes sustituidas (R7) aparecen como «Cancelado» aunque purpose ya llega; nombre accesible engañoso)
Task 7: minor (deferred): sin test de thumbnail no-string; las canceladas de imagen siguen contando para el tope de 5 en el backend.
Task 7: fix round 1/5 (3 addressed, 0 open; commits ed021a6..47d7630)
Task 7: complete (commits 54e9b62..47d7630, review clean; sin ver en la ventana real)
Task 8: review 1 → Needs fixes (Important: regla de inicio envía el texto que acompaña a una imagen; el guard cubre la galería/permiso y descarta copias; imagen recibida en segundo plano rebota)
- Ruling R11 (Javier): para ahorrar, un único implementador Sonnet hace los arreglos de T8 y las tareas 9–11 seguidas, sin revisión por tarea; una sola revisión final al acabar — coste si mal: fallos detectados más tarde.
Task 8: minor (deferred): intercambio/pérdida de imágenes en la regla de inicio (decisión de spec); Paths.document/images no se poda con el historial tras reiniciar; copyImageFromHistory no descarta la imagen en cola; addToAlbum puede duplicar foto; GALLERY_FAILED oculta IMAGE_WRITE_FAILED; new File en finally puede lanzar.
Tasks 8fix-11: done (commits b45a22d..e5a8698, sin revisión por tarea — R11)
Final review (móvil, Sonnet): With fixes. Importantes: fallback de la lectura de vuelta puede rebotar; MIUI con DATE_TAKEN=0 deja fuera las capturas nuevas. Menores elegidos: límite de 2 min a la imagen diferida, copyImageFromHistory sin dropQueued, deleteQuietly puede lanzar.
- Ruling R12 (Javier, R11): una única tanda de arreglos sin re-revisión; verifico los tests yo — coste si mal: un arreglo sin revisar.
Final review minor (deferred): capturas fallidas no se reintentan; carrera de ensurePhotoAccess; imagen >20 MiB se relee y avisa en cada comprobación; loadSettings/Album.getAll cada 3 s; permiso parcial en Android 13+ al guardar en la galería (comprobar en el móvil).
Final fix wave: complete (c6cf17b; tests del móvil 152/152, protocolo 357/357, verificados por el controlador)
