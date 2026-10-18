//! Sesión del protocolo v2 en el rol servidor. Espejo de `packages/protocol/src/session.ts`.
//!
//! Una tarea por sesión: primero el handshake Noise IK (mensaje 1 con el saludo del móvil,
//! autorización y mensaje 2); después lee tramas cifradas, atiende las órdenes del Hub, el latido
//! y el emisor de archivos, todo en serie. Cada mensaje entrante se procesa entero antes del
//! siguiente.

use std::collections::{HashSet, VecDeque};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadHalf, WriteHalf};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::bytes::Bytes;
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};

use super::clip_sync::{sha256_hex, ClipDecision, ClipboardSync};
use super::files::FileReceiver;
use super::hub::LocalImage;
use super::image_sync::ImageSync;
use crate::protocol::hello::{
    decode_client_hello, encode_server_hello, ClientHello, RejectReason, ServerHello,
};
use crate::protocol::secure::{self, SecureChannel, StaticKeys};
use crate::protocol::{
    encode_control, encode_file_data, frame_codec, ControlMessage, Decoded, MessageDecoder,
    FILE_ACK_EVERY_BYTES, FILE_CHUNK_BYTES, FILE_WINDOW_BYTES, HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS, MAX_CLIP_BYTES, MAX_CLIP_IMAGE_BYTES, MAX_FRAME_BYTES, PURPOSE_CLIPBOARD,
};

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Wifi,
    Usb,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    In,
    Out,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Queued,
    Active,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferUpdate {
    pub transfer_id: String,
    pub direction: Direction,
    pub name: String,
    pub size: u64,
    pub bytes: u64,
    pub state: TransferState,
    pub error: Option<String>,
    pub location: Option<String>,
    /// `Some("clipboard")` en las imágenes del portapapeles; `null` en JSON si falta (R21)
    pub purpose: Option<String>,
}

/// Órdenes del Hub a una sesión.
pub(super) enum Command {
    /// Se envía solo si la sesión está lista y su ClipboardSync dice `Send`.
    SendClip(String),
    SendFile(OutFile),
    /// Imagen del portapapeles: se envía solo si la sesión está lista y su ImageSync no la tiene.
    SendImage(LocalImage),
    Cancel(String),
    Close(String),
}

/// Archivo saliente ya abierto; el id lo genera el Hub para devolverlo al momento.
pub(super) struct OutFile {
    pub meta: OutMeta,
    pub file: std::fs::File,
}

pub(super) struct OutMeta {
    pub id: String,
    pub id_bytes: [u8; 16],
    pub name: String,
    pub size: u64,
    pub mime: String,
}

/// Lo que la sesión comunica al Hub.
pub(super) enum SessionEvent {
    /// `device_id` es la `device_key` del móvil: su clave pública en hex (D4).
    Ready {
        device_id: String,
        device_name: String,
    },
    Clip(String),
    LocalClipSuperseded(String),
    Transfer(TransferUpdate),
    /// imagen para el portapapeles ya guardada (ruta)
    ClipImage(String),
    Closed(String),
}

/// Anti-rebote de un dispositivo (texto e imagen), compartido entre sus sesiones.
#[derive(Clone)]
pub(super) struct DeviceSyncs {
    pub clip: Arc<Mutex<ClipboardSync>>,
    pub image: Arc<Mutex<ImageSync>>,
}

impl DeviceSyncs {
    pub fn new() -> Self {
        Self {
            clip: Arc::new(Mutex::new(ClipboardSync::new(None))),
            image: Arc::new(Mutex::new(ImageSync::new(None))),
        }
    }

    /// Olvida lo enviado (R17/R20): lo último puede no haber llegado al móvil.
    pub fn reset(&self) {
        *lock(&self.clip) = ClipboardSync::new(None);
        *lock(&self.image) = ImageSync::new(None);
    }
}

/// Lo que la sesión necesita del Hub. `on_event` se llama de forma síncrona y en orden.
pub(super) trait SessionHost: Send + Sync + 'static {
    fn local_clip(&self) -> Option<String>;
    fn local_image(&self) -> Option<LocalImage>;
    /// Tras leer el mensaje 1: decide si el móvil con esa clave pública puede entrar. Con
    /// `Err`, el PC responde con el rechazo y cierra con ese motivo.
    fn authorize(
        &self,
        session_id: u64,
        public_key: &[u8; 32],
        hello: &ClientHello,
    ) -> Result<(), RejectReason>;
    /// Tras aceptar: devuelve el anti-rebote del dispositivo (`device_key` = clave en hex).
    fn syncs_for(&self, session_id: u64, device_key: &str) -> DeviceSyncs;
    fn on_event(&self, session_id: u64, event: SessionEvent);
}

pub(super) struct SessionConfig {
    pub id: u64,
    pub device_id: String,
    pub device_name: String,
    pub download_dir: PathBuf,
    /// destino de las imágenes con `purpose:"clipboard"`
    pub image_dir: PathBuf,
    /// claves estáticas del PC (respondedor del handshake)
    pub keys: StaticKeys,
}

/// Un Mutex envenenado no debe tumbar la app (panic = "abort"): se sigue con el valor.
pub(super) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// 32 caracteres hex; también sirve de `id` para los `clip`.
pub(super) fn new_id() -> (String, [u8; 16]) {
    let id = uuid::Uuid::new_v4();
    (id.simple().to_string(), *id.as_bytes())
}

/// Límites de lo que el móvil envía en el mensaje 1 y se guarda en memoria.
const MAX_DEVICE_ID_BYTES: usize = 128;
const MAX_DEVICE_NAME_CHARS: usize = 64;
/// Nombre de un archivo entrante que se muestra y viaja en los eventos.
const MAX_FILE_NAME_CHARS: usize = 255;

const PROTOCOL_ERROR: &str = "protocol_error";
const INTERNAL_ERROR: &str = "internal_error";
const LINK_CLOSED: &str = "link_closed";
const HEARTBEAT_TIMEOUT: &str = "heartbeat_timeout";
const HANDSHAKE_FAILED: &str = "handshake_failed";
/// Motivo de file_cancel cuando lo pide el usuario; cualquier otro motivo es un fallo.
const CANCEL_REASON: &str = "cancelled";
const WRITE_ERROR: &str = "write_error";
const READ_ERROR: &str = "read_error";
const SIZE_MISMATCH: &str = "size_mismatch";
const CHECKSUM_MISMATCH: &str = "checksum_mismatch";
/// file_cancel de una imagen para el portapapeles de más de 20 MiB
const TOO_LARGE: &str = "too_large";
/// el PC siempre envía sus imágenes en PNG
const IMAGE_MIME: &str = "image/png";

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[Sesión] {msg}");
}

/// Error que cierra la sesión con ese motivo.
type Res = Result<(), &'static str>;

struct OutTransfer {
    f: OutMeta,
    file: tokio::fs::File,
    sent: u64,
    acked: u64,
    /// file_end enviado: solo falta file_result y ya no se puede cancelar
    end_sent: bool,
    hasher: sha2::Sha256,
    /// trozo leído que espera hueco en la ventana (como mucho uno)
    pending: Option<Vec<u8>>,
    /// hash de la imagen del portapapeles; `None` en un archivo normal
    image_hash: Option<String>,
}

impl OutTransfer {
    fn new(f: OutMeta, file: tokio::fs::File, image_hash: Option<String>) -> Self {
        OutTransfer {
            f,
            file,
            sent: 0,
            acked: 0,
            end_sent: false,
            hasher: sha2::Digest::new(),
            pending: None,
            image_hash,
        }
    }

    fn purpose(&self) -> Option<String> {
        self.image_hash
            .as_ref()
            .map(|_| PURPOSE_CLIPBOARD.to_string())
    }

    fn update(&self, state: TransferState, error: Option<&str>) -> TransferUpdate {
        TransferUpdate {
            transfer_id: self.f.id.clone(),
            direction: Direction::Out,
            name: self.f.name.clone(),
            size: self.f.size,
            bytes: if state == TransferState::Done {
                self.f.size
            } else {
                self.acked
            },
            state,
            error: error.map(String::from),
            location: None,
            purpose: self.purpose(),
        }
    }

    /// Puede leer el siguiente trozo, o enviar el leído porque ya cabe en la ventana.
    fn can_step(&self) -> bool {
        !self.end_sent
            && self
                .pending
                .as_ref()
                .is_none_or(|c| self.sent - self.acked + c.len() as u64 <= FILE_WINDOW_BYTES)
    }
}

/// Destino de un archivo entrante.
enum Sink {
    /// aún sin abrir, o prestado a una operación en curso
    Pending,
    Open(FileReceiver),
    /// guardado pero sin confirmar al emisor
    Saved(PathBuf),
}

impl Sink {
    /// Descarta el parcial; si ya estaba guardado y no se confirmó, borra el archivo.
    fn discard(self) {
        match self {
            Sink::Open(rx) => rx.abort(),
            Sink::Saved(path) => {
                let _ = std::fs::remove_file(path);
            }
            Sink::Pending => {}
        }
    }
}

struct InTransfer {
    id: String,
    name: String,
    size: u64,
    received: u64,
    sink: Sink,
    purpose: Option<String>,
}

impl InTransfer {
    fn update(
        &self,
        state: TransferState,
        error: Option<&str>,
        location: Option<String>,
    ) -> TransferUpdate {
        TransferUpdate {
            transfer_id: self.id.clone(),
            direction: Direction::In,
            name: self.name.clone(),
            size: self.size,
            bytes: self.received,
            state,
            error: error.map(String::from),
            location,
            purpose: self.purpose.clone(),
        }
    }
}

/// Recorta a `max` caracteres (nunca en mitad de uno).
fn truncate_chars(mut s: String, max: usize) -> String {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
    }
    s
}

/// true si `after` alcanza otro múltiplo de 1 MiB que `before` no alcanzaba.
fn crosses_mib(before: u64, after: u64) -> bool {
    after / FILE_ACK_EVERY_BYTES > before / FILE_ACK_EVERY_BYTES
}

/// Lee hasta `FILE_CHUNK_BYTES`; vacío = fin del archivo.
async fn read_chunk(file: &mut tokio::fs::File) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; FILE_CHUNK_BYTES];
    let mut n = 0;
    while n < buf.len() {
        let r = file.read(&mut buf[n..]).await?;
        if r == 0 {
            break;
        }
        n += r;
    }
    buf.truncate(n);
    Ok(buf)
}

enum Input {
    Frame(Option<std::io::Result<tokio_util::bytes::BytesMut>>),
    Command(Option<Command>),
    Tick,
    Step,
}

/// Lo que deja un handshake aceptado.
struct Handshake {
    channel: SecureChannel,
    /// clave pública del móvil en hex: su identidad en el PC
    device_key: String,
    hello: ClientHello,
}

/// Mensaje 1 → autorización → mensaje 2. `Err` lleva el motivo de cierre: la sesión no llega a
/// estar lista. El mensaje 1 debe llegar en `HEARTBEAT_TIMEOUT_MS` desde que se aceptó la
/// conexión, aunque vayan llegando bytes.
async fn handshake<S: AsyncRead + AsyncWrite>(
    reader: &mut FramedRead<ReadHalf<S>, LengthDelimitedCodec>,
    writer: &mut FramedWrite<WriteHalf<S>, LengthDelimitedCodec>,
    cfg: &SessionConfig,
    host: &dyn SessionHost,
) -> Result<Handshake, &'static str> {
    let timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);
    let msg1 = match tokio::time::timeout(timeout, reader.next()).await {
        Ok(Some(Ok(frame))) => frame,
        Ok(_) => return Err(LINK_CLOSED),
        Err(_) => return Err(HEARTBEAT_TIMEOUT),
    };
    let mut hs = secure::responder(&cfg.keys).map_err(|_| INTERNAL_ERROR)?;
    let mut buf = vec![0u8; MAX_FRAME_BYTES];
    // clave del PC equivocada, trama alterada o que no es un mensaje 1
    let n = hs
        .read_message(&msg1, &mut buf)
        .map_err(|_| HANDSHAKE_FAILED)?;
    let mut hello = decode_client_hello(&buf[..n]).map_err(|_| HANDSHAKE_FAILED)?;
    if hello.device_id.len() > MAX_DEVICE_ID_BYTES {
        return Err(HANDSHAKE_FAILED);
    }
    hello.device_name = truncate_chars(hello.device_name, MAX_DEVICE_NAME_CHARS);
    let public_key: [u8; 32] = hs
        .get_remote_static()
        .and_then(|k| k.try_into().ok())
        .ok_or(HANDSHAKE_FAILED)?;

    let verdict = host.authorize(cfg.id, &public_key, &hello);
    let answer = match verdict {
        Ok(()) => ServerHello::accept(cfg.device_id.clone(), cfg.device_name.clone()),
        Err(reason) => ServerHello::reject(reason),
    };
    let n = hs
        .write_message(&encode_server_hello(&answer), &mut buf)
        .map_err(|_| INTERNAL_ERROR)?;
    match tokio::time::timeout(timeout, writer.send(Bytes::copy_from_slice(&buf[..n]))).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => return Err(LINK_CLOSED),
        Err(_) => return Err(HEARTBEAT_TIMEOUT),
    }
    verdict.map_err(RejectReason::as_str)?;
    let channel = SecureChannel::new(hs).map_err(|_| INTERNAL_ERROR)?;
    Ok(Handshake {
        channel,
        device_key: hex::encode(public_key),
        hello,
    })
}

/// Atiende una conexión hasta que se cierra. Siempre termina con `SessionEvent::Closed`.
pub(super) async fn run<S>(
    stream: S,
    cfg: SessionConfig,
    host: Arc<dyn SessionHost>,
    commands: mpsc::UnboundedReceiver<Command>,
) where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (r, w) = tokio::io::split(stream);
    let mut reader = FramedRead::new(r, frame_codec());
    let mut writer = FramedWrite::new(w, frame_codec());
    let hs = match handshake(&mut reader, &mut writer, &cfg, host.as_ref()).await {
        Ok(hs) => hs,
        // sin sesión lista no hay transferencias ni órdenes que cerrar
        Err(reason) => return host.on_event(cfg.id, SessionEvent::Closed(reason.into())),
    };
    let mut s = Session {
        cfg,
        host,
        writer,
        commands,
        channel: hs.channel,
        decoder: MessageDecoder::default(),
        closed: false,
        ready: false,
        sync: Arc::new(Mutex::new(ClipboardSync::new(None))),
        image_sync: Arc::new(Mutex::new(ImageSync::new(None))),
        last_rx: Instant::now(),
        out_queue: VecDeque::new(),
        out: None,
        inc: None,
        ended_in: HashSet::new(),
    };
    let period = Duration::from_millis(HEARTBEAT_INTERVAL_MS);
    let mut ticker = tokio::time::interval_at(Instant::now() + period, period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    s.on_client_hello(hs.device_key, hs.hello).await;

    while !s.closed {
        s.pump_out().await;
        if s.closed {
            break;
        }
        let step = s.out.as_ref().is_some_and(OutTransfer::can_step);
        let input = tokio::select! {
            f = reader.next() => Input::Frame(f),
            c = s.commands.recv() => Input::Command(c),
            _ = ticker.tick() => Input::Tick,
            _ = std::future::ready(()), if step => Input::Step,
        };
        match input {
            Input::Frame(Some(Ok(frame))) => {
                s.last_rx = Instant::now();
                s.on_frame(&frame).await;
            }
            Input::Frame(_) => s.close(LINK_CLOSED),
            Input::Command(Some(c)) => s.on_command(c).await,
            Input::Command(None) => s.close("closed"),
            Input::Tick => s.tick().await,
            Input::Step => s.step_out().await,
        }
    }
}

struct Session<W> {
    cfg: SessionConfig,
    host: Arc<dyn SessionHost>,
    writer: FramedWrite<W, LengthDelimitedCodec>,
    commands: mpsc::UnboundedReceiver<Command>,
    /// cifra cada payload que sale y descifra cada trama que llega
    channel: SecureChannel,
    decoder: MessageDecoder,
    closed: bool,
    ready: bool,
    /// ClipboardSync del dispositivo (compartido entre sus sesiones); provisional hasta el saludo
    sync: Arc<Mutex<ClipboardSync>>,
    /// ImageSync del dispositivo, igual que `sync`
    image_sync: Arc<Mutex<ImageSync>>,
    last_rx: Instant,
    out_queue: VecDeque<OutTransfer>,
    out: Option<OutTransfer>,
    inc: Option<InTransfer>,
    /// transferId entrantes ya terminados: sus datos rezagados se descartan
    ended_in: HashSet<String>,
}

impl<W: AsyncWrite + Unpin> Session<W> {
    fn emit(&self, ev: SessionEvent) {
        self.host.on_event(self.cfg.id, ev);
    }

    fn emit_transfer(&self, u: TransferUpdate) {
        self.emit(SessionEvent::Transfer(u));
    }

    // --- salida ---

    /// Cifra y escribe los payloads en orden (cada uno, una trama).
    async fn write_frames(&mut self, frames: Vec<Vec<u8>>) {
        if self.closed {
            return;
        }
        let mut cipher = Vec::with_capacity(frames.len());
        for f in &frames {
            match self.channel.encrypt(f) {
                Ok(c) => cipher.push(c),
                Err(_) => return self.close(INTERNAL_ERROR),
            }
        }
        let frames = cipher;
        let w = &mut self.writer;
        let res = tokio::time::timeout(Duration::from_millis(HEARTBEAT_TIMEOUT_MS), async {
            for f in frames {
                w.feed(Bytes::from(f)).await?;
            }
            SinkExt::<Bytes>::flush(w).await
        })
        .await;
        match res {
            Ok(Ok(())) => {}
            Ok(Err(_)) => self.close(LINK_CLOSED),
            // el otro lado no lee desde hace 30 s
            Err(_) => self.close(HEARTBEAT_TIMEOUT),
        }
    }

    async fn send(&mut self, msg: ControlMessage) {
        match encode_control(&msg) {
            Ok(frames) => self.write_frames(frames).await,
            Err(_) => self.close(INTERNAL_ERROR),
        }
    }

    /// Cierra una sola vez: las transferencias terminan (`failed`) antes de avisar del cierre.
    fn close(&mut self, reason: &str) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(t) = self.out.take() {
            self.settle_image(&t, false);
            self.emit_transfer(t.update(TransferState::Failed, Some(reason)));
        }
        for t in std::mem::take(&mut self.out_queue) {
            self.settle_image(&t, false);
            self.emit_transfer(t.update(TransferState::Failed, Some(reason)));
        }
        if let Some(t) = self.inc.take() {
            let u = t.update(TransferState::Failed, Some(reason), None);
            t.sink.discard();
            self.emit_transfer(u);
        }
        // archivos que el Hub encoló y que ya no se atenderán
        self.commands.close();
        while let Ok(c) = self.commands.try_recv() {
            if let Command::SendFile(OutFile { meta: f, .. }) = c {
                self.emit_transfer(TransferUpdate {
                    transfer_id: f.id,
                    direction: Direction::Out,
                    name: f.name,
                    size: f.size,
                    bytes: 0,
                    state: TransferState::Failed,
                    error: Some(reason.to_string()),
                    location: None,
                    purpose: None,
                });
            }
        }
        self.emit(SessionEvent::Closed(reason.to_string()));
    }

    async fn tick(&mut self) {
        let timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);
        if Instant::now().duration_since(self.last_rx) >= timeout {
            self.close(HEARTBEAT_TIMEOUT);
        } else if self.ready {
            self.send(ControlMessage::Ping).await;
        }
    }

    // --- órdenes del Hub ---

    async fn on_command(&mut self, c: Command) {
        match c {
            Command::SendClip(text) => {
                if self.ready {
                    self.push_clip(&text).await;
                }
            }
            Command::SendFile(OutFile { meta, file }) => {
                let t = OutTransfer::new(meta, tokio::fs::File::from_std(file), None);
                // 'queued' ya lo emitió el Hub al aceptar el archivo
                self.out_queue.push_back(t);
            }
            Command::SendImage(img) => self.offer_image(img).await,
            Command::Cancel(id) => self.cancel_transfer(&id).await,
            Command::Close(reason) => self.close(&reason),
        }
    }

    /// Cancela en cualquier sentido; si no existe o ya acabó, no hace nada.
    async fn cancel_transfer(&mut self, id: &str) {
        if let Some(i) = self.out_queue.iter().position(|t| t.f.id == id) {
            // aún no empezó: el otro lado no sabe nada de él
            if let Some(t) = self.out_queue.remove(i) {
                self.settle_image(&t, false);
                self.emit_transfer(t.update(TransferState::Cancelled, None));
            }
            return;
        }
        if self
            .out
            .as_ref()
            .is_some_and(|t| t.f.id == id && !t.end_sent)
        {
            self.end_out(TransferState::Cancelled, None, Some(CANCEL_REASON))
                .await;
        } else if self.inc.as_ref().is_some_and(|t| t.id == id) {
            self.end_in(TransferState::Cancelled, None, None, Some(CANCEL_REASON))
                .await;
        }
    }

    // --- entrada ---

    async fn on_frame(&mut self, frame: &[u8]) {
        // alterada, fuera de orden o de otro canal
        let Ok(payload) = self.channel.decrypt(frame) else {
            return self.close(PROTOCOL_ERROR);
        };
        let decoded = match self.decoder.push(&payload) {
            Ok(Some(d)) => d,
            Ok(None) => return,
            Err(_) => return self.close(PROTOCOL_ERROR),
        };
        if let Err(reason) = self.dispatch(decoded).await {
            self.close(reason);
        }
    }

    async fn dispatch(&mut self, d: Decoded) -> Res {
        let msg = match d {
            Decoded::Data { transfer_id, bytes } => {
                return self.on_file_data(hex::encode(transfer_id), bytes).await;
            }
            Decoded::Control(msg) => msg,
        };
        // un `hello` tras el handshake ya no decodifica: el MessageDecoder da protocol_error
        match msg {
            ControlMessage::Ping => {
                self.send(ControlMessage::Pong).await;
                Ok(())
            }
            ControlMessage::Pong => Ok(()), // basta con haber recibido tráfico
            ControlMessage::Clip { text, hash, .. } => self.on_clip(text, &hash),
            ControlMessage::FileStart {
                transfer_id,
                name,
                size,
                purpose,
                ..
            } => self.on_file_start(transfer_id, name, size, purpose).await,
            ControlMessage::FileEnd {
                transfer_id,
                sha256,
            } => self.on_file_end(transfer_id, sha256).await,
            ControlMessage::FileAck {
                transfer_id,
                received,
            } => self.on_file_ack(&transfer_id, received),
            ControlMessage::FileResult {
                transfer_id,
                ok,
                error,
            } => self.on_file_result(&transfer_id, ok, error).await,
            ControlMessage::FileCancel {
                transfer_id,
                reason,
            } => {
                self.on_file_cancel(&transfer_id, &reason).await;
                Ok(())
            }
        }
    }

    // --- saludo y regla de inicio ---

    /// Tras aceptar el handshake (el mensaje 2 ya salió): regla de inicio y `Ready`.
    async fn on_client_hello(&mut self, device_key: String, hello: ClientHello) {
        let syncs = self.host.syncs_for(self.cfg.id, &device_key);
        self.sync = syncs.clip;
        self.image_sync = syncs.image;
        // Órdenes que llegaron durante el handshake: como la sesión no está lista, los clips se
        // ignoran (la regla de inicio lee ahora el portapapeles local) y un Close la cierra.
        while let Ok(c) = self.commands.try_recv() {
            self.on_command(c).await;
            if self.closed {
                return;
            }
        }
        let will_send_clip = hello.will_send_clip == Some(true);
        // La regla se resuelve antes de ready; el clip del cliente aún no se ha procesado.
        let mut superseded = None;
        if let Some(local) = self.host.local_clip() {
            if !will_send_clip {
                self.push_clip(&local).await;
            } else if self.prepare_clip(&local).is_ok() {
                // gana el móvil: el texto del PC se da por tratado para que no salga después y cruce
                lock(&self.sync).mark_synced(&local);
                superseded = Some(local);
            }
        }
        if self.closed {
            return; // falló la escritura del clip
        }
        self.ready = true;
        self.emit(SessionEvent::Ready {
            device_id: device_key,
            device_name: hello.device_name,
        });
        if let Some(text) = superseded {
            self.emit(SessionEvent::LocalClipSuperseded(text));
        }
        // envío de inicio de la imagen: no entra en «gana el móvil»
        if let Some(img) = self.host.local_image() {
            self.offer_image(img).await;
        }
    }

    // --- portapapeles ---

    /// Tramas del clip si hay que enviarlo; si su JSON no cabe en un mensaje de control, `TooLarge`.
    fn prepare_clip(&self, text: &str) -> Result<Vec<Vec<u8>>, ClipDecision> {
        let decision = lock(&self.sync).check(text);
        if decision != ClipDecision::Send {
            return Err(decision);
        }
        let msg = ControlMessage::Clip {
            id: new_id().0,
            text: text.to_string(),
            hash: sha256_hex(text),
        };
        encode_control(&msg).map_err(|_| ClipDecision::TooLarge)
    }

    /// Único camino de salida de un clip, para el arranque y para las órdenes del Hub.
    async fn push_clip(&mut self, text: &str) -> ClipDecision {
        let frames = match self.prepare_clip(text) {
            Ok(f) => f,
            Err(d) => return d,
        };
        self.write_frames(frames).await;
        // si la escritura falló, el texto no llegó: no se marca (la sincronía es del dispositivo)
        if !self.closed {
            lock(&self.sync).mark_synced(text);
        }
        ClipDecision::Send
    }

    fn on_clip(&mut self, text: String, hash: &str) -> Res {
        if text.len() > MAX_CLIP_BYTES || sha256_hex(&text) != hash {
            return Err(PROTOCOL_ERROR);
        }
        lock(&self.sync).mark_synced(&text);
        self.emit(SessionEvent::Clip(text));
        Ok(())
    }

    // --- imágenes del portapapeles: emisor ---

    /// R7: por sesión, como mucho una imagen del portapapeles en cola o en curso. La que espera
    /// en cola se sustituye por la nueva; la que está en vuelo termina y la nueva va detrás.
    /// `mark_sent` siempre lleva el hash de la que de verdad está en cola o en curso.
    async fn offer_image(&mut self, img: LocalImage) {
        if !self.ready {
            return; // su regla de inicio ya leerá `local_image`
        }
        let queued = self.out_queue.iter().find_map(|t| t.image_hash.as_deref());
        if queued == Some(img.hash.as_str()) {
            return; // ya está en cola
        }
        let dup = lock(&self.image_sync).is_duplicate(&img.hash);
        let in_flight =
            self.out.as_ref().and_then(|t| t.image_hash.as_deref()) == Some(img.hash.as_str());
        if dup || in_flight {
            // el otro lado ya la tiene o la está recibiendo: lo que espera en cola sobra
            self.drop_queued_image();
            if !dup {
                lock(&self.image_sync).mark_sent(&img.hash);
            }
            return;
        }
        let Some(t) = open_image(&img).await else {
            return;
        };
        self.drop_queued_image();
        lock(&self.image_sync).mark_sent(&img.hash);
        self.emit_transfer(t.update(TransferState::Queued, None));
        self.out_queue.push_back(t);
    }

    /// Quita de la cola la imagen que aún no empezó (el otro lado no sabe nada de ella).
    fn drop_queued_image(&mut self) {
        let Some(i) = self.out_queue.iter().position(|t| t.image_hash.is_some()) else {
            return;
        };
        if let Some(t) = self.out_queue.remove(i) {
            self.emit_transfer(t.update(TransferState::Cancelled, None));
        }
    }

    /// Fin de una imagen saliente: confirma o revierte, solo si sigue siendo la última marcada
    /// (si no, la sustituyó otra o llegó una del móvil). Va antes del aviso al Hub.
    fn settle_image(&self, t: &OutTransfer, ok: bool) {
        let Some(h) = t.image_hash.as_deref() else {
            return;
        };
        let mut sync = lock(&self.image_sync);
        if sync.last_synced_hash() != Some(h) {
            return;
        }
        if ok {
            // el PC no guarda el confirmado entre arranques
            let _ = sync.confirm_sent();
        } else {
            sync.revert_sent();
        }
    }

    // --- archivos: emisor ---

    /// Arranca el siguiente de la cola si no hay otro en curso.
    async fn pump_out(&mut self) {
        if self.closed || !self.ready || self.out.is_some() {
            return;
        }
        let Some(t) = self.out_queue.pop_front() else {
            return;
        };
        let msg = ControlMessage::FileStart {
            transfer_id: t.f.id.clone(),
            name: t.f.name.clone(),
            size: t.f.size,
            mime: t.f.mime.clone(),
            purpose: t.purpose(),
        };
        self.out = Some(t);
        // file_start sale antes del aviso 'active'
        self.send(msg).await;
        if let Some(t) = &self.out {
            self.emit_transfer(t.update(TransferState::Active, None));
        }
    }

    /// Lee un trozo (si no hay uno pendiente) y lo envía si cabe en la ventana; al final, file_end.
    async fn step_out(&mut self) {
        let Some(t) = self.out.as_mut() else { return };
        if t.pending.is_none() {
            let chunk = match read_chunk(&mut t.file).await {
                Ok(c) => c,
                Err(_) => {
                    return self
                        .end_out(TransferState::Failed, Some(READ_ERROR), Some(READ_ERROR))
                        .await
                }
            };
            if chunk.is_empty() {
                if t.sent != t.f.size {
                    return self
                        .end_out(
                            TransferState::Failed,
                            Some(SIZE_MISMATCH),
                            Some(SIZE_MISMATCH),
                        )
                        .await;
                }
                t.end_sent = true;
                let sha256 = hex::encode(sha2::Digest::finalize_reset(&mut t.hasher));
                let msg = ControlMessage::FileEnd {
                    transfer_id: t.f.id.clone(),
                    sha256,
                };
                // hasta file_result, file_cancel o cierre
                return self.send(msg).await;
            }
            if t.sent + chunk.len() as u64 > t.f.size {
                // el archivo creció: nunca se manda más de lo anunciado
                return self
                    .end_out(
                        TransferState::Failed,
                        Some(SIZE_MISMATCH),
                        Some(SIZE_MISMATCH),
                    )
                    .await;
            }
            t.pending = Some(chunk);
        }
        if !t.can_step() {
            return; // espera a un file_ack
        }
        let Some(chunk) = t.pending.take() else {
            return;
        };
        sha2::Digest::update(&mut t.hasher, &chunk);
        t.sent += chunk.len() as u64;
        let frame = encode_file_data(&t.f.id_bytes, &chunk);
        self.write_frames(vec![frame]).await;
    }

    /// Termina el saliente activo; con `cancel`, avisa al otro lado con ese motivo.
    async fn end_out(&mut self, state: TransferState, error: Option<&str>, cancel: Option<&str>) {
        let Some(t) = self.out.take() else { return };
        self.settle_image(&t, state == TransferState::Done);
        // se emite antes de escribir: si la escritura falla, 'closed' llega después
        self.emit_transfer(t.update(state, error));
        if let Some(reason) = cancel {
            self.send(ControlMessage::FileCancel {
                transfer_id: t.f.id,
                reason: reason.to_string(),
            })
            .await;
        }
    }

    fn on_file_ack(&mut self, id: &str, received: u64) -> Res {
        let Some(t) = self.out.as_mut().filter(|t| t.f.id == id) else {
            return Ok(());
        }; // rezagado
        if received > t.sent {
            return Err(PROTOCOL_ERROR);
        }
        if received <= t.acked {
            return Ok(());
        }
        let before = t.acked;
        t.acked = received;
        if crosses_mib(before, received) {
            let u = t.update(TransferState::Active, None);
            self.emit_transfer(u);
        }
        Ok(())
    }

    async fn on_file_result(&mut self, id: &str, ok: bool, error: Option<String>) -> Res {
        let Some(t) = self.out.as_ref().filter(|t| t.f.id == id) else {
            return Ok(());
        };
        if !t.end_sent {
            return Err(PROTOCOL_ERROR);
        }
        if ok {
            self.end_out(TransferState::Done, None, None).await;
        } else {
            let error = error.unwrap_or_else(|| "remote_error".to_string());
            self.end_out(TransferState::Failed, Some(&error), None)
                .await;
        }
        Ok(())
    }

    /// 'cancelled' si lo pidió el usuario del otro lado; si no, fallo con ese motivo.
    async fn on_file_cancel(&mut self, id: &str, reason: &str) {
        let (state, error) = if reason == CANCEL_REASON {
            (TransferState::Cancelled, None)
        } else {
            (TransferState::Failed, Some(reason))
        };
        if self.out.as_ref().is_some_and(|t| t.f.id == id) {
            self.end_out(state, error, None).await;
        } else if self.inc.as_ref().is_some_and(|t| t.id == id) {
            self.end_in(state, error, None, None).await;
        }
        // si no, ya terminó aquí (los dos cancelaron a la vez): se ignora
    }

    // --- archivos: receptor ---

    async fn on_file_start(
        &mut self,
        id: String,
        name: String,
        size: u64,
        purpose: Option<String>,
    ) -> Res {
        if self.inc.is_some() || self.ended_in.contains(&id) {
            return Err(PROTOCOL_ERROR);
        }
        // el decodificador solo deja pasar "clipboard"
        let image = purpose.as_deref() == Some(PURPOSE_CLIPBOARD);
        // recortado para mostrarlo; el archivo se guarda con el nombre saneado de siempre
        let shown = truncate_chars(name.clone(), MAX_FILE_NAME_CHARS);
        self.inc = Some(InTransfer {
            id,
            name: shown,
            size,
            received: 0,
            sink: Sink::Pending,
            purpose,
        });
        if image && size > MAX_CLIP_IMAGE_BYTES {
            // demasiado grande para el portapapeles: se rechaza sin abrir el destino ni cerrar
            self.end_in(
                TransferState::Failed,
                Some(TOO_LARGE),
                None,
                Some(TOO_LARGE),
            )
            .await;
            return Ok(());
        }
        let dir = if image {
            self.cfg.image_dir.clone()
        } else {
            self.cfg.download_dir.clone()
        };
        match tokio::task::spawn_blocking(move || FileReceiver::create(&dir, &name)).await {
            Ok(Ok(rx)) => {
                if let Some(t) = self.inc.as_mut() {
                    t.sink = Sink::Open(rx);
                    let u = t.update(TransferState::Active, None, None);
                    self.emit_transfer(u);
                }
            }
            _ => {
                self.end_in(
                    TransferState::Failed,
                    Some(WRITE_ERROR),
                    None,
                    Some(WRITE_ERROR),
                )
                .await;
            }
        }
        Ok(())
    }

    /// Transferencia entrante en curso con ese id; `Err` si el id nunca se vio, `Ok(None)` si es rezagado.
    fn incoming(&mut self, id: &str) -> Result<Option<&mut InTransfer>, &'static str> {
        match self.inc.as_mut() {
            Some(t) if t.id == id => Ok(Some(t)),
            _ if self.ended_in.contains(id) => Ok(None), // en vuelo cuando terminó: se descarta
            _ => Err(PROTOCOL_ERROR),
        }
    }

    async fn on_file_data(&mut self, id: String, bytes: Vec<u8>) -> Res {
        let Some(t) = self.incoming(&id)? else {
            return Ok(());
        };
        let len = bytes.len() as u64;
        if t.received + len > t.size {
            return Err(PROTOCOL_ERROR);
        }
        let Sink::Open(mut rx) = std::mem::replace(&mut t.sink, Sink::Pending) else {
            return Err(INTERNAL_ERROR);
        };
        // la espera a escribir en disco es la contrapresión: no se lee la siguiente trama hasta acabar
        let res = tokio::task::spawn_blocking(move || {
            let r = rx.write(&bytes);
            (rx, r)
        })
        .await;
        let rx = match res {
            Ok((rx, Ok(()))) => rx,
            Ok((rx, Err(_))) => {
                rx.abort();
                self.end_in(
                    TransferState::Failed,
                    Some(WRITE_ERROR),
                    None,
                    Some(WRITE_ERROR),
                )
                .await;
                return Ok(());
            }
            Err(_) => {
                self.end_in(
                    TransferState::Failed,
                    Some(WRITE_ERROR),
                    None,
                    Some(WRITE_ERROR),
                )
                .await;
                return Ok(());
            }
        };
        let Some(t) = self.inc.as_mut() else {
            return Ok(());
        };
        t.sink = Sink::Open(rx);
        let before = t.received;
        t.received += len;
        if crosses_mib(before, t.received) {
            let (id, received) = (t.id.clone(), t.received);
            self.send(ControlMessage::FileAck {
                transfer_id: id,
                received,
            })
            .await;
            if let Some(t) = self.inc.as_ref() {
                self.emit_transfer(t.update(TransferState::Active, None, None));
            }
        }
        Ok(())
    }

    async fn on_file_end(&mut self, id: String, sha256: String) -> Res {
        let Some(t) = self.incoming(&id)? else {
            return Ok(());
        };
        if t.received != t.size {
            return Err(PROTOCOL_ERROR);
        }
        let image = t.purpose.is_some();
        let received = t.received;
        let Sink::Open(rx) = std::mem::replace(&mut t.sink, Sink::Pending) else {
            return Err(INTERNAL_ERROR);
        };
        // ack final: el emisor de un archivo pequeño no se queda esperando a la ventana
        self.send(ControlMessage::FileAck {
            transfer_id: id.clone(),
            received,
        })
        .await;
        if self.closed {
            rx.abort(); // close() ya emitió failed
            return Ok(());
        }
        let res = tokio::task::spawn_blocking(move || rx.finish(&sha256)).await;
        let error = match res {
            Ok(Ok(path)) => {
                if let Some(t) = self.inc.as_mut() {
                    t.sink = Sink::Saved(path.clone());
                }
                self.send(ControlMessage::FileResult {
                    transfer_id: id,
                    ok: true,
                    error: None,
                })
                .await;
                // si la sesión cayó aquí, close() ya borró el archivo y emitió failed
                let location = path.to_string_lossy().into_owned();
                let done = self
                    .end_in(TransferState::Done, None, Some(location.clone()), None)
                    .await;
                if done && image {
                    self.emit(SessionEvent::ClipImage(location));
                }
                return Ok(());
            }
            Ok(Err(e)) if e == CHECKSUM_MISMATCH => CHECKSUM_MISMATCH,
            _ => WRITE_ERROR,
        };
        // finish() ya borró el parcial
        self.send(ControlMessage::FileResult {
            transfer_id: id,
            ok: false,
            error: Some(error.to_string()),
        })
        .await;
        self.end_in(TransferState::Failed, Some(error), None, None)
            .await;
        Ok(())
    }

    /// Termina el entrante activo; salvo `done`, descarta lo recibido o guardado.
    /// `false` si ya no había ninguno (p. ej. la sesión se cerró antes).
    async fn end_in(
        &mut self,
        state: TransferState,
        error: Option<&str>,
        location: Option<String>,
        cancel: Option<&str>,
    ) -> bool {
        let Some(t) = self.inc.take() else {
            return false;
        };
        self.ended_in.insert(t.id.clone());
        let u = t.update(state, error, location);
        if state != TransferState::Done {
            t.sink.discard();
        }
        // se emite antes de escribir: si la escritura falla, 'closed' llega después
        self.emit_transfer(u);
        if let Some(reason) = cancel {
            self.send(ControlMessage::FileCancel {
                transfer_id: t.id,
                reason: reason.to_string(),
            })
            .await;
        }
        true
    }
}

/// Abre la imagen para enviarla; `None` (registrado) si no se puede o pasa de 20 MiB.
async fn open_image(img: &LocalImage) -> Option<OutTransfer> {
    let opened = async {
        let file = tokio::fs::File::open(&img.png_path).await.ok()?;
        let meta = file.metadata().await.ok()?;
        let name = img.png_path.file_name()?.to_string_lossy().into_owned();
        (meta.is_file() && meta.len() <= MAX_CLIP_IMAGE_BYTES).then_some((file, meta.len(), name))
    };
    let Some((file, size, name)) = opened.await else {
        log("no se pudo abrir la imagen del portapapeles o pasa de 20 MiB");
        return None;
    };
    let (id, id_bytes) = new_id();
    let meta = OutMeta {
        id,
        id_bytes,
        name,
        size,
        mime: IMAGE_MIME.into(),
    };
    Some(OutTransfer::new(meta, file, Some(img.hash.clone())))
}
