//! Vigilante del portapapeles del sistema (arboard). Un único hilo es dueño del `Clipboard`:
//! sondea el texto cada 500 ms y la imagen cada 1000 ms, y atiende las escrituras que le llegan
//! por canal. También crea y borra los PNG de la caché de imágenes: así nunca se borra uno que
//! otra orden acaba de volver a usar, y la E/S no ocupa los hilos del runtime.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arboard::Clipboard;
pub use arboard::ImageData;
use tokio::sync::oneshot;

use super::images::{
    decode_limited, encode_png, fingerprint, pixel_hash, remove_files, thumbnail_data_url,
};
use super::{IMAGE_TOO_LARGE_NOTICE, IMAGE_WRITE_ERROR};
use crate::core::LocalImage;
use crate::protocol::MAX_CLIP_IMAGE_BYTES;

const TEXT_POLL_INTERVAL: Duration = Duration::from_millis(500);
const IMAGE_POLL_INTERVAL: Duration = Duration::from_millis(1000);
/// Único texto que llega a la interfaz; el detalle de arboard (en inglés) solo va a stderr.
pub const CLIPBOARD_ERROR: &str = "No se pudo acceder al portapapeles";

type Reply = oneshot::Sender<Result<(), String>>;

enum Cmd {
    Text {
        text: String,
        reply: Option<Reply>,
    },
    /// imagen recibida de un móvil y guardada en `location`
    ReceivedImage {
        session_id: u64,
        location: String,
    },
    /// imagen del historial (`copy_image`)
    CopyImage {
        png: PathBuf,
        reply: Reply,
    },
}

/// Lado de quien pide escribir; el hilo vive mientras exista alguno.
pub struct ClipboardHandle {
    tx: Sender<Cmd>,
}

pub struct ClipboardWorker {
    rx: Receiver<Cmd>,
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
        if self.tx.send(Cmd::Text { text, reply: None }).is_err() {
            log("no se pudo escribir: el portapapeles no está disponible");
        }
    }

    /// Escribe y espera el resultado (comando `copy_text`).
    pub async fn write_and_wait(&self, text: String) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Text {
                text,
                reply: Some(reply),
            })
            .map_err(|_| CLIPBOARD_ERROR.to_string())?;
        rx.await.map_err(|_| CLIPBOARD_ERROR.to_string())?
    }

    /// Pone en el portapapeles una imagen recibida; el resultado lo trata el propio hilo.
    pub fn write_received_image(&self, session_id: u64, location: String) -> bool {
        self.tx
            .send(Cmd::ReceivedImage {
                session_id,
                location,
            })
            .is_ok()
    }

    /// Pone una imagen del historial y espera el resultado (comando `copy_image`).
    pub async fn copy_image(&self, png: PathBuf) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::CopyImage { png, reply })
            .map_err(|_| IMAGE_WRITE_ERROR.to_string())?;
        rx.await.map_err(|_| IMAGE_WRITE_ERROR.to_string())?
    }
}

impl ClipboardWorker {
    pub fn spawn<H: Host + Send + Sync + 'static>(self, host: Arc<H>, images_dir: PathBuf) {
        let host2 = host.clone();
        let r = std::thread::Builder::new()
            .name("clipboard".into())
            .spawn(move || run(self.rx, host2, images_dir));
        if let Err(e) = r {
            log(&format!("no se pudo lanzar el hilo: {e}"));
            host.set_clipboard_error(Some(CLIPBOARD_ERROR.to_string()));
        }
    }
}

/// Lo que el vigilante necesita del portapapeles (arboard, o uno de mentira en los tests).
pub trait Backend {
    fn get_text(&mut self) -> Result<String, arboard::Error>;
    fn set_text(&mut self, text: String) -> Result<(), arboard::Error>;
    fn get_image(&mut self) -> Result<ImageData<'static>, arboard::Error>;
    fn set_image(&mut self, img: ImageData<'_>) -> Result<(), arboard::Error>;
}

impl Backend for Clipboard {
    fn get_text(&mut self) -> Result<String, arboard::Error> {
        Clipboard::get_text(self)
    }
    fn set_text(&mut self, text: String) -> Result<(), arboard::Error> {
        Clipboard::set_text(self, text)
    }
    fn get_image(&mut self) -> Result<ImageData<'static>, arboard::Error> {
        Clipboard::get_image(self)
    }
    fn set_image(&mut self, img: ImageData<'_>) -> Result<(), arboard::Error> {
        Clipboard::set_image(self, img)
    }
}

/// Lo que el vigilante hace llegar a la app (`Ctx`).
pub trait Host {
    fn set_clipboard_error(&self, error: Option<String>);
    /// texto que ya había al arrancar: pasa a ser el local sin enviarse
    fn set_initial_local(&self, text: &str);
    /// texto nuevo copiado en el PC (sin imagen en la misma copia)
    fn on_local_text(&self, text: String);
    /// texto escrito por la app (de un móvil o de `copy_text`)
    fn text_written(&self, text: String);
    /// imagen que se ofrece a las sesiones nuevas, sin difundirla
    fn set_local_image(&self, img: Option<LocalImage>);
    /// imagen nueva copiada en el PC: se difunde
    fn on_local_image(&self, img: LocalImage, thumbnail: Option<String>);
    /// imagen recibida ya en el portapapeles; `hash` es el leído de vuelta y `png`, su PNG en
    /// la caché con su tamaño (si se pudo guardar)
    fn on_image_received(
        &self,
        session_id: u64,
        hash: String,
        png: Option<(PathBuf, u64)>,
        thumbnail: Option<String>,
        location: String,
    );
    /// no se pudo poner: el archivo se queda en `location`
    fn on_image_receive_failed(&self, location: String);
    fn show_notice(&self, text: &'static str);
    fn take_trash(&self) -> Vec<PathBuf>;
    fn image_in_use(&self, png: &Path) -> bool;
    fn retry_later(&self, failed: Vec<PathBuf>);
}

/// Píxeles RGBA con sus dimensiones.
struct Pixels {
    w: usize,
    h: usize,
    rgba: Vec<u8>,
}

impl From<ImageData<'_>> for Pixels {
    fn from(img: ImageData<'_>) -> Self {
        Self {
            w: img.width,
            h: img.height,
            rgba: img.bytes.into_owned(),
        }
    }
}

pub struct Watcher<B, H> {
    cb: B,
    host: Arc<H>,
    images_dir: PathBuf,
    max_image_bytes: u64,
    last_text: Option<String>,
    /// huella y hash de la última imagen vista o escrita
    last_fp: Option<[u8; 32]>,
    last_hash: Option<String>,
    /// último detalle de lectura registrado, para no repetirlo en cada sondeo
    last_read_error: Option<String>,
    last_image_error: Option<String>,
}

impl<B: Backend, H: Host> Watcher<B, H> {
    pub fn new(cb: B, host: Arc<H>, images_dir: PathBuf) -> Self {
        Self {
            cb,
            host,
            images_dir,
            max_image_bytes: MAX_CLIP_IMAGE_BYTES,
            last_text: None,
            last_fp: None,
            last_hash: None,
            last_read_error: None,
            last_image_error: None,
        }
    }

    /// Lo que ya había al arrancar no es un cambio: solo pasa a ser lo local.
    pub fn start(&mut self) {
        self.clear_cache();
        self.last_text = self.cb.get_text().ok();
        let image = self.cb.get_image().ok().map(Pixels::from);
        match image {
            Some(px) => {
                // con imagen en la copia, el texto no se ofrece
                let hash = self.remember(&px);
                if let Some(img) = self.store_local(&px, hash) {
                    self.host.set_local_image(Some(img));
                }
            }
            None => {
                if let Some(text) = &self.last_text {
                    self.host.set_initial_local(text);
                }
            }
        }
    }

    /// Los PNG de una ejecución anterior ya no los usa nadie: el historial no se guarda.
    fn clear_cache(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.images_dir) {
            let files = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            remove_files(files);
        }
        if let Err(e) = std::fs::create_dir_all(&self.images_dir) {
            log(&format!(
                "no se pudo crear {}: {e}",
                self.images_dir.display()
            ));
        }
    }

    /// Un sondeo: la imagen antes que el texto, y como mucho una lectura de imagen.
    pub fn tick(&mut self, text: bool, image: bool) {
        let has_image = image.then(|| self.poll_image());
        if text {
            self.poll_text(has_image);
        }
    }

    fn poll_text(&mut self, has_image: Option<bool>) {
        match self.cb.get_text() {
            Ok(text) => {
                self.last_read_error = None;
                self.host.set_clipboard_error(None);
                if self.last_text.as_deref() != Some(text.as_str()) {
                    // si esta misma copia trae imagen, gana la imagen y el texto no sale
                    let has_image = has_image.unwrap_or_else(|| self.poll_image());
                    self.last_text = Some(text.clone());
                    if !has_image {
                        self.host.on_local_text(text);
                    }
                }
            }
            // no hay texto (imagen, vacío): no es un error ni un cambio
            Err(arboard::Error::ContentNotAvailable) => {
                self.last_read_error = None;
                self.host.set_clipboard_error(None)
            }
            Err(e) => {
                let detail = e.to_string();
                if self.last_read_error.as_deref() != Some(detail.as_str()) {
                    log(&format!("no se pudo leer: {detail}"));
                    self.last_read_error = Some(detail);
                }
                self.host
                    .set_clipboard_error(Some(CLIPBOARD_ERROR.to_string()));
            }
        }
    }

    /// Devuelve si el portapapeles tiene ahora una imagen.
    fn poll_image(&mut self) -> bool {
        let px = match self.cb.get_image() {
            Ok(img) => Pixels::from(img),
            Err(arboard::Error::ContentNotAvailable) => {
                self.last_image_error = None;
                if self.last_hash.take().is_some() {
                    self.host.set_local_image(None);
                }
                self.last_fp = None;
                return false;
            }
            Err(e) => {
                let detail = e.to_string();
                if self.last_image_error.as_deref() != Some(detail.as_str()) {
                    log(&format!("no se pudo leer la imagen: {detail}"));
                    self.last_image_error = Some(detail);
                }
                return false;
            }
        };
        self.last_image_error = None;
        let fp = fingerprint(px.w, px.h, &px.rgba);
        if self.last_fp == Some(fp) {
            return true;
        }
        // la huella cambió: solo ahora el SHA-256 completo
        let hash = pixel_hash(px.w, px.h, &px.rgba);
        self.last_fp = Some(fp);
        if self.last_hash.as_deref() == Some(hash.as_str()) {
            return true;
        }
        self.last_hash = Some(hash.clone());
        // copia nueva: el texto visto antes deja de contar (volver a copiarlo es un cambio)
        self.last_text = None;
        if let Some(img) = self.store_local(&px, hash) {
            let thumb = self.thumbnail(&px);
            self.host.on_local_image(img, thumb);
        }
        true
    }

    /// Anota la imagen como la última vista y devuelve su hash.
    fn remember(&mut self, px: &Pixels) -> String {
        let hash = pixel_hash(px.w, px.h, &px.rgba);
        self.last_fp = Some(fingerprint(px.w, px.h, &px.rgba));
        self.last_hash = Some(hash.clone());
        self.last_text = None;
        hash
    }

    /// PNG de una imagen copiada en el PC; si pasa del máximo, no se ofrece y se avisa.
    fn store_local(&mut self, px: &Pixels, hash: String) -> Option<LocalImage> {
        match self.store_png(px, &hash) {
            Ok((path, size)) if size <= self.max_image_bytes => Some(LocalImage {
                hash,
                png_path: path,
            }),
            Ok((path, _)) => {
                if !self.host.image_in_use(&path) {
                    remove_files(vec![path]);
                }
                self.host.set_local_image(None);
                self.host.show_notice(IMAGE_TOO_LARGE_NOTICE);
                None
            }
            Err(e) => {
                log(&e);
                self.host.set_local_image(None);
                None
            }
        }
    }

    /// Un PNG por imagen, con su hash por nombre: uno que ya existe no se reescribe (puede
    /// estar enviándose). Se escribe en un temporal y se renombra.
    fn store_png(&self, px: &Pixels, hash: &str) -> Result<(PathBuf, u64), String> {
        let path = self.images_dir.join(format!("{hash}.png"));
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() {
                return Ok((path, meta.len()));
            }
        }
        let png = encode_png(px.w, px.h, &px.rgba)?;
        let tmp = self.images_dir.join(format!("{hash}.png.tmp"));
        std::fs::create_dir_all(&self.images_dir)
            .and_then(|_| std::fs::write(&tmp, &png))
            .and_then(|_| std::fs::rename(&tmp, &path))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("no se pudo guardar {}: {e}", path.display())
            })?;
        Ok((path, png.len() as u64))
    }

    fn thumbnail(&self, px: &Pixels) -> Option<String> {
        thumbnail_data_url(px.w, px.h, &px.rgba)
            .map_err(|e| log(&format!("no se pudo hacer la miniatura: {e}")))
            .ok()
    }

    pub fn write_text(&mut self, text: String) -> Result<(), String> {
        self.cb.set_text(text.clone()).map_err(|e| {
            log(&format!("no se pudo escribir: {e}"));
            CLIPBOARD_ERROR.to_string()
        })?;
        // así el sondeo no lo toma por un cambio y no se reenvía; la imagen ya no está
        self.last_text = Some(text.clone());
        self.last_fp = None;
        self.last_hash = None;
        self.host.text_written(text);
        Ok(())
    }

    /// Pone la imagen y la lee de vuelta: lo leído es lo que se anota y se reenvía, por si el
    /// portapapeles la recodifica.
    fn put_image(&mut self, path: &Path) -> Result<(Pixels, String), String> {
        let (w, h, rgba) = decode_limited(path)?;
        self.cb
            .set_image(ImageData {
                width: w,
                height: h,
                bytes: rgba.as_slice().into(),
            })
            .map_err(|e| format!("no se pudo poner la imagen: {e}"))?;
        let px = match self.cb.get_image() {
            Ok(img) => Pixels::from(img),
            Err(e) => {
                log(&format!("no se pudo leer de vuelta la imagen: {e}"));
                Pixels { w, h, rgba }
            }
        };
        let hash = self.remember(&px);
        Ok((px, hash))
    }

    pub fn write_received_image(&mut self, session_id: u64, location: String) {
        let (px, hash) = match self.put_image(Path::new(&location)) {
            Ok(r) => r,
            Err(e) => {
                log(&e);
                self.host.show_notice(IMAGE_WRITE_ERROR);
                self.host.on_image_receive_failed(location);
                return;
            }
        };
        let png = self.store_png(&px, &hash).map_err(|e| log(&e)).ok();
        let thumb = self.thumbnail(&px);
        self.host
            .on_image_received(session_id, hash, png, thumb, location);
    }

    /// Imagen del historial: se pone sin difundirla, como `copy_text`.
    pub fn copy_image(&mut self, png: &Path) -> Result<(), String> {
        let (px, hash) = self.put_image(png).map_err(|e| {
            log(&e);
            IMAGE_WRITE_ERROR.to_string()
        })?;
        let local = match self.store_png(&px, &hash) {
            Ok((path, size)) if size <= self.max_image_bytes => Some(LocalImage {
                hash,
                png_path: path,
            }),
            Ok(_) => None,
            Err(e) => {
                log(&e);
                None
            }
        };
        self.host.set_local_image(local);
        Ok(())
    }

    /// Borra los PNG de la papelera que ya nadie usa; los que fallan se reintentan en la
    /// siguiente poda.
    pub fn prune(&mut self) {
        let trash = self.host.take_trash();
        if trash.is_empty() {
            return;
        }
        let unused = trash
            .into_iter()
            .filter(|p| !self.host.image_in_use(p))
            .collect();
        let failed = remove_files(unused);
        if !failed.is_empty() {
            self.host.retry_later(failed);
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Text { text, reply } => {
                let r = self.write_text(text);
                if let Some(reply) = reply {
                    let _ = reply.send(r);
                }
            }
            Cmd::ReceivedImage {
                session_id,
                location,
            } => self.write_received_image(session_id, location),
            Cmd::CopyImage { png, reply } => {
                let _ = reply.send(self.copy_image(&png));
            }
        }
    }
}

fn run<H: Host>(rx: Receiver<Cmd>, host: Arc<H>, images_dir: PathBuf) {
    let cb = match Clipboard::new() {
        Ok(cb) => cb,
        Err(e) => {
            log(&format!("no se pudo abrir: {e}"));
            host.set_clipboard_error(Some(CLIPBOARD_ERROR.to_string()));
            // la app sigue para archivos; quien pida escribir recibe el error
            for cmd in rx {
                match cmd {
                    Cmd::Text { reply, .. } => {
                        if let Some(reply) = reply {
                            let _ = reply.send(Err(CLIPBOARD_ERROR.to_string()));
                        }
                    }
                    Cmd::ReceivedImage { location, .. } => {
                        host.show_notice(IMAGE_WRITE_ERROR);
                        host.on_image_receive_failed(location);
                    }
                    Cmd::CopyImage { reply, .. } => {
                        let _ = reply.send(Err(IMAGE_WRITE_ERROR.to_string()));
                    }
                }
            }
            return;
        }
    };
    log("vigilando el portapapeles");
    let mut w = Watcher::new(cb, host, images_dir);
    w.start();

    let mut next_text = Instant::now() + TEXT_POLL_INTERVAL;
    let mut next_image = Instant::now() + IMAGE_POLL_INTERVAL;
    loop {
        let wait = next_text.min(next_image);
        match rx.recv_timeout(wait.saturating_duration_since(Instant::now())) {
            Ok(cmd) => w.handle(cmd),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        let (text, image) = (now >= next_text, now >= next_image);
        if text || image {
            w.tick(text, image);
            let now = Instant::now();
            if text {
                next_text = now + TEXT_POLL_INTERVAL;
            }
            if image {
                next_image = now + IMAGE_POLL_INTERVAL;
            }
        }
        w.prune();
    }
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
