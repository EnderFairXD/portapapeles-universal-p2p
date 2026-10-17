//! Sesión del protocolo v2 en el rol servidor. Espejo de `packages/protocol/src/session.ts`.
//!
//! Una tarea por sesión: lee tramas, atiende las órdenes del Hub, el latido y el emisor de
//! archivos, todo en serie. Cada mensaje entrante se procesa entero antes del siguiente.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::bytes::Bytes;
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};

use super::clip_sync::{sha256_hex, ClipDecision, ClipboardSync};
use super::files::FileReceiver;
use crate::protocol::{
    encode_control, encode_file_data, frame_codec, ControlMessage, Decoded, MessageDecoder,
    FILE_ACK_EVERY_BYTES, FILE_CHUNK_BYTES, FILE_WINDOW_BYTES, HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS, MAX_CLIP_BYTES, MAX_CONTROL_BYTES, MAX_PRE_HELLO_CONTROL_BYTES,
    PROTOCOL_VERSION,
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
}

/// Órdenes del Hub a una sesión.
pub(super) enum Command {
    /// Se envía solo si la sesión está lista y su ClipboardSync dice `Send`.
    SendClip(String),
    SendFile(OutFile),
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
    Ready {
        device_id: String,
        device_name: String,
    },
    Clip(String),
    LocalClipSuperseded(String),
    Transfer(TransferUpdate),
    Closed(String),
}

/// Lo que la sesión necesita del Hub. `on_event` se llama de forma síncrona y en orden.
pub(super) trait SessionHost: Send + Sync + 'static {
    fn local_clip(&self) -> Option<String>;
    /// Al recibir el hello: asocia la sesión a ese dispositivo y devuelve su ClipboardSync.
    fn clip_sync_for(&self, session_id: u64, device_id: &str) -> Arc<Mutex<ClipboardSync>>;
    fn on_event(&self, session_id: u64, event: SessionEvent);
}

pub(super) struct SessionConfig {
    pub id: u64,
    pub device_id: String,
    pub device_name: String,
    pub download_dir: PathBuf,
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

/// Límites de lo que el móvil envía en su hello y se guarda en memoria.
const MAX_DEVICE_ID_BYTES: usize = 128;
const MAX_DEVICE_NAME_CHARS: usize = 64;
/// Nombre de un archivo entrante que se muestra y viaja en los eventos.
const MAX_FILE_NAME_CHARS: usize = 255;

const PROTOCOL_ERROR: &str = "protocol_error";
const INTERNAL_ERROR: &str = "internal_error";
const LINK_CLOSED: &str = "link_closed";
const HEARTBEAT_TIMEOUT: &str = "heartbeat_timeout";
/// Motivo de file_cancel cuando lo pide el usuario; cualquier otro motivo es un fallo.
const CANCEL_REASON: &str = "cancelled";
const WRITE_ERROR: &str = "write_error";
const READ_ERROR: &str = "read_error";
const SIZE_MISMATCH: &str = "size_mismatch";
const CHECKSUM_MISMATCH: &str = "checksum_mismatch";

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
}

impl OutTransfer {
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
    let mut s = Session {
        cfg,
        host,
        writer: FramedWrite::new(w, frame_codec()),
        commands,
        // hasta el hello, un par desconocido no puede hacer reservar más de 64 KiB
        decoder: MessageDecoder::with_max_control_bytes(MAX_PRE_HELLO_CONTROL_BYTES),
        closed: false,
        hello_received: false,
        ready: false,
        sync: Arc::new(Mutex::new(ClipboardSync::new(None))),
        last_rx: Instant::now(),
        started: Instant::now(),
        out_queue: VecDeque::new(),
        out: None,
        inc: None,
        ended_in: HashSet::new(),
    };
    // el plazo del latido corre desde ya, también durante el saludo
    let period = Duration::from_millis(HEARTBEAT_INTERVAL_MS);
    let mut ticker = tokio::time::interval_at(Instant::now() + period, period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

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
    decoder: MessageDecoder,
    closed: bool,
    hello_received: bool,
    ready: bool,
    /// ClipboardSync del dispositivo (compartido entre sus sesiones); provisional hasta el hello
    sync: Arc<Mutex<ClipboardSync>>,
    last_rx: Instant,
    /// el hello debe llegar en `HEARTBEAT_TIMEOUT_MS` aunque haya tráfico
    started: Instant,
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

    async fn write_frames(&mut self, frames: Vec<Vec<u8>>) {
        if self.closed {
            return;
        }
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
            self.emit_transfer(t.update(TransferState::Failed, Some(reason)));
        }
        for t in std::mem::take(&mut self.out_queue) {
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
                });
            }
        }
        self.emit(SessionEvent::Closed(reason.to_string()));
    }

    async fn tick(&mut self) {
        let timeout = Duration::from_millis(HEARTBEAT_TIMEOUT_MS);
        let now = Instant::now();
        // sin hello a tiempo: no ocupa un hueco de sesión sin saludo para siempre
        if now.duration_since(self.last_rx) >= timeout
            || (!self.hello_received && now.duration_since(self.started) >= timeout)
        {
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
                let t = OutTransfer {
                    f: meta,
                    file: tokio::fs::File::from_std(file),
                    sent: 0,
                    acked: 0,
                    end_sent: false,
                    hasher: sha2::Digest::new(),
                    pending: None,
                };
                // 'queued' ya lo emitió el Hub al aceptar el archivo
                self.out_queue.push_back(t);
            }
            Command::Cancel(id) => self.cancel_transfer(&id).await,
            Command::Close(reason) => self.close(&reason),
        }
    }

    /// Cancela en cualquier sentido; si no existe o ya acabó, no hace nada.
    async fn cancel_transfer(&mut self, id: &str) {
        if let Some(i) = self.out_queue.iter().position(|t| t.f.id == id) {
            // aún no empezó: el otro lado no sabe nada de él
            if let Some(t) = self.out_queue.remove(i) {
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
        let decoded = match self.decoder.push(frame) {
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
                if !self.ready {
                    return Err(PROTOCOL_ERROR); // datos antes del saludo
                }
                return self.on_file_data(hex::encode(transfer_id), bytes).await;
            }
            Decoded::Control(msg) => msg,
        };
        if !self.hello_received {
            let ControlMessage::Hello {
                device_id,
                device_name,
                will_send_clip,
                ..
            } = msg
            else {
                return Err(PROTOCOL_ERROR);
            };
            self.hello_received = true;
            self.decoder.set_max_control_bytes(MAX_CONTROL_BYTES);
            if device_id.len() > MAX_DEVICE_ID_BYTES {
                return Err(PROTOCOL_ERROR);
            }
            let device_name = truncate_chars(device_name, MAX_DEVICE_NAME_CHARS);
            self.on_client_hello(device_id, device_name, will_send_clip == Some(true))
                .await;
            return Ok(());
        }
        match msg {
            ControlMessage::Hello { .. } => Err(PROTOCOL_ERROR),
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
                ..
            } => self.on_file_start(transfer_id, name, size).await,
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

    async fn on_client_hello(
        &mut self,
        device_id: String,
        device_name: String,
        will_send_clip: bool,
    ) {
        self.sync = self.host.clip_sync_for(self.cfg.id, &device_id);
        self.send(ControlMessage::Hello {
            v: PROTOCOL_VERSION,
            device_id: self.cfg.device_id.clone(),
            device_name: self.cfg.device_name.clone(),
            will_send_clip: None,
        })
        .await;
        if self.closed {
            return;
        }
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
            device_id,
            device_name,
        });
        if let Some(text) = superseded {
            self.emit(SessionEvent::LocalClipSuperseded(text));
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

    async fn on_file_start(&mut self, id: String, name: String, size: u64) -> Res {
        if self.inc.is_some() || self.ended_in.contains(&id) {
            return Err(PROTOCOL_ERROR);
        }
        // recortado para mostrarlo; el archivo se guarda con el nombre saneado de siempre
        let shown = truncate_chars(name.clone(), MAX_FILE_NAME_CHARS);
        self.inc = Some(InTransfer {
            id,
            name: shown,
            size,
            received: 0,
            sink: Sink::Pending,
        });
        let dir = self.cfg.download_dir.clone();
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
                .await
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
                self.end_in(TransferState::Done, None, Some(location), None)
                    .await;
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
    async fn end_in(
        &mut self,
        state: TransferState,
        error: Option<&str>,
        location: Option<String>,
        cancel: Option<&str>,
    ) {
        let Some(t) = self.inc.take() else { return };
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
    }
}
