//! Servidor TCP de la LAN: acepta conexiones, lee mensajes NDJSON (un `SyncMessage` por
//! línea — el propio serializador JSON escapa cualquier salto de línea embebido en el
//! contenido, así que "una línea = un mensaje" es un framing seguro) y los imprime.

use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use crate::protocol::SyncMessage;

pub async fn run_server(port: u16) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    println!("[TCP] Escuchando en 0.0.0.0:{port}");

    loop {
        let (socket, peer_addr) = listener.accept().await?;
        println!("[TCP] Cliente conectado desde {peer_addr}");

        tokio::spawn(async move {
            if let Err(err) = handle_connection(socket, peer_addr.to_string()).await {
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
                write_half.write_all(b"OK\n").await?;
            }
            Err(err) => {
                println!("[TCP] Línea de {peer_addr} no es un SyncMessage válido: {err}");
                write_half.write_all(b"ERROR invalid_message\n").await?;
            }
        }

        // El protocolo actual es una conexión = un mensaje. Si seguíamos el loop hacia
        // next_line(), nos quedábamos esperando más datos que el cliente nunca manda (solo
        // espera a que el servidor cierre) — interbloqueo que colgaba la UI móvil
        // indefinidamente. Cerramos explícitamente tras responder en vez de seguir leyendo.
        break;
    }

    write_half.shutdown().await?;
    Ok(())
}

/// El checksum solo se define para `text`/`token` (hash del `content`); para `file` se
/// calcula sobre el archivo reensamblado completo, fuera de alcance de esta verificación
/// por-chunk.
fn verify_checksum(message: &SyncMessage) -> bool {
    use crate::protocol::SyncPayload;

    let content = match &message.payload {
        SyncPayload::Text(p) => &p.content,
        SyncPayload::Token(p) => &p.content,
        SyncPayload::File(_) => return true,
    };

    let digest = Sha256::digest(content.as_bytes());
    let computed = hex::encode(digest);
    computed == message.checksum
}
