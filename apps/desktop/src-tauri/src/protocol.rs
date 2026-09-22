//! Réplica en Rust de `packages/protocol/src/types.ts`.
//! Cualquier cambio en el schema (`packages/protocol/schema/sync-message.schema.json`)
//! debe reflejarse aquí a mano y en el paquete TypeScript, con bump de PROTOCOL_VERSION.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = "1.0.0";
pub const DEFAULT_TCP_PORT: u16 = 52847;

/// Forma completamente cualificada esperada por `mdns-sd` (ServiceInfo::new).
/// Debe coincidir con MDNS_FULL_SERVICE_TYPE en packages/protocol/src/constants.ts.
pub const MDNS_FULL_SERVICE_TYPE: &str = "_p2pclip._tcp.local.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextPayload {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPayload {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePayload {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub size: u64,
    #[serde(rename = "chunkIndex")]
    pub chunk_index: u32,
    #[serde(rename = "chunkTotal")]
    pub chunk_total: u32,
    #[serde(rename = "chunkData")]
    pub chunk_data: String,
}

/// Adyacentemente etiquetado: en JSON produce `{ "type": "...", "payload": {...} }`,
/// exactamente la forma que define el schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "lowercase")]
pub enum SyncPayload {
    Text(TextPayload),
    File(FilePayload),
    Token(TokenPayload),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMessage {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub timestamp: i64,
    pub checksum: String,
    #[serde(flatten)]
    pub payload: SyncPayload,
}

impl SyncMessage {
    /// Extrae un resumen legible para logs, sin volcar el contenido completo.
    pub fn describe(&self) -> String {
        match &self.payload {
            SyncPayload::Text(p) => {
                let preview: String = p.content.chars().take(60).collect();
                format!("text ({} chars): \"{}\"", p.content.chars().count(), preview)
            }
            SyncPayload::Token(p) => format!(
                "token{}",
                p.label
                    .as_ref()
                    .map(|l| format!(" [{l}]"))
                    .unwrap_or_default()
            ),
            SyncPayload::File(p) => format!(
                "file \"{}\" ({} bytes, chunk {}/{})",
                p.file_name,
                p.size,
                p.chunk_index + 1,
                p.chunk_total
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_text_message() {
        let original = SyncMessage {
            protocol_version: PROTOCOL_VERSION.to_string(),
            id: "b3f6c9de-2f2e-4b7a-9b6b-5b6a8f5b6a8f".to_string(),
            device_id: "a1a1a1a1-b2b2-4c4c-9d9d-e5e5e5e5e5e5".to_string(),
            timestamp: 1_732_300_800_000,
            checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85".to_string(),
            payload: SyncPayload::Text(TextPayload {
                content: "https://example.com/pedido/12345".to_string(),
            }),
        };

        let json = serde_json::to_string(&original).expect("serializa");
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"payload\":{\"content\""));

        let parsed: SyncMessage = serde_json::from_str(&json).expect("deserializa");
        match parsed.payload {
            SyncPayload::Text(p) => assert_eq!(p.content, "https://example.com/pedido/12345"),
            _ => panic!("se esperaba SyncPayload::Text"),
        }
        assert_eq!(parsed.id, original.id);
    }
}
