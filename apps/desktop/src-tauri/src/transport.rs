//! Servidor TCP de la LAN: acepta conexiones, lee mensajes NDJSON (un `SyncMessage` por
//! línea — el propio serializador JSON escapa cualquier salto de línea embebido en el
//! contenido, así que "una línea = un mensaje" es un framing seguro) y los imprime.
//!
//! Los archivos llegan fragmentados (ver `apps/mobile/src/lib/lanTransport.ts`): cada
//! chunk es su propia conexión/mensaje NDJSON, todos comparten el mismo `id` de
//! `SyncMessage` (actúa como id de transferencia). Este módulo los va acumulando en
//! `FileTransfers` hasta tener todos los `chunkTotal`, y entonces reensambla y escribe
//! el archivo final en disco.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::prelude::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::protocol::{FilePayload, SyncMessage, SyncPayload};

struct PendingFile {
    file_name: String,
    chunk_total: u32,
    chunks: HashMap<u32, Vec<u8>>,
}

/// Transferencias de archivo en curso, indexadas por el `id` (compartido por todos los
/// chunks de un mismo archivo). Compartido entre todas las conexiones vía `Arc<Mutex<_>>`
/// porque cada chunk llega en su propia conexión TCP, potencialmente concurrente.
type FileTransfers = Arc<Mutex<HashMap<String, PendingFile>>>;

pub async fn run_server(port: u16) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    println!("[TCP] Escuchando en 0.0.0.0:{port}");

    let transfers: FileTransfers = Arc::new(Mutex::new(HashMap::new()));

    loop {
        let (socket, peer_addr) = listener.accept().await?;
        println!("[TCP] Cliente conectado desde {peer_addr}");
        let transfers = transfers.clone();

        tokio::spawn(async move {
            if let Err(err) = handle_connection(socket, peer_addr.to_string(), transfers).await {
                println!("[TCP] Conexión con {peer_addr} finalizada con error: {err}");
            } else {
                println!("[TCP] Conexión con {peer_addr} cerrada");
            }
        });
    }
}

async fn handle_connection(
    socket: tokio::net::TcpStream,
    peer_addr: String,
    transfers: FileTransfers,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = socket.into_split();
    let mut lines = BufReader::new(read_half).lines();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<SyncMessage>(&line) {
            Ok(message) => {
                let checksum_ok = verify_checksum(&message);
                println!(
                    "[TCP] Mensaje recibido de {peer_addr} — id={} device={} tipo={} checksum_ok={}",
                    message.id,
                    message.device_id,
                    message.describe(),
                    checksum_ok
                );

                if let SyncPayload::File(payload) = &message.payload {
                    if let Err(err) = handle_file_chunk(&message.id, payload, &transfers) {
                        println!("[TCP] Error procesando chunk de \"{}\": {err}", payload.file_name);
                    }
                }

                write_half.write_all(b"OK\n").await?;
            }
            Err(err) => {
                println!("[TCP] Línea de {peer_addr} no es un SyncMessage válido: {err}");
                write_half.write_all(b"ERROR invalid_message\n").await?;
            }
        }

        // El protocolo actual es una conexión = un mensaje (cada chunk incluido). Si
        // seguíamos el loop hacia next_line(), nos quedábamos esperando más datos que el
        // cliente nunca manda — interbloqueo que colgaba la UI móvil indefinidamente.
        break;
    }

    write_half.shutdown().await?;
    Ok(())
}

fn handle_file_chunk(
    transfer_id: &str,
    payload: &FilePayload,
    transfers: &FileTransfers,
) -> Result<(), String> {
    let bytes = BASE64_STANDARD
        .decode(&payload.chunk_data)
        .map_err(|e| format!("chunk base64 inválido: {e}"))?;

    let mut guard = transfers
        .lock()
        .map_err(|_| "el lock de transferencias está envenenado".to_string())?;

    let entry = guard.entry(transfer_id.to_string()).or_insert_with(|| PendingFile {
        file_name: payload.file_name.clone(),
        chunk_total: payload.chunk_total,
        chunks: HashMap::new(),
    });
    entry.chunks.insert(payload.chunk_index, bytes);

    println!(
        "[TCP] Chunk {}/{} recibido para \"{}\" ({}/{} guardados)",
        payload.chunk_index + 1,
        payload.chunk_total,
        entry.file_name,
        entry.chunks.len(),
        entry.chunk_total
    );

    if entry.chunks.len() as u32 >= entry.chunk_total {
        let entry = guard
            .remove(transfer_id)
            .expect("la entrada existe: se acaba de comprobar arriba bajo el mismo lock");
        drop(guard);
        let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir).join("ClipSync");
        write_reassembled_file(entry, &dir)?;
    }

    Ok(())
}

fn write_reassembled_file(entry: PendingFile, dir: &std::path::Path) -> Result<(), String> {
    let mut buffer = Vec::new();
    for i in 0..entry.chunk_total {
        let chunk = entry
            .chunks
            .get(&i)
            .ok_or_else(|| format!("falta el chunk {i} al reensamblar \"{}\"", entry.file_name))?;
        buffer.extend_from_slice(chunk);
    }

    std::fs::create_dir_all(dir).map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;

    let dest = dir.join(&entry.file_name);
    std::fs::write(&dest, &buffer).map_err(|e| format!("no se pudo escribir {}: {e}", dest.display()))?;

    println!(
        "[TCP] Archivo reensamblado: \"{}\" ({} bytes) → {}",
        entry.file_name,
        buffer.len(),
        dest.display()
    );

    Ok(())
}

/// Para `text`/`token`, hash del `content`. Para `file`, cada chunk trae el checksum de su
/// propio `chunkData` en base64 (no del archivo completo — calcular eso exigiría releer
/// el archivo entero, justo el problema de memoria que la fragmentación evita). La
/// integridad del archivo reensamblado completo queda pendiente para cuando exista un
/// checksum de transferencia dedicado en el protocolo.
fn verify_checksum(message: &SyncMessage) -> bool {
    let content_bytes: &[u8] = match &message.payload {
        SyncPayload::Text(p) => p.content.as_bytes(),
        SyncPayload::Token(p) => p.content.as_bytes(),
        SyncPayload::File(p) => p.chunk_data.as_bytes(),
    };

    let digest = Sha256::digest(content_bytes);
    let computed = hex::encode(digest);
    computed == message.checksum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{FilePayload, PROTOCOL_VERSION};

    fn file_message(chunk_data: String, checksum: String) -> SyncMessage {
        SyncMessage {
            protocol_version: PROTOCOL_VERSION.to_string(),
            id: "transfer-1".to_string(),
            device_id: "device-1".to_string(),
            timestamp: 0,
            checksum,
            payload: SyncPayload::File(FilePayload {
                file_name: "a.txt".to_string(),
                mime_type: "text/plain".to_string(),
                size: 11,
                chunk_index: 0,
                chunk_total: 1,
                chunk_data,
            }),
        }
    }

    #[test]
    fn verifies_checksum_of_file_chunk_base64() {
        let chunk_data = BASE64_STANDARD.encode(b"hello chunk");
        let checksum = hex::encode(Sha256::digest(chunk_data.as_bytes()));
        assert!(verify_checksum(&file_message(chunk_data, checksum)));
    }

    #[test]
    fn detects_corrupted_file_chunk_checksum() {
        let chunk_data = BASE64_STANDARD.encode(b"hello chunk");
        assert!(!verify_checksum(&file_message(chunk_data, "wrong-checksum".to_string())));
    }

    #[test]
    fn accumulates_chunks_out_of_order_without_completing_early() {
        let transfers: FileTransfers = Arc::new(Mutex::new(HashMap::new()));
        let chunk1 = FilePayload {
            file_name: "not-written-in-this-test.bin".to_string(),
            mime_type: "application/octet-stream".to_string(),
            size: 10,
            chunk_index: 1,
            chunk_total: 3,
            chunk_data: BASE64_STANDARD.encode(b"BCDE"),
        };

        // Solo llega 1 de 3 chunks: debe quedar pendiente, sin intentar reensamblar ni
        // tocar el disco todavía. No pasa por handle_file_chunk hasta completar para no
        // depender de (ni escribir en) el directorio de Descargas real en este test.
        handle_file_chunk("t", &chunk1, &transfers).unwrap();

        let guard = transfers.lock().unwrap();
        let pending = guard.get("t").expect("la transferencia sigue pendiente");
        assert_eq!(pending.chunks.len(), 1);
        assert!(pending.chunks.contains_key(&1));
    }

    #[test]
    fn write_reassembled_file_concatenates_chunks_in_index_order() {
        let mut chunks = HashMap::new();
        // Insertados deliberadamente fuera de orden en el mapa: la reconstrucción debe
        // basarse en chunk_index, no en el orden de inserción.
        chunks.insert(1_u32, b"World".to_vec());
        chunks.insert(0_u32, b"Hello".to_vec());

        let entry = PendingFile {
            file_name: "reassembly-test.txt".to_string(),
            chunk_total: 2,
            chunks,
        };

        // Directorio temporal aislado — no toca el Downloads real del usuario.
        let dir = std::env::temp_dir().join(format!("clipsync-test-{}", std::process::id()));
        write_reassembled_file(entry, &dir).expect("debería reensamblar sin error");

        let written = std::fs::read(dir.join("reassembly-test.txt")).expect("el archivo debe existir");
        assert_eq!(written, b"HelloWorld");

        std::fs::remove_dir_all(&dir).ok();
    }
}
