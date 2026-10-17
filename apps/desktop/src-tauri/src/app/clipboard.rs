//! Vigilante del portapapeles del sistema (arboard). Un único hilo es dueño del `Clipboard`:
//! sondea cada 500 ms y atiende las escrituras que le llegan por canal.

use std::io::Write;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arboard::Clipboard;
use tokio::sync::oneshot;

use super::Ctx;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Único texto que llega a la interfaz; el detalle de arboard (en inglés) solo va a stderr.
pub const CLIPBOARD_ERROR: &str = "No se pudo acceder al portapapeles";

type Reply = oneshot::Sender<Result<(), String>>;

struct WriteCmd {
    text: String,
    reply: Option<Reply>,
}

/// Lado de quien pide escribir; el hilo vive mientras exista alguno.
pub struct ClipboardHandle {
    tx: Sender<WriteCmd>,
}

pub struct ClipboardWorker {
    rx: Receiver<WriteCmd>,
}

pub fn channel() -> (ClipboardHandle, ClipboardWorker) {
    let (tx, rx) = mpsc::channel();
    (ClipboardHandle { tx }, ClipboardWorker { rx })
}

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[Portapapeles] {msg}");
}

impl ClipboardHandle {
    /// Escribe sin esperar (texto recibido de un móvil); un fallo solo se registra.
    pub fn write(&self, text: String) {
        if self.tx.send(WriteCmd { text, reply: None }).is_err() {
            log("no se pudo escribir: el portapapeles no está disponible");
        }
    }

    /// Escribe y espera el resultado (comando `copy_text`).
    pub async fn write_and_wait(&self, text: String) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(WriteCmd {
                text,
                reply: Some(reply),
            })
            .map_err(|_| CLIPBOARD_ERROR.to_string())?;
        rx.await.map_err(|_| CLIPBOARD_ERROR.to_string())?
    }
}

impl ClipboardWorker {
    pub fn spawn(self, ctx: Arc<Ctx>) {
        let ctx2 = ctx.clone();
        let r = std::thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || run(self.rx, ctx2));
        if let Err(e) = r {
            log(&format!("no se pudo lanzar el hilo: {e}"));
            ctx.set_clipboard_error(Some(CLIPBOARD_ERROR.to_string()));
        }
    }
}

fn run(rx: Receiver<WriteCmd>, ctx: Arc<Ctx>) {
    let mut cb = match Clipboard::new() {
        Ok(cb) => cb,
        Err(e) => {
            log(&format!("no se pudo abrir: {e}"));
            ctx.set_clipboard_error(Some(CLIPBOARD_ERROR.to_string()));
            // la app sigue para archivos; quien pida escribir recibe el error
            for cmd in rx {
                if let Some(reply) = cmd.reply {
                    let _ = reply.send(Err(CLIPBOARD_ERROR.to_string()));
                }
            }
            return;
        }
    };
    log("vigilando el portapapeles");

    // el texto que ya había al arrancar no es un cambio: solo pasa a ser el texto local
    let mut last = cb.get_text().ok();
    if let Some(text) = &last {
        ctx.set_initial_local(text);
    }

    let mut next_poll = Instant::now() + POLL_INTERVAL;
    // último detalle de lectura registrado, para no repetirlo cada 500 ms
    let mut last_read_error: Option<String> = None;
    loop {
        match rx.recv_timeout(next_poll.saturating_duration_since(Instant::now())) {
            Ok(WriteCmd { text, reply }) => {
                let r = cb.set_text(text.clone()).map_err(|e| {
                    log(&format!("no se pudo escribir: {e}"));
                    CLIPBOARD_ERROR.to_string()
                });
                if r.is_ok() {
                    // así el sondeo no lo toma por un cambio y no se reenvía
                    last = Some(text.clone());
                    ctx.set_local(Some(text));
                }
                match (reply, r) {
                    (Some(reply), r) => {
                        let _ = reply.send(r);
                    }
                    (None, _) => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                poll(&mut cb, &mut last, &mut last_read_error, &ctx);
                next_poll = Instant::now() + POLL_INTERVAL;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn poll(cb: &mut Clipboard, last: &mut Option<String>, last_error: &mut Option<String>, ctx: &Ctx) {
    match cb.get_text() {
        Ok(text) => {
            *last_error = None;
            ctx.set_clipboard_error(None);
            if last.as_deref() != Some(text.as_str()) {
                *last = Some(text.clone());
                ctx.on_local_text(text);
            }
        }
        // no hay texto (imagen, vacío): no es un error ni un cambio
        Err(arboard::Error::ContentNotAvailable) => {
            *last_error = None;
            ctx.set_clipboard_error(None)
        }
        Err(e) => {
            let detail = e.to_string();
            if last_error.as_deref() != Some(detail.as_str()) {
                log(&format!("no se pudo leer: {detail}"));
                *last_error = Some(detail);
            }
            ctx.set_clipboard_error(Some(CLIPBOARD_ERROR.to_string()));
        }
    }
}
