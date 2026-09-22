# @portapapeles/protocol

Fuente única de verdad para el mensaje que intercambian el cliente móvil (Expo/React Native) y el cliente de escritorio (Tauri/Rust), sin importar el transporte (LAN, USB o Bluetooth).

## Contenido

- [`schema/sync-message.schema.json`](./schema/sync-message.schema.json) — JSON Schema (draft 2020-12) del `SyncMessage`. Define tres variantes de `payload` según `type`: `text`, `file` (fragmentado en chunks) y `token`.

## Próximos pasos (fuera de alcance de este scaffold)

- Generar tipos TypeScript desde el schema (ej. `quicktype` o `json-schema-to-typescript`) para consumir en `apps/mobile`.
- Generar structs Rust con `serde`/`schemars` para `apps/desktop`.
- Cualquier cambio en `sync-message.schema.json` debe ir acompañado de un bump de `protocolVersion` y notas de compatibilidad, ya que ambos clientes lo validan de forma independiente sin un servidor central que arbitre versiones.
