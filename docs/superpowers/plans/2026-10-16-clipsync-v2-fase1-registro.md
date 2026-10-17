# SDD ledger — plan: docs/superpowers/plans/2026-10-16-clipsync-v2-fase1-sesion-wifi.md

Spec: docs/superpowers/specs/2026-10-16-clipsync-v2-design.md
Branch: main (Javier eligió quedarse en la rama actual al proponerle rama nueva; consentimiento para trabajar en main). Base inicial: 409e60c

## Pre-flight scan

| Par / tarea | Produce → consume | Hallazgo |
|---|---|---|
| T1→T2,T3,T4 | constants.ts, framing.ts, index.ts `export *` | index.ts debe re-exportar cada módulo nuevo; el plan solo lo dice en T1. Ruling abajo (R1). |
| T1 ↔ móvil | T1 borra types.ts, builders v1, GUEST_MODE_PORT, BLE_SERVICE_UUID | lanTransport/guestServer/bleTransport/index.tsx del móvil dejan de compilar hasta T12. R2. |
| T2→T6 | test-vectors/messages.json | Ruta include_str desde src/protocol/messages.rs = ../../../../../packages/... correcta. OK |
| T3↔T7 | ClipboardSync TS ↔ Rust | mismos 5 casos; OK |
| T4→T5 | session.ts, helpers.ts, newTransferId | mismo archivo, secuenciales; OK |
| T4/T5→T8 | Rust replica rol servidor | regla de inicio y límites idénticos; OK |
| T6→T10 | T6 deja lib.rs sin servidor | la app de PC no sirve nada entre T6 y T10; aceptable (R3) |
| T7→T8 | core/mod.rs, FileReceiver | OK |
| T8→T9 | Transport=usb desde loopback; HubEvent tag "type" | e2e espera usb; Transfer(newtype) internamente etiquetado OK |
| T8→T10 | HubEvent, Hub API | OK |
| T10→T11 | UiState (camelCase: clipboardError, clipNotice) | OK |
| T12→T13 | connection, useConnection, files, settings | index.tsx placeholder en T12 y reescrito en T13; OK |
| T12 files.ts | saneado "igual que Rust" | no hay helper TS compartido; R4 |
| T1 | tests vs código | OK |
| T2 | 33×65534 > 2 MiB; 262144 emojis = 1 MiB | OK |
| T3 | OK | |
| T4 | Timers sin setTimeout: latido por intervalo | OK |
| T5 | tamaños incluyen 0 y múltiplos de 48 KiB | OK |
| T6 | rename_all_fields necesita serde ≥ 1.0.183 | OK |
| T9 | cargo build dentro de beforeAll: timeout largo | R5 |
| T11 | "2,5 MB" usa coma decimal y MiB (1024²) | OK, coherente con test |
| T13/T14 | instalar en el móvil y prueba manual requieren a Javier | R6 |

## Rulings
- Ruling R1: cada tarea que crea un módulo en packages/protocol/src lo añade a index.ts con `export *` — el plan lo implica para T1 — coste si mal: ninguno.
- Ruling R2: se acepta que el móvil no compile entre T1 y T12 (sus archivos v1 se borran en T12) — evitar shims temporales — coste si mal: commits intermedios con app móvil rota (no se publican).
- Ruling R3: la app de PC queda sin servidor entre T6 y T10 — mismo motivo — coste: ninguno fuera de la rama.
- Ruling R4: el saneado de nombres del móvil se implementa en apps/mobile/src/lib/files.ts replicando las reglas de T7 (SAF ya evita colisiones) — coste si mal: reglas divergentes en móvil.
- Ruling R5: el e2e usa testTimeout/hookTimeout de 300 s para permitir el cargo build — coste: e2e lento.
- Ruling R6: los pasos que requieren el móvil físico o a Javier se hacen al final con él; si no hay móvil por adb, el implementer lo reporta y no bloquea — coste: verificación en dispositivo diferida.
- Ruling R7: T1–T3 se despachan juntos a un implementer y una revisión (mismo paquete, pequeñas, secuenciales) — ahorro de coste — coste si mal: revisión menos granular.

## Progreso
Task 1-3: complete (commits 409e60c..3724965, review clean)
Task 1-3: minor (deferred): pnpm-lock añadió línea deprecated de react-native-zeroconf; paquete sin tsconfig/typescript; README de packages/protocol aún v1; imports sin extensión con type:module; surrogates sueltos no cubiertos; encode no comparado byte a byte con vectores.
- Ruling R8: el receptor rechaza `clip` > MAX_CLIP_BYTES en la Session (T4) y el MessageDecoder rechaza tramas 0x03 vacías (fix en T4, vector nuevo) — cierra crecimiento de memoria sin límite y alinea TS/Rust — coste si mal: un clip >1 MiB legítimo cierra sesión (no debería existir, el emisor no lo envía).
- Ruling R9: en messages.json, los consumidores distinguen `{"error":true}` por ausencia de `kind`/`data` (decisión del implementer); se pasa a T6 — coste si mal: Rust mal interpreta vectores, lo detectaría su propio test.
- Decisiones implícitas a replicar en Rust (T6): 0x02 con fragmentos 0x03 pendientes = error; campos JSON desconocidos se ignoran.
- Ruling R10: regla de inicio con hello cliente-primero (opción B): `clipSyncFor(peer: PeerInfo | null)`, el cliente lo llama con null antes del handshake — coherente con Noise IK de la fase 2 — coste si mal: cambiar la firma en móvil y Rust.
- Ruling R11: se aprueban los extras de T4: un clip con hash que no coincide con el texto → close "protocol_error"; motivo extra "internal_error" para fallos no de protocolo — Rust los copia — coste si mal: ninguno relevante.
Task 4: review 1 → Needs fixes (Important: server ready antes de la regla de inicio; JSON > 2 MiB con texto ≤ 1 MiB lanza en vez de too_large)
Task 4: minor (deferred): cliente re-chequea su clip anunciado (dos sesiones simultáneas); start() tras close() deja intervalo; guard closed tras ready; fail() descarta el error; tests con timers reales sin cerrar; vector 0x03-vacío+datos redundante; linkPair descarta datos en vuelo al cerrar (→ avisar a T5); faltan tests de 0x02/file_* antes del hello y close desde listener; SHA-256 repetido por clip.
Task 4: fix round 1/5 (2 addressed, 0 open; commits 845859a..5a00e51)
Task 4: complete (commits 3724965..5a00e51, review clean)
Task 4: minor (deferred): ready/localClipSuperseded pueden emitirse tras closed si write falla en pushClip; prepareClip mapea cualquier ProtocolError a too_large; write con catch desnudo; localClipSuperseded innecesario si ambos tienen el mismo texto nuevo.
- Ruling R12: T5 (mismo archivo) incorpora: guard `if (closed) return` antes de becomeReady y del emit superseded; linkPair entrega datos en vuelo antes de cerrar; tests cierran sesiones / usan fakeTimers — baratos y tocan lo que T5 usa — coste: diff de T5 algo mayor.
- Para Rust (T8): regla de inicio antes de ready; al ceder, el servidor marca su texto local como sincronizado y emite localClipSuperseded; clip cuyo JSON > 2 MiB = too_large y no se anuncia en willSendClip; hash de clip que no coincide → protocol_error; motivos de cierre heartbeat_timeout/protocol_error/link_closed/closed/internal_error; mensajes entrantes en serie.
Task 5: review 1 → Needs fixes (Important: cancelar en el evento active envía file_cancel antes de file_start)
Task 5: minor (deferred): sin tests de close() con finish/openSink pendientes; errores inesperados tratados distinto en emisor (se tragan) y receptor (cierran); teardown de cola duplicado (session.ts:225-228/253-257); sin test e2e de exactamente 1/2 MiB; session.ts 727 líneas (propuesta split transfers.ts); endedIn crece sin límite.
- Ruling R13: se aceptan los cambios de T5: link.onClose pasa por la cola serie; abort() tras finish() borra el archivo guardado (consistente con "fallido en ambos lados"); sendFile lanza RangeError con tamaño inválido; size_mismatch si el tamaño declarado no coincide — Rust (T7/T8) y móvil (T12, borrar documento SAF; obtener tamaño real) deben copiarlo — coste si mal: un archivo ya verificado se borra si la conexión cae justo antes de file_result.
- Ruling R14: no se divide session.ts en transfers.ts ahora — es el único consumidor y está bien probado; se deja como minor para la revisión final — coste si mal: archivo grande de mantener.
Task 5: fix round 1/5 (2 addressed, 0 open; commits 1692b57..5abd308)
Task 5: complete (commits 5a00e51..5abd308, review clean)
Task 5: minor (deferred): orden de eventos anidado (cancelled antes de active para listeners posteriores); rama write-falla-tras-file_start sin test; onClose en cola: sink colgado retrasa closed (en la práctica 10 s por ping fallido).
Task 6: review 1 → Needs fixes (Important: encode_control entra en pánico con clips válidos cuyo JSON > 2 MiB; panic=abort mata la app)
- Ruling R15: `encode_control` en Rust devuelve `Result<Vec<Vec<u8>>, ProtocolError>` (se aparta de la firma del plan) — con panic=abort un pánico por contenido del usuario cierra la app — coste si mal: ninguno, solo cambia la firma para T8.
Task 6: minor (deferred): validación duplicada entre check_message y validate_control; divergencia serde_json/JS con números fuera de rango; vectores solo de decodificación; Cargo.toml con dev-deps tras profile; comentarios obsoletos en usb.rs/lib.rs; sin test del TXT v=2.
Task 6: fix round 1/5 (2 addressed, 0 open; commits dcb4d6b..1273647)
Task 6: complete (commits 5abd308..1273647, review clean)
Task 7: review 1 → Needs fixes (Important: fallback rename puede sobrescribir un archivo existente)
- Ruling R16: en el fix de T7 se incluyen menores relacionados (nombre reservado tras truncar, quitar caracteres bidi/formato para evitar falsear la extensión, higiene de tests, stem vacío → archivo) — mismo código, coste bajo — coste si mal: diff algo mayor.
Task 7: minor (deferred): COM¹/LPT¹ no cubiertos; remove_file ignorado; módulo `core` sombrea el crate core (plan-mandated); sha256_hex posiblemente duplicado entre clip_sync y files.
Task 7: fix round 1/5 (5 addressed, 0 open; commits f211e55..29dc4eb)
Task 7: complete (commits 1273647..29dc4eb, review clean)
Task 7: minor (deferred): candidatos "stem (n).ext"/.part pueden pasar de 200 bytes; otros invisibles (U+2060–2064, U+061C…) permitidos; test de fallo de rename solo en Unix.
Task 8: review 1 → Needs fixes (Important: clips escritos en sesión moribunda se marcan sincronizados en el ClipboardSync compartido por dispositivo y se pierden al reconectar)
- Ruling R17: el Hub solo marca un clip tras escritura exitosa con sesión abierta, y restablece el ClipboardSync del dispositivo (None) al terminar una sesión por link_closed/heartbeat_timeout y al llegar un hello nuevo para un device_id con sesión previa (antes de su regla de inicio) — cubre TCP medio abierto — coste si mal: algún clip duplicado (lo absorbe el anti-rebote del móvil).
- Ruling R18: el móvil (T12) debe hacer lo mismo: restablecer su ClipboardSync tras un cierre anómalo (link_closed/heartbeat_timeout) antes de reconectar — simetría con R17 — coste si mal: clips del móvil perdidos al reconectar.
- Ruling R19: en el fix de T8 se incluyen menores: queued síncrono desde send_file; sin eprintln! en código no-test (panic=abort); límite de longitud de device_id (128 B, si no protocol_error) y device_name (64 caracteres, truncado) — coste: ninguno.
Task 8: minor (deferred): timeout de escritura fijo de 30 s sin test y alarga el latido hasta ~70 s; ciclo Arc Hub↔sesiones sin shutdown (Command(None) muerto); E/S de disco bloqueante en hilos async (abort/remove_file, File::open en send_file); syncs por device_id nunca se reducen; huecos de tests (file_cancel del par, size_mismatch, ack > sent, 0x02 antes del hello, cancelar en cola, transferencias simultáneas, replaced con transferencias); helper FallaEnFileResult frágil; DRY de TransferUpdate en close; documentar para la UI (T10): PeerConnected(nuevo) antes de PeerDisconnected(viejo, replaced), Transfer sin session_id, name entrante sin sanear (usar location); MIME saliente siempre octet-stream.
Task 8: fix round 1/5 (4 addressed, 0 open; nueva carrera menor introducida por R17: el cierre tardío de la sesión vieja borra las marcas de la nueva; commits 11d6ec8..1caef85)
- Ruling R20: se arregla ya la carrera de R17 (ronda 2): no restablecer si existe otra sesión del mismo device_id — la introdujo mi propia regla y puede cruzar clips — coste: una ronda más.
Task 8: minor (deferred): State.syncs nunca se poda; expect en discovery.rs al arrancar (no alcanzable desde la red); orden queued1, queued2, active1 (la UI no debe suponer intercalado).
Task 8: fix round 2/5 (1 addressed, 0 open; commits 1caef85..1d39408)
Task 8: complete (commits 29dc4eb..1d39408, review clean)
Task 8: minor (deferred): carrera estrecha en que N cae con link_closed mientras A (vieja) sigue en el mapa → no se restablece (best-effort; contador de generación lo cerraría).
Task 9: complete (commits 1d39408..ba1bbd7, review clean; e2e no encontró divergencias TS/Rust)
Task 9: minor (deferred): aserción débil del hello del PC; afterEach no tolera fallos; sin child.on('error') ni carrera listening/exited; build de cargo sin timeout; `bad` solo comprobado en un test; onClose tardío en nodeLink; sin e2e PC→cliente de 0 bytes / múltiplo de 48 KiB; informe dice mal que el proceso sale si stdout cae.
- Ruling R21: TransferUpdate de Rust serializa error/location como null y TS los omite; la UI (T10/T11/T12) trata null como ausente — coste si mal: ninguno.
Task 10: review 1 → Needs fixes (Important: items `local` se duplican sin límite en cada reconexión)
- Ruling R22: el historial del PC registra `out` solo si hay al menos un móvil conectado; `local` se omite si el texto más reciente del historial es el mismo — evita historial engañoso/inundado — coste si mal: un texto local no aparece en el historial.
Task 10: minor (deferred): snapshot clona el historial completo (hasta 50×1 MiB) en cada emisión (plan-mandated); send_files síncrono con File::open en hilo principal; fallos parciales de send_files solo en stderr; load_device_id sin tests ni escritura atómica; log()/lock() duplicados y classify_local_clip replica prepare_clip; fallo al abrir 52847 no llega a la UI; mismo texto tras contenido no-texto no se detecta; pnpm-lock con dos @tauri-apps/api (2.11.1 y 2.12.4) y tauri-plugin-dialog "2" suelto en Cargo; la comprobación de Wayland escribió en el portapapeles real de Javier (sin cambios de sistema).
Task 10: fix round 1/5 (2 addressed, 0 open; commits d9741dc..5bc5b90)
Task 10: complete (commits ba1bbd7..5bc5b90, review clean)
Task 10: minor (deferred): texto copiado sin móvil que luego gana la regla de inicio no aparece en el historial; dedup solo contra el texto más reciente (A,B,A,B crece).
- Nota: el implementer de T11 capturó la pantalla con cosmic-screenshot y salieron ventanas personales de Javier; borró la imagen sin usarla. Avisar a Javier.
Task 11: review 1 → Needs fixes (Important: Transfer.error sin traducir y sin sanear; "replaced"/"closed" en inglés; texto del móvil mostrado tal cual)
- Ruling R23: no se añade periodo de gracia en "Conectado" (la sustitución nunca pasa por "Esperando"; un hueco real es una desconexión real) — coste si mal: parpadeo breve en una reconexión lenta.
- Ruling R24: CSP restrictiva diferida (no se puede verificar en la ventana real sin romper IPC a ciegas) — coste si mal: sin defensa en profundidad ante inyección.
Task 11: minor (deferred): destello inicial "Esperando" antes de get_state; main.ts con lógica de toast y textos duplicados; unidades B/KB/MB/GB (no siempre MiB); sin tests de main.ts ni de fila reutilizada active→failed; aria-disabled en div; hora sin fecha en historial; nombre View.top confuso; csp:null con withGlobalTauri; ui-state con historial completo; sin comprobación en ventana WebKitGTK real (line-clamp, color-scheme, arrastrar y soltar).
Task 11: fix round 1/5 (2 addressed, 0 open; commits f7dac8d..4986bbb)
Task 11: complete (commits 5bc5b90..4986bbb, review clean)
Task 11: minor (deferred): errorMessage() de main.ts pasa errores de invoke tal cual al toast; fallo de listen solo en consola.
Task 12: complete (commits 4986bbb..61bcc1d, review clean)
- Ruling R25: T13 incorpora menores de T12 que tocan connection.ts/files.ts: re-comprobar AppState al cerrar el selector; retardo mínimo de reconexión si la sesión vivió poco; no anotar `out` si la escritura falló; restablecer ClipboardSync también en pause(); quitar script ios; mostrar "No se pudo leer el tamaño del archivo" — baratos y en los mismos archivos — coste: diff de T13 mayor.
Task 12: minor (deferred): timer de destroy de tcpLink se limpia antes de end(); lógica del manager sin tests; expo-share-intent ^8.0.1 compatibilidad SDK 57 no verificada; TextDecoder de Hermes, SAF y tiempos de NSD sin probar en dispositivo; prebuild regeneró android/ (requiere ANDROID_HOME).
Task 13: review 1 → Needs fixes (Important: pausa al cerrar el selector corta la sesión (causada por R25-1); pickAndSend sobrescribe errores; compartir pendiente se borra al ir a segundo plano; ShareSender pierde errores y reintenta rechazados)
- Ruling R26: sustituye R25-1: al cerrar el selector se re-comprueba AppState tras 1000 ms y solo se pausa si sigue en background — Android entrega el resultado antes de onResume — coste si mal: sesión viva hasta 1 s más en segundo plano.
- Ruling R27: lo compartido pendiente se conserva al ir a segundo plano (resetOnBackground: false) hasta enviarse, con «Cancelar» — el usuario va al PC a abrir ClipSync justo entonces — coste si mal: un envío pendiente sobrevive más de lo esperado.
Task 13: minor (deferred): wiring de connection/files sin tests de AppState; cabecera duplicada index/settings; sin pista visible para cerrar el aviso de error; filas fallidas/canceladas sin "limpiar"; failureText del móvil y ERROR_TEXT del PC sin constante compartida; R25-4 reenvía el portapapeles al volver de segundo plano (confirmar en dispositivo que no rebota); sonda de archivo de 0 bytes sin verificar en dispositivo.
Task 13: fix round 1/5 (5 addressed, 0 open; commits 63c5112..1ebaee7)
Task 13: complete (commits 61bcc1d..1ebaee7, review clean; pendiente instalar en el móvil — R6)
Task 13: minor (deferred): un compartir nuevo sustituye a uno pendiente sin aviso; sendSharedFile acopla rejected a INVALID_FILE_SIZE; wiring de pauseCheck sin test directo.
- Ruling R28: en T14 el Step 2 (recorrer la lista con Javier en el móvil) queda para cuando Javier conecte el móvil; el implementer hace Steps 1, 3 y 4 — coste: verificación en dispositivo pendiente.
Task 14: complete (commits 1ebaee7..e734f44, review clean; Step 2 pendiente con Javier — R28)
Task 14: minor (deferred): scripts raíz `pnpm --filter mobile/desktop` con nombres de paquete incorrectos (preexistente); README menciona "cae al siguiente" (semántica v1).
Final review: With fixes. C1 (Critical): el móvil restablece su ClipboardSync (R18, R25-4, y en memoria en arranque en frío) y por eso siempre gana la regla de inicio, pisando el texto del PC. I1: la sesión se cierra al ir a segundo plano con transferencias en curso. I2: fallo al abrir 52847 invisible en la UI. M1 surrogates sueltos → bucle de reconexión; M2 recursos ante pares hostiles; M4 clip de inicio anotado aunque no se envíe; M5 errores de arboard en inglés; M6 mDNS frágil; M7 ping detrás de la cola; M10 scripts raíz y cabecera usb.rs.
- Ruling R29 (sustituye R18 y R25-4 en el móvil): el móvil persiste su hash sincronizado *confirmado* en settings.json; no se restablece en pause() ni en cierres anómalos; tras cualquier cierre se vuelve al último hash confirmado. Confirmación en la Session TS: un clip enviado queda tentativo; la Session envía un ping justo después y lo confirma cuando llega el pong correspondiente (el PC procesa en serie, así que ese pong prueba que leyó el clip); un clip recibido se confirma al instante. El PC (R17) no cambia: sus restablecimientos son inocuos porque el móvil gana solo si de verdad cambió — coste si mal: un clip recién enviado podría reenviarse una vez.
- Ruling R30: se arreglan en la misma tanda I1, I2, M1, M2, M4, M5, M6 (caché de la última dirección y escaneo continuo en primer plano), M7 y M10; M3, M8, M9 quedan diferidos — coste: tanda de arreglos grande.
Final fix wave: complete (commits e734f44..485afca, re-review: all addressed; 4 minors parked: copyFromHistory marca confirmado (≠ PC), nombre de test erróneo, orden de avisos, caché de dirección obsoleta cuesta 2 s)
