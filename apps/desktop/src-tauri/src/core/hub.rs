//! Hub: acepta conexiones y mantiene una sesión por móvil (el PC hace de servidor).
//! No depende de Tauri: la app se suscribe al canal de `HubEvent`.

use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use super::clip_sync::ClipboardSync;
use super::session::{
    self, lock, new_id, Command, OutFile, OutMeta, SessionConfig, SessionEvent, SessionHost, TransferUpdate,
    Transport,
};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HubEvent {
    PeerConnected { session_id: u64, device_id: String, device_name: String, transport: Transport },
    PeerDisconnected { session_id: u64, reason: String },
    ClipReceived { session_id: u64, text: String },
    LocalClipSuperseded { text: String },
    Transfer(TransferUpdate),
}

pub struct HubConfig {
    pub device_id: String,
    pub pc_name: String,
    pub download_dir: PathBuf,
    pub local_clip: Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

/// Mayor entero que JS representa sin pérdida: el tamaño de un archivo no puede pasar de aquí.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const FILE_MIME: &str = "application/octet-stream";

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

struct Inner {
    config: HubConfig,
    events: mpsc::UnboundedSender<HubEvent>,
    next_id: AtomicU64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    sessions: BTreeMap<u64, Entry>,
    /// anti-rebote por dispositivo, en memoria durante esta fase
    syncs: HashMap<String, Arc<Mutex<ClipboardSync>>>,
    ready_count: u64,
}

struct Entry {
    commands: mpsc::UnboundedSender<Command>,
    transport: Transport,
    /// dispositivo y orden de conexión, una vez completado el saludo
    peer: Option<(String, u64)>,
}

impl Inner {
    fn emit(&self, ev: HubEvent) {
        let _ = self.events.send(ev); // si nadie escucha, no pasa nada
    }
}

impl SessionHost for Inner {
    fn local_clip(&self) -> Option<String> {
        (self.config.local_clip)()
    }

    fn clip_sync_for(&self, device_id: &str) -> Arc<Mutex<ClipboardSync>> {
        let mut st = lock(&self.state);
        st.syncs
            .entry(device_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(ClipboardSync::new(None))))
            .clone()
    }

    // Se emite con el estado bloqueado para que el orden del canal sea el de los cambios.
    fn on_event(&self, session_id: u64, event: SessionEvent) {
        let mut st = lock(&self.state);
        match event {
            SessionEvent::Ready { device_id, device_name } => {
                st.ready_count += 1;
                let order = st.ready_count;
                let Some(entry) = st.sessions.get_mut(&session_id) else { return };
                entry.peer = Some((device_id.clone(), order));
                let transport = entry.transport;
                self.emit(HubEvent::PeerConnected { session_id, device_id: device_id.clone(), device_name, transport });
                // un hello con un device_id que ya tenía sesión: la vieja se cierra
                for (id, e) in &st.sessions {
                    if *id != session_id && e.peer.as_ref().is_some_and(|(d, _)| *d == device_id) {
                        let _ = e.commands.send(Command::Close("replaced".into()));
                    }
                }
            }
            SessionEvent::Clip(text) => {
                self.emit(HubEvent::ClipReceived { session_id, text: text.clone() });
                // el origen ya lo marcó; al resto se reenvía y cada una decide con su ClipboardSync
                for (id, e) in &st.sessions {
                    if *id != session_id {
                        let _ = e.commands.send(Command::SendClip(text.clone()));
                    }
                }
            }
            SessionEvent::LocalClipSuperseded(text) => self.emit(HubEvent::LocalClipSuperseded { text }),
            SessionEvent::Transfer(u) => self.emit(HubEvent::Transfer(u)),
            SessionEvent::Closed(reason) => {
                let removed = st.sessions.remove(&session_id);
                // solo se avisa de la desconexión de quien llegó a conectarse
                if removed.is_some_and(|e| e.peer.is_some()) {
                    self.emit(HubEvent::PeerDisconnected { session_id, reason });
                }
            }
        }
    }
}

/// 127.0.0.1 / ::1 (también ::ffff:127.0.0.1): túnel `adb reverse`.
fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.is_loopback(),
        IpAddr::V6(a) => a.is_loopback() || a.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

impl Hub {
    pub fn new(config: HubConfig) -> (Hub, mpsc::UnboundedReceiver<HubEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        let inner = Inner { config, events, next_id: AtomicU64::new(1), state: Mutex::new(State::default()) };
        (Hub { inner: Arc::new(inner) }, rx)
    }

    /// Bucle de accept; no termina. Un error al aceptar se registra y se sigue.
    pub async fn serve_tcp(&self, listener: tokio::net::TcpListener) {
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    let transport = if is_loopback(addr.ip()) { Transport::Usb } else { Transport::Wifi };
                    self.accept_stream(stream, transport);
                }
                Err(e) => {
                    // stderr: stdout puede llevar eventos en JSON (ejemplo headless)
                    eprintln!("[Hub] Error al aceptar una conexión: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Lanza una sesión sobre el flujo. Debe llamarse dentro de un runtime de tokio.
    pub fn accept_stream<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(&self, stream: S, transport: Transport) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.inner.state).sessions.insert(id, Entry { commands: tx, transport, peer: None });
        let config = &self.inner.config;
        let cfg = SessionConfig {
            id,
            device_id: config.device_id.clone(),
            device_name: config.pc_name.clone(),
            download_dir: config.download_dir.clone(),
        };
        let host: Arc<dyn SessionHost> = self.inner.clone();
        tokio::spawn(session::run(stream, cfg, host, rx));
    }

    /// A cada sesión cuya ClipboardSync diga `Send` (la comprobación la hace cada sesión).
    /// También a las que están saludando: si aún no están listas lo ignoran, porque su regla de
    /// inicio ya lee el portapapeles local.
    pub fn broadcast_clip(&self, text: &str) {
        for e in lock(&self.inner.state).sessions.values() {
            let _ = e.commands.send(Command::SendClip(text.to_string()));
        }
    }

    /// Envía el archivo a la sesión conectada más reciente y devuelve su transferId.
    /// `Err("no_peer")` si no hay ninguna; `Err("read_error")` si no se puede abrir.
    pub fn send_file(&self, path: &Path) -> Result<String, String> {
        let file = std::fs::File::open(path).map_err(|_| "read_error")?;
        let meta = file.metadata().map_err(|_| "read_error")?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let (Some(name), true) = (name, meta.is_file()) else { return Err("read_error".into()) };
        if meta.len() > MAX_SAFE_INTEGER {
            return Err("read_error".into());
        }
        let (id, id_bytes) = new_id();
        let mut out = OutFile {
            meta: OutMeta { id: id.clone(), id_bytes, name, size: meta.len(), mime: FILE_MIME.into() },
            file,
        };
        let st = lock(&self.inner.state);
        let mut peers: Vec<(u64, &Entry)> =
            st.sessions.values().filter_map(|e| e.peer.as_ref().map(|(_, order)| (*order, e))).collect();
        peers.sort_by_key(|p| std::cmp::Reverse(p.0));
        // si la más reciente se está cerrando, se prueba con la anterior
        for (_, e) in peers {
            match e.commands.send(Command::SendFile(out)) {
                Ok(()) => return Ok(id),
                Err(mpsc::error::SendError(Command::SendFile(back))) => out = back,
                Err(_) => break,
            }
        }
        Err("no_peer".into())
    }

    /// Cancela en cualquier sesión y sentido; un id desconocido no hace nada.
    pub fn cancel_transfer(&self, transfer_id: &str) {
        for e in lock(&self.inner.state).sessions.values() {
            let _ = e.commands.send(Command::Cancel(transfer_id.to_string()));
        }
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
