# @portapapeles/protocol

Fuente única de verdad para el mensaje que intercambian el cliente móvil (Expo/React Native) y el cliente de escritorio (Tauri/Rust), sin importar el transporte (LAN, USB o Bluetooth).

## Contenido

- [`schema/sync-message.schema.json`](./schema/sync-message.schema.json) — JSON Schema (draft 2020-12) del `SyncMessage`, documentación normativa del formato. Define tres variantes de `payload` según `type`: `text`, `file` (fragmentado en chunks) y `token`.
- [`src/types.ts`](./src/types.ts) — Tipos TypeScript escritos a mano que reflejan el schema, consumidos directamente como fuente por Metro (no requiere paso de build).
- [`src/constants.ts`](./src/constants.ts) — `PROTOCOL_VERSION`, puerto TCP por defecto y el nombre del servicio mDNS en sus dos formas (bare para `react-native-zeroconf`, cualificada para `mdns-sd`).
- [`src/index.ts`](./src/index.ts) — `buildTextMessage()` y `isSyncMessage()` (validación de forma en runtime).

El lado Rust (`apps/desktop/src-tauri/src/protocol.rs`) no importa este paquete (no se puede desde Rust); replica manualmente la misma forma con `serde`. **Cualquier cambio en `schema/sync-message.schema.json` debe reflejarse a mano en `src/types.ts` (TS) y en `protocol.rs` (Rust), y debe ir acompañado de un bump de `PROTOCOL_VERSION`**, ya que ambos clientes lo validan de forma independiente sin un servidor central que arbitre versiones.

## Por qué el cálculo de checksum/UUID no vive aquí

`buildTextMessage()` recibe `id` y `checksum` ya calculados por quien lo llama, en vez de calcularlos internamente. Esto mantiene el paquete sin dependencias de runtime (ni `expo-crypto` ni ningún polyfill de `crypto` para Node/Rust), para que siga siendo consumible desde cualquier entorno JS. En `apps/mobile` se generan con `expo-crypto` (`Crypto.randomUUID()`, `Crypto.digestStringAsync`), el módulo recomendado por Expo para esto.

## Próximos pasos (fuera de alcance de la Fase 2)

- Generar tipos automáticamente desde el schema (ej. `quicktype` o `json-schema-to-typescript`) para eliminar el mantenimiento manual entre `types.ts` y `protocol.rs`.
- Validación completa contra el JSON Schema (ej. `ajv`) en vez del chequeo de forma manual de `isSyncMessage()`.
