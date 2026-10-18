//! Hub: acepta conexiones y mantiene una sesión por móvil (el PC hace de servidor).
//! Solo entran los móviles emparejados (o el que trae el token vigente del QR); cada uno se
//! identifica por su clave pública en hex (`device_key`, D4).
//! No depende de Tauri: la app se suscribe al canal de `HubEvent`.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use super::pairing::{PairedDevice, PairedStore, PairingOffer, PairingTokens, TokenCheck};
use super::session::{
    self, lock, new_id, Command, DeviceSyncs, Direction, OutFile, OutMeta, SessionConfig,
    SessionEvent, SessionHost, TransferState, TransferUpdate, Transport,
};
use crate::protocol::hello::{ClientHello, RejectReason};
use crate::protocol::secure::StaticKeys;
use crate::protocol::MAX_CLIP_IMAGE_BYTES;

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HubEvent {
    /// `device_id` es la clave pública del móvil en hex, no el id que declara.
    PeerConnected {
        session_id: u64,
        device_id: String,
        device_name: String,
        transport: Transport,
    },
    PeerDisconnected {
        session_id: u64,
        reason: String,
    },
    ClipReceived {
        session_id: u64,
        text: String,
    },
    LocalClipSuperseded {
        text: String,
    },
    Transfer(TransferUpdate),
    /// Un móvil se emparejó con el token del QR (o volvió a escanearlo): el QR ya no sirve.
    DevicePaired {
        device_key: String,
        device_name: String,
    },
    /// Imagen para el portapapeles guardada en `image_dir` (`location`); la app la pone en el
    /// portapapeles y llama a `mark_image_synced`.
    ClipImageReceived {
        session_id: u64,
        location: String,
    },
}

/// Imagen actual del portapapeles del PC, ya codificada en PNG.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalImage {
    /// hash de lo que devuelve el portapapeles (no de los bytes del PNG)
    pub hash: String,
    pub png_path: PathBuf,
}

pub struct HubConfig {
    pub device_id: String,
    pub pc_name: String,
    pub download_dir: PathBuf,
    /// destino de las imágenes con `purpose:"clipboard"` (se crea si falta)
    pub image_dir: PathBuf,
    pub local_clip: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// la imagen que se ofrece al conectar un móvil
    pub local_image: Arc<dyn Fn() -> Option<LocalImage> + Send + Sync>,
    /// identidad del PC: respondedor del handshake Noise IK
    pub keys: StaticKeys,
    pub paired: PairedStore,
}

/// Mayor entero que JS representa sin pérdida: el tamaño de un archivo no puede pasar de aquí.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const FILE_MIME: &str = "application/octet-stream";
/// Conexiones a la vez que aún no han completado el handshake (pares desconocidos de la LAN).
const MAX_PRE_HANDSHAKE_SESSIONS: usize = 8;
const FORGOTTEN: &str = "forgotten";
/// Sesiones cerradas cuyo dispositivo se recuerda para un `mark_image_synced` tardío.
const MAX_ENDED_SESSIONS: usize = 32;

fn log(msg: &str) {
    // stderr: stdout puede llevar eventos en JSON (ejemplo headless); writeln no hace panic
    let _ = writeln!(std::io::stderr(), "[Hub] {msg}");
}

/// Milisegundos desde 1970 (reloj del sistema), para los tokens y `pairedAtMs`.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Inner>,
}

struct Inner {
    device_id: String,
    pc_name: String,
    download_dir: PathBuf,
    image_dir: PathBuf,
    local_clip: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    local_image: Arc<dyn Fn() -> Option<LocalImage> + Send + Sync>,
    keys: StaticKeys,
    events: mpsc::UnboundedSender<HubEvent>,
    next_id: AtomicU64,
    state: Mutex<State>,
}

struct State {
    sessions: BTreeMap<u64, Entry>,
    /// anti-rebote (texto e imagen) por dispositivo, en memoria
    syncs: HashMap<String, DeviceSyncs>,
    /// (sesión, dispositivo) de las últimas sesiones cerradas
    ended: VecDeque<(u64, String)>,
    ready_count: u64,
    paired: PairedStore,
    /// emparejados con el token cuyo `paired.json` no se pudo guardar: valen hasta cerrar la app
    unsaved: Vec<PairedDevice>,
    tokens: PairingTokens,
}

impl State {
    fn is_paired(&mut self, device_key: &str) -> bool {
        self.paired.contains(device_key) || self.unsaved.iter().any(|d| d.public_key == device_key)
    }

    /// Guarda el emparejamiento; si no se puede, lo deja en memoria y lo registra.
    fn save_paired(&mut self, device: PairedDevice) {
        let key = device.public_key.clone();
        match self.paired.upsert(device.clone()) {
            Ok(()) => self.unsaved.retain(|d| d.public_key != key),
            Err(e) => {
                log(&format!("no se pudo guardar el emparejamiento: {e}"));
                if !self.paired.contains(&key) {
                    match self.unsaved.iter_mut().find(|d| d.public_key == key) {
                        Some(d) => {
                            d.device_id = device.device_id;
                            d.device_name = device.device_name;
                        }
                        None => self.unsaved.push(device),
                    }
                }
            }
        }
    }
}

struct Entry {
    commands: mpsc::UnboundedSender<Command>,
    transport: Transport,
    /// `device_key` del móvil desde que se autoriza (también durante la regla de inicio)
    device_id: Option<String>,
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
        (self.local_clip)()
    }

    fn local_image(&self) -> Option<LocalImage> {
        (self.local_image)()
    }

    /// Spec §3.2: entra un móvil emparejado o el que trae el token vigente del QR. Con el token
    /// vigente se consume, se guarda (o actualiza) el emparejamiento y se emite `DevicePaired`.
    fn authorize(
        &self,
        session_id: u64,
        public_key: &[u8; 32],
        hello: &ClientHello,
    ) -> Result<(), RejectReason> {
        let key = hex::encode(public_key);
        let now = now_ms();
        let mut st = lock(&self.state);
        let token = hello
            .pairing_token
            .as_deref()
            .map(|t| st.tokens.check_and_consume(t, now));
        if token == Some(TokenCheck::Valid) {
            st.save_paired(PairedDevice {
                public_key: key.clone(),
                device_id: hello.device_id.clone(),
                device_name: hello.device_name.clone(),
                paired_at_ms: now,
            });
            self.emit(HubEvent::DevicePaired {
                device_key: key.clone(),
                device_name: hello.device_name.clone(),
            });
        } else if !st.is_paired(&key) {
            return Err(match token {
                Some(TokenCheck::Expired) => RejectReason::PairingExpired,
                _ => RejectReason::NotPaired,
            });
        }
        // desde ya cuenta como sesión del dispositivo: «Olvidar» también la cierra
        if let Some(e) = st.sessions.get_mut(&session_id) {
            e.device_id = Some(key);
        }
        Ok(())
    }

    /// Se llama tras aceptar el handshake, antes de la regla de inicio. Si el dispositivo ya tenía
    /// sesión (p. ej. TCP medio abierto), lo último "enviado" por ella puede no haber llegado: se
    /// olvida la sincronía (texto e imagen) para que la regla reenvíe lo actual (un duplicado es
    /// inofensivo).
    fn syncs_for(&self, _session_id: u64, device_id: &str) -> DeviceSyncs {
        let mut st = lock(&self.state);
        let reconnect = st
            .sessions
            .values()
            .any(|e| e.peer.as_ref().is_some_and(|(d, _)| d == device_id));
        let syncs = st
            .syncs
            .entry(device_id.to_string())
            .or_insert_with(DeviceSyncs::new);
        if reconnect {
            syncs.reset();
        }
        syncs.clone()
    }

    // Se emite con el estado bloqueado para que el orden del canal sea el de los cambios.
    fn on_event(&self, session_id: u64, event: SessionEvent) {
        let mut st = lock(&self.state);
        match event {
            SessionEvent::Ready {
                device_id,
                device_name,
            } => {
                st.ready_count += 1;
                let order = st.ready_count;
                let Some(entry) = st.sessions.get_mut(&session_id) else {
                    return;
                };
                entry.peer = Some((device_id.clone(), order));
                let transport = entry.transport;
                self.emit(HubEvent::PeerConnected {
                    session_id,
                    device_id: device_id.clone(),
                    device_name,
                    transport,
                });
                // un móvil con la misma clave que ya tenía sesión: la vieja se cierra
                for (id, e) in &st.sessions {
                    if *id != session_id && e.peer.as_ref().is_some_and(|(d, _)| *d == device_id) {
                        let _ = e.commands.send(Command::Close("replaced".into()));
                    }
                }
            }
            SessionEvent::Clip(text) => {
                self.emit(HubEvent::ClipReceived {
                    session_id,
                    text: text.clone(),
                });
                // el origen ya lo marcó; al resto se reenvía y cada una decide con su ClipboardSync
                for (id, e) in &st.sessions {
                    if *id != session_id {
                        let _ = e.commands.send(Command::SendClip(text.clone()));
                    }
                }
            }
            SessionEvent::LocalClipSuperseded(text) => {
                self.emit(HubEvent::LocalClipSuperseded { text })
            }
            SessionEvent::Transfer(u) => self.emit(HubEvent::Transfer(u)),
            SessionEvent::ClipImage(location) => self.emit(HubEvent::ClipImageReceived {
                session_id,
                location,
            }),
            SessionEvent::Closed(reason) => {
                let Some((device_id, _)) = st.sessions.remove(&session_id).and_then(|e| e.peer)
                else {
                    return; // solo se avisa de la desconexión de quien llegó a conectarse
                };
                if st.ended.len() >= MAX_ENDED_SESSIONS {
                    st.ended.pop_front();
                }
                st.ended.push_back((session_id, device_id.clone()));
                // el enlace cayó: lo último escrito puede no haber llegado al móvil. Si ya hay otra
                // sesión del dispositivo (aunque esté saludando), su saludo ya lo restableció y lo
                // que haya marcado desde entonces es válido: no se toca.
                let otra = st
                    .sessions
                    .values()
                    .any(|e| e.device_id.as_deref() == Some(device_id.as_str()));
                if (reason == "link_closed" || reason == "heartbeat_timeout") && !otra {
                    if let Some(syncs) = st.syncs.get(&device_id) {
                        syncs.reset();
                    }
                }
                self.emit(HubEvent::PeerDisconnected { session_id, reason });
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
        let HubConfig {
            device_id,
            pc_name,
            download_dir,
            image_dir,
            local_clip,
            local_image,
            keys,
            paired,
        } = config;
        let inner = Inner {
            device_id,
            pc_name,
            download_dir,
            image_dir,
            local_clip,
            local_image,
            keys,
            events,
            next_id: AtomicU64::new(1),
            state: Mutex::new(State {
                sessions: BTreeMap::new(),
                syncs: HashMap::new(),
                ended: VecDeque::new(),
                ready_count: 0,
                paired,
                unsaved: Vec::new(),
                tokens: PairingTokens::default(),
            }),
        };
        (
            Hub {
                inner: Arc::new(inner),
            },
            rx,
        )
    }

    /// Bucle de accept; no termina. Un error al aceptar se registra y se sigue.
    pub async fn serve_tcp(&self, listener: tokio::net::TcpListener) {
        loop {
            match listener.accept().await {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    let transport = if is_loopback(addr.ip()) {
                        Transport::Usb
                    } else {
                        Transport::Wifi
                    };
                    self.accept_stream(stream, transport);
                }
                Err(e) => {
                    log(&format!("Error al aceptar una conexión: {e}"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Lanza una sesión sobre el flujo. Debe llamarse dentro de un runtime de tokio.
    /// Con `MAX_PRE_HANDSHAKE_SESSIONS` sesiones aún sin handshake, el flujo se cierra al momento.
    pub fn accept_stream<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        &self,
        stream: S,
        transport: Transport,
    ) {
        let mut st = lock(&self.inner.state);
        let sin_handshake = st
            .sessions
            .values()
            .filter(|e| e.device_id.is_none())
            .count();
        if sin_handshake >= MAX_PRE_HANDSHAKE_SESSIONS {
            return; // `stream` se suelta aquí: la conexión se cierra
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        st.sessions.insert(
            id,
            Entry {
                commands: tx,
                transport,
                device_id: None,
                peer: None,
            },
        );
        drop(st);
        let inner = &self.inner;
        let cfg = SessionConfig {
            id,
            device_id: inner.device_id.clone(),
            device_name: inner.pc_name.clone(),
            download_dir: inner.download_dir.clone(),
            image_dir: inner.image_dir.clone(),
            keys: inner.keys.clone(),
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

    /// A cada sesión lista cuya `ImageSync` no la tenga; marca tentativo por dispositivo.
    /// `Err("too_large")` si pasa de 20 MiB; `Err("read_error")` si no se puede leer.
    /// Cada sesión decide con su `ImageSync` (las que aún saludan lo ignoran: su envío de inicio
    /// lee `local_image`). Hay que actualizar `local_image` antes de llamar.
    pub fn broadcast_clip_image(&self, image: &LocalImage) -> Result<(), String> {
        let meta = std::fs::metadata(&image.png_path).map_err(|_| "read_error")?;
        if !meta.is_file() {
            return Err("read_error".into());
        }
        if meta.len() > MAX_CLIP_IMAGE_BYTES {
            return Err("too_large".into());
        }
        for e in lock(&self.inner.state).sessions.values() {
            let _ = e.commands.send(Command::SendImage(image.clone()));
        }
        Ok(())
    }

    /// La capa app escribió la imagen recibida por esa sesión y leyó `hash` de vuelta: ese
    /// dispositivo ya la tiene. Vale también si la sesión ya se cerró.
    pub fn mark_image_synced(&self, session_id: u64, hash: &str) {
        let st = lock(&self.inner.state);
        let device = match st.sessions.get(&session_id) {
            Some(e) => e.device_id.clone(),
            None => st
                .ended
                .iter()
                .find(|(id, _)| *id == session_id)
                .map(|(_, d)| d.clone()),
        };
        if let Some(syncs) = device.and_then(|d| st.syncs.get(&d)) {
            // el PC no guarda el confirmado entre arranques
            let _ = lock(&syncs.image).mark_synced(hash);
        }
    }

    /// Envía el archivo a la sesión conectada más reciente y devuelve su transferId.
    /// `Err("no_peer")` si no hay ninguna; `Err("read_error")` si no se puede abrir.
    pub fn send_file(&self, path: &Path) -> Result<String, String> {
        let file = std::fs::File::open(path).map_err(|_| "read_error")?;
        let meta = file.metadata().map_err(|_| "read_error")?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        let (Some(name), true) = (name, meta.is_file()) else {
            return Err("read_error".into());
        };
        if meta.len() > MAX_SAFE_INTEGER {
            return Err("read_error".into());
        }
        let (id, id_bytes) = new_id();
        let queued = TransferUpdate {
            transfer_id: id.clone(),
            direction: Direction::Out,
            name: name.clone(),
            size: meta.len(),
            bytes: 0,
            state: TransferState::Queued,
            error: None,
            location: None,
            purpose: None,
        };
        let mut out = OutFile {
            meta: OutMeta {
                id: id.clone(),
                id_bytes,
                name,
                size: meta.len(),
                mime: FILE_MIME.into(),
            },
            file,
        };
        let st = lock(&self.inner.state);
        let mut peers: Vec<(u64, &Entry)> = st
            .sessions
            .values()
            .filter_map(|e| e.peer.as_ref().map(|(_, order)| (*order, e)))
            .collect();
        peers.sort_by_key(|p| std::cmp::Reverse(p.0));
        // si la más reciente se está cerrando, se prueba con la anterior
        for (_, e) in peers {
            match e.commands.send(Command::SendFile(out)) {
                Ok(()) => {
                    // con el estado bloqueado: la sesión no puede emitir nada de este archivo antes
                    self.inner.emit(HubEvent::Transfer(queued));
                    return Ok(id);
                }
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

    // --- emparejamiento ---

    /// Clave pública del PC (va en el QR).
    pub fn public_key(&self) -> [u8; 32] {
        self.inner.keys.public
    }

    /// Emite un token nuevo para el QR; invalida el anterior.
    pub fn start_pairing(&self) -> PairingOffer {
        lock(&self.inner.state).tokens.offer(now_ms())
    }

    pub fn cancel_pairing(&self) {
        lock(&self.inner.state).tokens.cancel();
    }

    /// La oferta vigente: sin usar y sin caducar.
    pub fn pairing_offer(&self) -> Option<PairingOffer> {
        lock(&self.inner.state).tokens.active(now_ms())
    }

    /// `true` si `paired.json` no se pudo leer: los emparejamientos nuevos no se guardan.
    pub fn paired_load_failed(&self) -> bool {
        lock(&self.inner.state).paired.load_failed()
    }

    /// Móviles emparejados, por fecha de emparejamiento.
    pub fn paired_devices(&self) -> Vec<PairedDevice> {
        let st = lock(&self.inner.state);
        let mut v = st.paired.list();
        // un pendiente de guardar que ya está en el archivo (se recuperó la lectura) no se repite
        let en_archivo: Vec<String> = v.iter().map(|d| d.public_key.clone()).collect();
        v.extend(
            st.unsaved
                .iter()
                .filter(|d| !en_archivo.contains(&d.public_key))
                .cloned(),
        );
        v.sort_by_key(|d| d.paired_at_ms);
        v
    }

    /// Olvida un móvil: lo quita de `paired.json`, cierra sus sesiones con `forgotten` y borra su
    /// anti-rebote. `false` si no estaba emparejado o no se pudo guardar el cambio (sigue igual).
    pub fn forget_device(&self, device_key: &str) -> bool {
        let mut st = lock(&self.inner.state);
        let unsaved = st.unsaved.len();
        st.unsaved.retain(|d| d.public_key != device_key);
        let removed = match st.paired.remove(device_key) {
            Ok(removed) => removed || st.unsaved.len() != unsaved,
            Err(e) => {
                log(&format!("no se pudo olvidar el dispositivo: {e}"));
                return false;
            }
        };
        if !removed {
            return false;
        }
        for e in st.sessions.values() {
            if e.device_id.as_deref() == Some(device_key) {
                let _ = e.commands.send(Command::Close(FORGOTTEN.into()));
            }
        }
        st.syncs.remove(device_key);
        true
    }
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
