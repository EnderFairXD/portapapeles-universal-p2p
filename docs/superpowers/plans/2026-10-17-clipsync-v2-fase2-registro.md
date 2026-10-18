# SDD ledger — plan: docs/superpowers/plans/2026-10-17-clipsync-v2-fase2-emparejamiento.md

Spec: docs/superpowers/specs/2026-10-16-clipsync-v2-design.md
Branch: main (Javier eligió main, como en la fase 1, al preguntarle). Base inicial: a60dd80

## Pre-flight scan

| Par / tarea | Produce → consume | Hallazgo |
|---|---|---|
| T1→T2 | noise-ik.json (formato fijado en T1) | OK; TS lo lee de packages/protocol/test-vectors |
| T1→T7 | StaticKeys, initiator/responder, SecureChannel | OK |
| T2→T6,T11 | NoiseIK, CipherState, KeyPair, RandomBytes, keyPairFromPrivate | OK |
| T3→T6,T7 | ClientHello/ServerHello, RejectReason, MAX_PAYLOAD_BYTES | OK |
| T4→T5 | pairing.json | OK |
| T4→T7,T9 | PairingTokens, PairedStore, PairedDevice, pairing_uri, qr_svg, lan_ipv4s, fingerprint | OK |
| T6→T8,T11 | SessionOptions con identity/serverKey/pairingToken/authorize | móvil (connection.ts) no compila entre T6 y T11 → R1 |
| T6↔T7 | T6 deja HelloMsg en messages.ts; T7 lo retira en TS y Rust y cambia messages.json | OK, secuenciales |
| T6/T7→T8 | e2e (TS cifrado vs Rust) | e2e en rojo entre T6 y T8 → R1 |
| T7→T9 | Hub::start_pairing/cancel_pairing/pairing_offer/paired_devices/forget_device, DevicePaired | OK |
| T7 headless/lib.rs mínimos → T8/T9 completan | | OK |
| T9→T10 | UiState.paired/pairing/pairNotice, comandos | OK |
| T11→T12 | ConnState.pc, status 'unpaired', pair/forgetPc | OK |
| T2 | PAIRING_TTL_MS en TS sin consumidor | R2 |
| T1,T4 | CLIPSYNC_WRITE_VECTORS | mismo mecanismo; OK |
| T3 | test Rust 65534→65518 coherente con D6 | OK |
| T6 | 13 hello en tests (11+2) | OK |
| T10 | captura del escritorio prohibida (nota fase 1) | OK, lo dice el brief |
| T12/T13 | instalar en el móvil y prueba manual requieren a Javier | R3 |

## Rulings
- Ruling R1: se acepta que la app móvil no compile (tsc) entre T6 y T11 y que el e2e falle entre T6 y T8 — evitar shims temporales, igual que R2 de la fase 1 — coste si mal: commits intermedios rotos en main (sin push).
- Ruling R2: PAIRING_TTL_MS se exporta en TS aunque nada lo consuma aún (espejo de la constante Rust, lo pide el plan) — coste si mal: una constante sin uso.
- Ruling R3: los pasos que requieren el móvil físico o a Javier (T12 Step 3, T13 Steps 2–3) se hacen al final con él; si no hay móvil por adb, el implementer lo reporta y no bloquea — coste: verificación en dispositivo diferida.

## Progreso
- Ruling R4: StaticKeys::generate() mantiene `expect` sobre getrandom::fill (Important plan-mandated de la revisión de T1) — un SO soportado (Linux/Windows) siempre da aleatoriedad y sin ella la app no puede crear su identidad de ningún modo; propagar Result solo añade fontanería a identity.rs para un caso imposible — coste si mal: abort al arrancar en un sistema sin RNG.
Task 1: complete (commits a60dd80..57b33bb, review clean salvo R4)
Task 1: minor (deferred): sin test de trama repetida/reordenada ni de prólogo distinto; rama decrypt > 65535 sin test; include_str! impide regenerar noise-ik.json desde cero; use duplicado en tests de secure.rs; #[allow(dead_code)] en mod secure (quitar en T7); re-export de ProtocolError en protocol/mod.rs.
Task 2: complete (commits 57b33bb..3f3ea95, review clean)
Task 2: minor (deferred): writeMessage cambia estado antes de fallar sin marcar failed; CipherState público sin clave = no cifra; faltan tests del iniciador con mensaje 2 truncado/alterado, split doble, rs ≠ 32, nonce ≥ 2^32; test de relleno `typeof CipherState`; s guardada por referencia y NOISE_PROLOGUE mutable; BigInt de x25519 en Hermes sin comprobar (→ T11/T13). Bench Node: ~84 handshakes/s (11,8 ms), ~69 MB/s cifrar+descifrar 48 KiB.
Task 3: review 1 → Needs fixes (Important: TS acepta sustitutos UTF-16 sueltos y Rust no; nombre truncado a mitad de emoji rompería el handshake)
- Ruling R5: ambos decoders rechazan sustitutos sueltos; encodeClientHello/encodeServerHello aplican toWellFormed; vectores nuevos — paridad TS/Rust exigida por el plan — coste si mal: un nombre con U+FFFD en vez del carácter roto.
Task 3: minor (deferred): 1e999 y anidamiento >128 en campos ignorados (JS acepta, serde no); helpers fail/str/parse duplicados entre hello y messages (TS y Rust); encode_server_hello con unwrap_or_default; ClientHello Rust con Deserialize público que salta la validación; #![allow] interno vs externo; sin vectores de BOM.
Task 3: fix round 1/5 (1 addressed, 0 open; commits a9214a9..bfd4acd)
Task 3: complete (commits 3f3ea95..bfd4acd, review clean)
Task 3: minor (deferred): pairingToken sin toWellFormed al codificar (inofensivo); asimetría JSON.parse/serde con sustitutos posible en otros JSON del móvil (clips ya pasan por toWellFormed).
Task 4: complete (commits bfd4acd..539df5e, review clean)
Task 4: minor (deferred): qr_svg devuelve "" sin log y pairing_uri no limita el nº de IPs (Docker/VPN); offer() con RNG caído devuelve oferta vacía caducada; paired.json ilegible (no NotFound) → lista vacía y el siguiente upsert pierde emparejamientos (identity.rs sí lo protege) ← revisar en la final; sin vector de emoji en el límite de 64; sin test de token erróneo de igual longitud; qr_svg_es_un_svg no comprueba 240; log duplicado identity/pairing; claves sin normalizar a minúscula; percent_encode con format! por byte; order_ips descarta 0.0.0.0 (extra).
Task 5: complete (commits 539df5e..760d0a1, review clean)
Task 5: minor (deferred): test "pk con relleno o con 44 caracteres" solo prueba '='; base64UrlToBytes no exige bits sobrantes a cero; nombre del QR sin límite en el móvil (aplicar 64 al mostrar/guardar en T11); packages/protocol sin tsc (repo).
Task 6: complete (commits 760d0a1..bdb45b1, review clean)
Task 6: minor (deferred): sin test de mensaje 2 + tramas cifradas en el mismo trozo ni de mensaje 1 + trama en el mismo trozo (el e2e de T8 por TCP lo ejercita); sin test de trama antes del mensaje 1 en el cliente; comentario obsoleto session.ts:365; spyLink depende de que randomBytes solo se use para la efímera.
- Ruling R6: SessionHost::authorize devuelve Result<(), RejectReason> en vez de &'static str (hello.rs ya tiene el enum) — tipado — coste: ninguno.
Task 7: complete (commits bdb45b1..09a3c09, review clean)
Task 7: minor (deferred): trama entre mensaje 1 y 2 → Rust emite Ready y luego protocol_error (TS cierra antes); panic dentro de tarea lectora de hub_tests no hace fallar el test ("nada tras rechazo", "algo inválido"); forget durante un handshake recrea syncs[key] y puede dar PeerConnected justo antes de PeerDisconnected; fallo al guardar un ya emparejado pierde la actualización de nombre/id en memoria; nombres de test imprecisos (caducado, hueco); E/S de paired.json bajo el Mutex del Hub; hub_tests.rs ~2090 líneas; State.unsaved añadido para emparejados sin guardar.
Task 8: complete (commits 09a3c09..444b512, review clean; e2e 19/19)
Task 8: minor (deferred): comentario erróneo de serverKey (e2e:329); stderr interpolado al llamar en mensajes de timeout; sleeps de 200 ms y aserción "sin peerConnected" duplicados; kill duplicado; forget sin comprobar el motivo de cierre del cliente; sin e2e de token ajeno no vacío; PC→cliente con 3 MiB+5 en vez de 5 MiB+7.
Task 9: complete (commits 444b512..836ce0a, review clean; tauri dev manual pendiente con Javier — R3)
Task 9: minor (deferred): Ctx::start_pairing/cancel/forget sin tests (lan_ipv4s inline); ramas de fallo duplicadas en start_pairing; forget con E/S bajo el Mutex de estado; DevicePaired tardío puede cerrar un QR nuevo; "2" literal en TXT; test "forgotten" no prueba código nuevo; extra: error «No se pudo generar el código QR».
Task 10: complete (commits 836ce0a..abe010a, review clean; comprobación visual con Javier — R3)
Task 10: minor (deferred): COMMAND_ERROR duplica textos del backend; encodeURIComponent del SVG en cada repintado; test con setTimeout(20) real; error de forget_device del backend no mapeado (sale el genérico).
Task 11: review 1 → Needs fixes (Important: con adb reverse y la app del PC cerrada, el USB da handshake_failed y desempareja tras 3 vueltas)
- Ruling R7: handshake_failed solo cuenta para el límite de 3 cuando el transporte es WiFi (adbd acepta el socket aunque el PC no escuche); se meten también forgetPc limpia lastError y contador, IDENTITY_FAILED se borra en ready, rememberPc en ready — corrige un defecto del plan (D8 «con el PC alcanzable») — coste si mal: un PC con otra clave solo por USB no se detecta como «no verificado» (se queda reintentando).
- Ruling R8: se acepta no esperar a mDNS cuando hay IPs del QR (el primer intento usa las IPs del QR) — más rápido al emparejar — coste: un aviso «PC no alcanzable» breve si las IPs del QR no sirven.
Task 11: minor (deferred): parsePairedPc no valida IPv4 ni formato de token; ConnectionManager sin tests unitarios.
Task 11: fix round 1/5 (4 addressed, 0 open; commits eb73a4e..2f2993d)
Task 11: complete (commits abe010a..2f2993d, review clean)
Task 11: minor (deferred): si una IP del QR es de otro equipo que acepta TCP en 52847, sus handshake_failed por WiFi cuentan (improbable).
Task 12: review 1 → Needs fixes (Important: «Cancelar» en el Alert de sustituir lo reabre al seguir viendo el QR)
- Ruling R9: Cancelar/descartar el Alert → router.back(); además, escanear el QR del mismo PC (misma clave) empareja sin preguntar, y el permiso de cámara se re-consulta al volver de Ajustes — coste si mal: el usuario sale del escáner al cancelar.
Task 12: minor (deferred): sin test del texto «Emparejando con…» en StatusCard; Welcome oculta un compartir pendiente mientras no hay emparejamiento; test y helper escritos a la vez (sin RED separado); .expo/types/router.d.ts se regenera arrancando expo.
Task 12: fix round 1/5 (3 addressed; nueva posible doble router.back(); commits 4142283..df982a2)
Task 12: fix round 2/5 (1 addressed, 0 open; commits df982a2..be0d8fd)
Task 12: complete (commits 2f2993d..be0d8fd, review clean; Step 3 en el móvil pendiente — R3)
Task 12: minor (deferred): left nunca se resetea (si router.back no desmonta, «Volver» deja de responder).
Task 13: review 1 → Needs fixes (Important: §3.3 se contradice sobre las IPs guardadas; §8 sin alinear con D8/R7)
Task 13: minor (deferred): docs/architecture.md aún dice «sin cifrado ni pairing» (se reescribe en la fase 5).
Task 13: fix round 1/5 (4 addressed, 0 open; commits 79b6e3e..c140d59)
Task 13: complete (commits be0d8fd..c140d59, review clean; Steps 2–3 con el móvil de Javier pendientes — R3)
Task 13: minor (deferred): §8 «(con el token del QR)» mejor «(con un token enviado)»; spec línea 3 «pendiente de revisión».
Final review: With fixes. I1: paired.json ilegible (no NotFound) → lista vacía y el siguiente upsert lo sobrescribe (desempareja todo). I2: reenvío del mensaje 1 por un atacante en la LAN → el PC emite Ready y echa a la sesión real («replaced») sin prueba de vida. M3 IPs del QR sin límite ni filtro de interfaces virtuales; M4 scan.tsx router.back sin historial; M5 identidad efímera silenciosa; M6 medidas en build __DEV__.
- Ruling R10: I2 no se arregla en esta fase — un atacante en la LAN ya puede cortar la sesión de formas más baratas (RST, ocupar los 8 huecos sin handshake) y el reenvío no rompe la confidencialidad ni la autorización; arreglarlo exige cambiar el arranque de sesión en TS y Rust — coste si mal: alguien en la LAN puede desconectar el móvil repetidamente y el PC muestra un «conectado» falso hasta 30 s.
- Ruling R11: tanda final única: I1 + M3 (filtrar docker*/br-*/veth*/virbr*/vEthernet*/VirtualBox* y máximo 4 IPs) + M4 (canGoBack ? back : replace('/')) + M5 (aviso en la UI del PC si la identidad no se pudo leer/guardar) + M6 (checklist: medir en build release/preview) — baratos y en archivos ya tocados — coste: diff final algo mayor.
- Deferred-minor triage (final): T5 «nombre del QR sin límite» ya resuelto (capName); BigInt de Hermes pasa a la prueba en el móvil; el resto sigue diferido.
Final fix wave: complete (commits c140d59..056777b, re-review: all addressed; minors: relectura de paired.json en cada fallo de contains mientras dure el fallo, aviso hasta reiniciar, unsaved no se vuelca hasta re-emparejar, sin test a nivel de Hub de unsaved+load_failed)
Pendiente con Javier (R3): instalar en el móvil (T12 Step 3), lista de comprobación de la fase 2 (y la de la fase 1), medidas en build release (handshake ≤ 1 s, ≥ 2 MB/s), comprobación visual del QR en el PC (T9/T10).
