# @clipsync/protocol

Fuente única de verdad para el mensaje que intercambian el cliente móvil (Expo/React Native) y el cliente de escritorio (Tauri/Rust), sin importar el transporte (LAN, USB o Bluetooth).

## Contenido

- [`schema/sync-message.schema.json`](./schema/sync-message.schema.json) — JSON Schema (draft 2020-12) del `SyncMessage`, documentación normativa del formato. Define tres variantes de `payload` según `type`: `text`, `file` (fragmentado en chunks) y `token`.
- [`src/types.ts`](./src/types.ts) — Tipos TypeScript escritos a mano que reflejan el schema, consumidos directamente como fuente por Metro (no requiere paso de build).
- [`src/constants.ts`](./src/constants.ts) — `PROTOCOL_VERSION`, puerto TCP por defecto y el nombre del servicio mDNS en sus dos formas (bare para `react-native-zeroconf`, cualificada para `mdns-sd`).
- [`src/index.ts`](./src/index.ts) — `buildTextMessage()`, `buildFileMessage()` e `isSyncMessage()` (validación de forma en runtime).

El lado Rust (`apps/desktop/src-tauri/src/protocol.rs`) no importa este paquete (no se puede desde Rust); replica manualmente la misma forma con `serde`. **Cualquier cambio en `schema/sync-message.schema.json` debe reflejarse a mano en `src/types.ts` (TS) y en `protocol.rs` (Rust), y debe ir acompañado de un bump de `PROTOCOL_VERSION`**, ya que ambos clientes lo validan de forma independiente sin un servidor central que arbitre versiones.

### Archivos fragmentados (`type: 'file'`)

Un archivo se manda como varios `SyncMessage`, uno por chunk, con estas reglas:

- **`id` es el id de la transferencia, no del chunk**: todos los chunks de un mismo archivo comparten el mismo `id` (así lo dice la descripción del campo en el schema) — es lo que el receptor usa para agruparlos por `chunkIndex`/`chunkTotal` y reensamblarlos.
- **`checksum` es por chunk**, del `chunkData` en base64 de *ese* chunk — no un hash del archivo completo. Calcular el hash del archivo entero exigiría releerlo completo antes de fragmentar, justo el problema de memoria que la fragmentación evita. La integridad end-to-end del archivo reensamblado queda pendiente de un campo de checksum de transferencia dedicado (fuera de alcance por ahora).
- Implementación de referencia: `apps/mobile/src/lib/lanTransport.ts` (`sendFileMessage`, lee con `File.open('r')`/`FileHandle.readBytes()` para no cargar el archivo entero en memoria) y `apps/desktop/src-tauri/src/transport.rs` (`handle_file_chunk`/`write_reassembled_file`, acumula chunks por `id` y escribe el archivo reensamblado en `~/Downloads/ClipSync/`).

## Por qué el cálculo de checksum/UUID no vive aquí

`buildTextMessage()` recibe `id` y `checksum` ya calculados por quien lo llama, en vez de calcularlos internamente. Esto mantiene el paquete sin dependencias de runtime (ni `expo-crypto` ni ningún polyfill de `crypto` para Node/Rust), para que siga siendo consumible desde cualquier entorno JS. En `apps/mobile` se generan con `expo-crypto` (`Crypto.randomUUID()`, `Crypto.digestStringAsync`), el módulo recomendado por Expo para esto.

## Próximos pasos (fuera de alcance de la Fase 2)

- Generar tipos automáticamente desde el schema (ej. `quicktype` o `json-schema-to-typescript`) para eliminar el mantenimiento manual entre `types.ts` y `protocol.rs`.
- Validación completa contra el JSON Schema (ej. `ajv`) en vez del chequeo de forma manual de `isSyncMessage()`.
