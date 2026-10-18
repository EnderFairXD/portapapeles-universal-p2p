//! Servidor sin interfaz para el e2e: el Hub en 127.0.0.1:0, sus eventos como JSON por stdout
//! y órdenes JSON por stdin. Uso:
//! `headless --download-dir <dir> --data-dir <dir> [--local-clip <texto>]`.
//!
//! `--data-dir` guarda la identidad (`identity.key`) y los emparejados (`paired.json`): al
//! relanzar con la misma carpeta se conservan.
//!
//! Con `panic = "abort"` nada aquí puede hacer panic: los errores van a stderr.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use clipsync_lib::core::pairing::PairedStore;
use clipsync_lib::core::{identity, Hub, HubConfig};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Cmd {
    Clip {
        text: String,
    },
    File {
        path: PathBuf,
    },
    /// Abre una ventana de emparejamiento; responde con la línea `pairing`.
    Pair,
    /// Olvida un móvil emparejado; sus efectos llegan como eventos.
    Forget {
        #[serde(rename = "deviceKey")]
        device_key: String,
    },
}

struct Args {
    download_dir: PathBuf,
    data_dir: PathBuf,
    local_clip: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut download_dir = None;
    let mut data_dir = None;
    let mut local_clip = None;
    let mut it = std::env::args_os().skip(1);
    while let Some(arg) = it.next() {
        let value = it.next();
        match (arg.to_str(), value) {
            (Some("--download-dir"), Some(v)) => download_dir = Some(PathBuf::from(v)),
            (Some("--data-dir"), Some(v)) => data_dir = Some(PathBuf::from(v)),
            (Some("--local-clip"), Some(v)) => {
                local_clip = Some(v.into_string().map_err(|_| "--local-clip no es UTF-8")?)
            }
            _ => return Err(format!("argumento no válido: {}", arg.to_string_lossy())),
        }
    }
    let download_dir = download_dir.ok_or("falta --download-dir")?;
    let data_dir = data_dir.ok_or("falta --data-dir")?;
    Ok(Args {
        download_dir,
        data_dir,
        local_clip,
    })
}

/// Una línea JSON por stdout; si stdout ya no está, no hay a quién informar.
fn out(line: &str) -> bool {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{line}")
        .and_then(|_| stdout.flush())
        .is_ok()
}

fn err(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[headless] {msg}");
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            err(&format!(
                "{e}\nUso: headless --download-dir <dir> --data-dir <dir> [--local-clip <texto>]"
            ));
            return ExitCode::from(2);
        }
    };

    // como la app: el último texto local (el inicial, o el último pedido por stdin)
    let local = Arc::new(Mutex::new(args.local_clip));
    let local_read = local.clone();
    let (hub, mut events) = Hub::new(HubConfig {
        device_id: "headless-pc".into(),
        pc_name: "PC headless".into(),
        // provisional: la Tarea 5 añade --image-dir
        image_dir: args.download_dir.join("ClipSync"),
        download_dir: args.download_dir,
        local_image: Arc::new(|| None),
        local_clip: Arc::new(move || match local_read.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }),
        keys: identity::load_or_create(Some(&args.data_dir)),
        paired: PairedStore::load(Some(args.data_dir.join("paired.json"))),
    });

    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            err(&format!("no se pudo escuchar: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            err(&format!("sin dirección local: {e}"));
            return ExitCode::FAILURE;
        }
    };
    // primera línea, antes de cualquier evento
    // a mano: json! ordenaría las claves y "type" debe ir primero
    let public_key = hex(&hub.public_key());
    if !out(&format!(
        r#"{{"type":"listening","port":{port},"publicKey":"{public_key}"}}"#
    )) {
        return ExitCode::FAILURE;
    }

    let server = hub.clone();
    tokio::spawn(async move { server.serve_tcp(listener).await });

    let printer = tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            match serde_json::to_string(&ev) {
                Ok(line) => {
                    if !out(&line) {
                        return;
                    }
                }
                Err(e) => err(&format!("evento no serializable: {e}")),
            }
        }
    });

    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match stdin.read_until(b'\n', &mut buf).await {
            Ok(0) => break, // stdin cerrado: el proceso padre se fue
            Ok(_) => match std::str::from_utf8(&buf) {
                Ok(line) => handle(&hub, &local, line),
                Err(_) => err("línea de stdin que no es UTF-8: se ignora"),
            },
            Err(e) => {
                err(&format!("error leyendo stdin: {e}"));
                break;
            }
        }
    }
    printer.abort();
    ExitCode::SUCCESS
}

fn handle(hub: &Hub, local: &Mutex<Option<String>>, line: &str) {
    let line = line.trim_end_matches(['\n', '\r']);
    if line.trim().is_empty() {
        return;
    }
    match serde_json::from_str::<Cmd>(line) {
        Ok(Cmd::Clip { text }) => {
            // antes del broadcast, como exige el Hub (regla de inicio de sesiones nuevas)
            match local.lock() {
                Ok(mut g) => *g = Some(text.clone()),
                Err(p) => *p.into_inner() = Some(text.clone()),
            }
            hub.broadcast_clip(&text);
        }
        Ok(Cmd::File { path }) => send_file(hub, &path),
        Ok(Cmd::Pair) => {
            let offer = hub.start_pairing();
            // a mano, por el orden de las claves; el token es base64url, pero se escapa igualmente
            let token = serde_json::to_string(&offer.token).unwrap_or_else(|_| "\"\"".into());
            out(&format!(
                r#"{{"type":"pairing","token":{token},"expiresAtMs":{}}}"#,
                offer.expires_at_ms
            ));
        }
        Ok(Cmd::Forget { device_key }) => {
            if !hub.forget_device(&device_key) {
                err(&format!(
                    "forget: no hay ningún móvil emparejado con {device_key}"
                ));
            }
        }
        Err(e) => err(&format!("orden no válida ({e}): {line}")),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn send_file(hub: &Hub, path: &Path) {
    if let Err(e) = hub.send_file(path) {
        err(&format!("no se pudo enviar {}: {e}", path.display()));
    }
}
