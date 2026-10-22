//! Estado de la interfaz del PC: pares, historial y transferencias, a partir de los `HubEvent`.
//! La parte pura (`AppState`) no depende de Tauri; el cableado está en `lib.rs`.

pub mod clipboard;
pub mod images;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Notify};

use clipboard::ClipboardHandle;

use crate::core::pairing::{lan_ipv4s, pairing_uri, qr_svg, PairedDevice};
use crate::core::{
    ClipDecision, ClipboardSync, Direction, Hub, HubEvent, LocalImage, TransferState,
    TransferUpdate, Transport,
};
use crate::listeners::AdapterState;
use crate::protocol::{
    encode_control, ControlMessage, DEFAULT_TCP_PORT, MAX_CLIP_IMAGE_BYTES, MAX_HISTORY,
    PURPOSE_CLIPBOARD,
};

pub const CLIP_TOO_LARGE_NOTICE: &str = "Texto demasiado grande para sincronizar (máx. 1 MB)";
pub const CLIP_NOTICE_MS: u64 = 5_000;
/// Avisos de imagen: van en `clipNotice`, como el del texto grande.
pub const IMAGE_TOO_LARGE_NOTICE: &str = "Imagen demasiado grande para sincronizar (máx. 20 MB)";
pub const IMAGE_WRITE_ERROR: &str = "No se pudo poner la imagen en el portapapeles";
/// Cuánto se muestra el aviso «emparejado».
pub const PAIR_NOTICE_MS: u64 = 5_000;
/// Error de `start_pairing` si el PC no tiene ninguna IPv4 de LAN que poner en el QR.
pub const NO_NETWORK_ERROR: &str = "No hay ninguna red disponible";
/// Aviso fijo si no se puede escuchar en el puerto TCP del protocolo.
pub const SERVER_PORT_ERROR: &str =
    "No se pudo abrir el puerto 52847: puede que otra copia de ClipSync esté abierta";

/// Aviso fijo si `paired.json` existe pero no se pudo leer.
pub const PAIRED_LOAD_ERROR: &str =
    "No se pudo leer la lista de móviles emparejados; los emparejamientos nuevos no se guardarán.";
/// Aviso fijo si la identidad del PC no se pudo guardar en disco.
pub const IDENTITY_NOT_SAVED_ERROR: &str =
    "No se pudo guardar la identidad del PC: los móviles tendrán que volver a emparejarse en cada arranque.";

/// Transferencias terminadas sin éxito que se siguen mostrando.
pub const MAX_FINISHED_TRANSFERS: usize = 5;

pub const DIR_IN: &str = "in";
pub const DIR_OUT: &str = "out";
pub const DIR_LOCAL: &str = "local";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub session_id: u64,
    pub device_id: String,
    pub device_name: String,
    pub transport: Transport,
}

/// Móvil emparejado; `connected` si ahora mismo hay una sesión suya.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedView {
    pub device_key: String,
    pub device_name: String,
    pub paired_at_ms: u64,
    pub connected: bool,
}

/// QR de emparejamiento vigente.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    pub qr_svg: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: u64,
    pub kind: String,
    pub direction: String,
    pub text: Option<String>,
    pub file_name: Option<String>,
    pub location: Option<String>,
    /// miniatura JPEG en data URL (`data:image/jpeg;base64,…`); solo en `kind: "image"`
    pub thumbnail: Option<String>,
    pub at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub pc_name: String,
    pub peers: Vec<PeerView>,
    pub history: Vec<HistoryItem>,
    pub transfers: Vec<TransferUpdate>,
    pub clipboard_error: Option<String>,
    pub clip_notice: Option<String>,
    pub server_error: Option<String>,
    /// Estado del Bluetooth del PC («Este PC no tiene Bluetooth», «Bluetooth apagado»); `None` si funciona.
    pub bluetooth_notice: Option<String>,
    pub paired: Vec<PairedView>,
    pub pairing: Option<PairingView>,
    pub pair_notice: Option<String>,
}

/// Qué hacer con un texto nuevo del portapapeles local.
#[derive(Debug, PartialEq, Eq)]
pub enum LocalClip {
    Blank,
    TooLarge,
    Send,
}

/// El Hub decide por su cuenta si un clip cabe; aquí se repite el mismo criterio (texto de
/// 1 MiB como máximo y mensaje de control de 2 MiB) para poder avisar al usuario.
pub fn classify_local_clip(text: &str) -> LocalClip {
    match ClipboardSync::new(None).check(text) {
        ClipDecision::Empty => return LocalClip::Blank,
        ClipDecision::TooLarge => return LocalClip::TooLarge,
        ClipDecision::Send | ClipDecision::Duplicate => {}
    }
    let msg = ControlMessage::Clip {
        id: "0".repeat(32),
        text: text.to_string(),
        hash: hex::encode(Sha256::digest(text.as_bytes())),
    };
    match encode_control(&msg) {
        Ok(_) => LocalClip::Send,
        Err(_) => LocalClip::TooLarge,
    }
}

fn is_finished(state: TransferState) -> bool {
    matches!(
        state,
        TransferState::Done | TransferState::Failed | TransferState::Cancelled
    )
}

pub struct AppState {
    pc_name: String,
    peers: Vec<PeerView>,
    /// el más reciente primero
    history: VecDeque<HistoryItem>,
    /// en orden de llegada; las terminadas con éxito pasan al historial
    transfers: Vec<TransferUpdate>,
    /// ruta de origen de cada archivo enviado, para el historial
    out_paths: HashMap<String, String>,
    clipboard_error: Option<String>,
    /// aviso informativo (texto o imagen) y hasta cuándo se muestra
    clip_notice: Option<(String, u64)>,
    server_error: Option<String>,
    /// último estado del adaptador Bluetooth que comunicó el listener RFCOMM
    bluetooth: Option<AdapterState>,
    paired: Vec<PairedDevice>,
    pairing: Option<PairingView>,
    /// texto del aviso «emparejado» y hasta cuándo se muestra
    pair_notice: Option<(String, u64)>,
    next_id: u64,
    /// PNG de la caché de cada item de imagen (para `copy_image` y la poda)
    images: HashMap<u64, PathBuf>,
    /// PNG que ya no usa el historial; los borra el hilo del portapapeles
    trash: Vec<PathBuf>,
    /// borrados fallidos: vuelven a la papelera en la siguiente poda
    failed_deletes: Vec<PathBuf>,
}

impl AppState {
    pub fn new(pc_name: String) -> Self {
        Self {
            pc_name,
            peers: Vec::new(),
            history: VecDeque::new(),
            transfers: Vec::new(),
            out_paths: HashMap::new(),
            clipboard_error: None,
            clip_notice: None,
            server_error: None,
            bluetooth: None,
            paired: Vec::new(),
            pairing: None,
            pair_notice: None,
            next_id: 1,
            images: HashMap::new(),
            trash: Vec::new(),
            failed_deletes: Vec::new(),
        }
    }

    pub fn apply(&mut self, ev: HubEvent, now_ms: u64) {
        match ev {
            HubEvent::PeerConnected {
                session_id,
                device_id,
                device_name,
                transport,
            } => {
                self.peers.retain(|p| p.session_id != session_id);
                self.peers.push(PeerView {
                    session_id,
                    device_id,
                    device_name,
                    transport,
                });
            }
            HubEvent::PeerDisconnected { session_id, .. } => {
                self.peers.retain(|p| p.session_id != session_id)
            }
            HubEvent::ClipReceived { text, .. } => self.add_text(DIR_IN, text, now_ms),
            HubEvent::LocalClipSuperseded { text } => {
                // se emite en cada reconexión en la que gana el móvil: sin esto el mismo
                // texto llenaría el historial
                let newest_text = self.history.iter().find_map(|i| i.text.as_deref());
                if newest_text != Some(text.as_str()) {
                    self.add_text(DIR_LOCAL, text, now_ms);
                }
            }
            HubEvent::Transfer(u) => self.on_transfer(u, now_ms),
            // la lista de emparejados la recarga quien tiene el Hub (`Ctx`) con `set_paired`
            HubEvent::DevicePaired { device_name, .. } => {
                self.pairing = None;
                self.pair_notice = Some((
                    format!("«{device_name}» emparejado"),
                    now_ms.saturating_add(PAIR_NOTICE_MS),
                ));
            }
            // la pone en el portapapeles el hilo del portapapeles, que luego la anota
            HubEvent::ClipImageReceived { .. } => {}
        }
    }

    fn on_transfer(&mut self, u: TransferUpdate, now_ms: u64) {
        let finished = is_finished(u.state);
        let source = if finished {
            self.out_paths.remove(&u.transfer_id)
        } else {
            None
        };
        if u.state == TransferState::Done {
            self.transfers.retain(|t| t.transfer_id != u.transfer_id);
            if u.purpose.as_deref() == Some(PURPOSE_CLIPBOARD) {
                // imagen del portapapeles: su item `image` lo pone quien la copia o la recibe
                return;
            }
            let (direction, location) = match u.direction {
                Direction::In => (DIR_IN, u.location),
                Direction::Out => (DIR_OUT, u.location.or(source)),
            };
            self.push(HistoryItem {
                id: 0,
                kind: "file".into(),
                direction: direction.into(),
                text: None,
                file_name: Some(u.name),
                location,
                thumbnail: None,
                at_ms: now_ms,
            });
            return;
        }
        match self
            .transfers
            .iter_mut()
            .find(|t| t.transfer_id == u.transfer_id)
        {
            Some(t) => *t = u,
            None => self.transfers.push(u),
        }
        if finished {
            // se quitan las terminadas más antiguas; las que siguen en curso no se tocan
            let mut sobran = self
                .transfers
                .iter()
                .filter(|t| is_finished(t.state))
                .count()
                .saturating_sub(MAX_FINISHED_TRANSFERS);
            self.transfers.retain(|t| {
                if sobran > 0 && is_finished(t.state) {
                    sobran -= 1;
                    false
                } else {
                    true
                }
            });
        }
    }

    fn push(&mut self, mut item: HistoryItem) {
        item.id = self.next_id;
        self.next_id += 1;
        self.history.push_front(item);
        while self.history.len() > MAX_HISTORY {
            let Some(old) = self.history.pop_back() else {
                break;
            };
            if let Some(png) = self.images.remove(&old.id) {
                self.discard_image(png);
            }
        }
    }

    fn push_image(&mut self, item: HistoryItem, png: PathBuf) {
        let id = self.next_id;
        self.push(item);
        self.images.insert(id, png);
    }

    /// Imagen copiada en el PC y entregada al Hub; como el texto, sin móvil no se anota.
    pub fn add_sent_image(&mut self, png: PathBuf, thumbnail: Option<String>, now_ms: u64) {
        if self.peers.is_empty() {
            return;
        }
        let item = HistoryItem {
            id: 0,
            kind: "image".into(),
            direction: DIR_OUT.into(),
            text: None,
            file_name: None,
            location: None,
            thumbnail,
            at_ms: now_ms,
        };
        self.push_image(item, png);
    }

    /// Imagen recibida y puesta en el portapapeles; `location` es el archivo de `image_dir`.
    pub fn add_received_image(
        &mut self,
        png: PathBuf,
        thumbnail: Option<String>,
        location: String,
        now_ms: u64,
    ) {
        let item = HistoryItem {
            id: 0,
            kind: "image".into(),
            direction: DIR_IN.into(),
            text: None,
            file_name: Path::new(&location)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned()),
            location: Some(location),
            thumbnail,
            at_ms: now_ms,
        };
        self.push_image(item, png);
    }

    /// Imagen recibida que no se pudo poner en el portapapeles: queda como archivo.
    pub fn add_received_file(&mut self, location: String, now_ms: u64) {
        let item = HistoryItem {
            id: 0,
            kind: "file".into(),
            direction: DIR_IN.into(),
            text: None,
            file_name: Path::new(&location)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned()),
            location: Some(location),
            thumbnail: None,
            at_ms: now_ms,
        };
        self.push(item);
    }

    /// PNG de la caché de un item de imagen.
    pub fn image_path(&self, id: u64) -> Option<PathBuf> {
        self.images.get(&id).cloned()
    }

    pub fn image_in_use(&self, png: &Path) -> bool {
        self.images.values().any(|p| p == png)
    }

    /// Manda un PNG a la papelera (y con él los borrados fallidos, para reintentarlos).
    pub fn discard_image(&mut self, png: PathBuf) {
        self.trash.push(png);
        self.trash.append(&mut self.failed_deletes);
    }

    pub fn take_trash(&mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.trash)
    }

    pub fn retry_later(&mut self, paths: Vec<PathBuf>) {
        self.failed_deletes.extend(paths);
    }

    /// Texto copiado en el PC y entregado al Hub. Sin móvil conectado no se anota: no salió
    /// a ningún sitio (la regla de inicio lo enviará al conectar, sin item propio).
    pub fn add_sent_text(&mut self, text: String, now_ms: u64) {
        if !self.peers.is_empty() {
            self.add_text(DIR_OUT, text, now_ms);
        }
    }

    pub fn add_text(&mut self, direction: &str, text: String, now_ms: u64) {
        self.push(HistoryItem {
            id: 0,
            kind: "text".into(),
            direction: direction.into(),
            text: Some(text),
            file_name: None,
            location: None,
            thumbnail: None,
            at_ms: now_ms,
        });
    }

    pub fn add_out_path(&mut self, transfer_id: String, path: String) {
        self.out_paths.insert(transfer_id, path);
    }

    /// Devuelve si cambió, para no reemitir el estado en cada sondeo.
    pub fn set_clipboard_error(&mut self, error: Option<String>) -> bool {
        if self.clipboard_error == error {
            return false;
        }
        self.clipboard_error = error;
        true
    }

    /// Añade un aviso fijo a los que ya hay (separados por un espacio); uno repetido no se duplica.
    pub fn add_server_error(&mut self, error: &str) {
        self.server_error = Some(match self.server_error.take() {
            None => error.to_string(),
            Some(actual) if actual.contains(error) => actual,
            Some(actual) => format!("{actual} {error}"),
        });
    }

    /// Guarda el estado del Bluetooth; `true` si cambió.
    pub fn set_bluetooth(&mut self, estado: AdapterState) -> bool {
        if self.bluetooth.as_ref() == Some(&estado) {
            return false;
        }
        self.bluetooth = Some(estado);
        true
    }

    /// Dirección Bluetooth del PC para el QR, si hay adaptador.
    pub fn bluetooth_address(&self) -> Option<String> {
        self.bluetooth.as_ref().and_then(|b| b.qr_address()).map(str::to_string)
    }

    pub fn show_clip_notice(&mut self, now_ms: u64) {
        self.show_notice(CLIP_TOO_LARGE_NOTICE, now_ms);
    }

    /// Aviso informativo de 5 s (sustituye al que hubiera).
    pub fn show_notice(&mut self, text: &str, now_ms: u64) {
        self.clip_notice = Some((text.to_string(), now_ms.saturating_add(CLIP_NOTICE_MS)));
    }

    pub fn set_paired(&mut self, devices: Vec<PairedDevice>) {
        self.paired = devices;
    }

    pub fn set_pairing(&mut self, view: Option<PairingView>) {
        self.pairing = view;
    }

    pub fn snapshot(&self, now_ms: u64) -> UiState {
        let clip_notice = self
            .clip_notice
            .as_ref()
            .filter(|(_, until)| now_ms < *until)
            .map(|(text, _)| text.clone());
        let paired = self
            .paired
            .iter()
            .map(|d| PairedView {
                device_key: d.public_key.clone(),
                device_name: d.device_name.clone(),
                paired_at_ms: d.paired_at_ms,
                connected: self.peers.iter().any(|p| p.device_id == d.public_key),
            })
            .collect();
        let pairing = self
            .pairing
            .as_ref()
            .filter(|p| now_ms < p.expires_at_ms)
            .cloned();
        let pair_notice = self
            .pair_notice
            .as_ref()
            .filter(|(_, until)| now_ms < *until)
            .map(|(text, _)| text.clone());
        UiState {
            pc_name: self.pc_name.clone(),
            peers: self.peers.clone(),
            history: self.history.iter().cloned().collect(),
            transfers: self.transfers.clone(),
            clipboard_error: self.clipboard_error.clone(),
            clip_notice,
            server_error: self.server_error.clone(),
            bluetooth_notice: self
                .bluetooth
                .as_ref()
                .and_then(|b| b.notice())
                .map(str::to_string),
            paired,
            pairing,
            pair_notice,
        }
    }
}

// --- cableado con Tauri ---

/// Como mucho 4 emisiones de `ui-state` por segundo.
const EMIT_INTERVAL: Duration = Duration::from_millis(250);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Un Mutex envenenado no debe tumbar la app (panic = "abort"): se sigue con el valor.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[App] {msg}");
}

/// Lo que comparten los comandos, el bucle de eventos y el hilo del portapapeles.
/// Orden de bloqueo: `state` antes que el Hub, nunca al revés; `local_clip` y `local_image` no
/// se tienen tomados mientras se toma otro.
pub struct Ctx {
    hub: Hub,
    pc_name: String,
    state: Mutex<AppState>,
    /// texto local que el Hub ofrece a las sesiones nuevas; se actualiza antes de cada broadcast
    local_clip: Arc<Mutex<Option<String>>>,
    /// imagen local que el Hub ofrece a las sesiones nuevas; ídem
    local_image: Arc<Mutex<Option<LocalImage>>>,
    clipboard: ClipboardHandle,
    changed: Arc<Notify>,
}

impl Ctx {
    pub fn new(
        hub: Hub,
        pc_name: String,
        local_clip: Arc<Mutex<Option<String>>>,
        local_image: Arc<Mutex<Option<LocalImage>>>,
        clipboard: ClipboardHandle,
    ) -> Self {
        let mut state = AppState::new(pc_name.clone());
        state.set_paired(hub.paired_devices());
        Self {
            hub,
            pc_name,
            state: Mutex::new(state),
            local_clip,
            local_image,
            clipboard,
            changed: Arc::new(Notify::new()),
        }
    }

    fn notify(&self) {
        self.changed.notify_one();
    }

    pub fn set_local(&self, text: Option<String>) {
        *lock(&self.local_clip) = text;
    }

    pub fn set_initial_local(&self, text: &str) {
        if classify_local_clip(text) == LocalClip::Send {
            self.set_local(Some(text.to_string()));
        }
    }

    /// Aviso fijo de arranque (puerto ocupado, lista de emparejados ilegible, identidad sin
    /// guardar…): se muestra en la interfaz junto a los demás (el detalle va a stderr).
    pub fn add_server_error(&self, error: &str) {
        lock(&self.state).add_server_error(error);
        self.notify();
    }

    /// Estado del adaptador Bluetooth que comunica el listener RFCOMM (aviso y dirección del QR).
    pub fn set_bluetooth(&self, estado: AdapterState) {
        if lock(&self.state).set_bluetooth(estado) {
            self.notify();
        }
    }

    pub fn set_clipboard_error(&self, error: Option<String>) {
        if !lock(&self.state).set_clipboard_error(error.clone()) {
            return;
        }
        if let Some(e) = error {
            let _ = writeln!(std::io::stderr(), "[Portapapeles] {e}");
        }
        self.notify();
    }

    /// Vuelve a cargar los móviles emparejados desde el Hub. Con `state` ya tomado (el orden
    /// es `state` antes que el Hub).
    fn reload_paired(&self, st: &mut AppState) {
        st.set_paired(self.hub.paired_devices());
    }

    /// Despierta al emisor cuando `delay_ms` después algo del estado deja de mostrarse (el QR
    /// caducado, el aviso): sin cambios de por medio nadie reemitiría `ui-state`.
    fn notify_after(&self, delay_ms: u64) {
        let changed = self.changed.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms + 50)).await;
            changed.notify_one();
        });
    }

    /// Emite un QR nuevo (invalida el anterior). Sin IPv4 de LAN no hay a dónde conectar:
    /// se cancela la oferta para que no quede ningún token válido sin QR.
    fn start_pairing(&self) -> Result<(), String> {
        let ips = lan_ipv4s();
        let mut st = lock(&self.state);
        if ips.is_empty() {
            self.hub.cancel_pairing();
            st.set_pairing(None);
            drop(st);
            self.notify();
            return Err(NO_NETWORK_ERROR.to_string());
        }
        let offer = self.hub.start_pairing();
        let uri = pairing_uri(
            &self.hub.public_key(),
            &offer.token,
            &self.pc_name,
            &ips,
            DEFAULT_TCP_PORT,
            st.bluetooth_address().as_deref(),
        );
        let svg = qr_svg(&uri);
        if svg.is_empty() {
            self.hub.cancel_pairing();
            st.set_pairing(None);
            drop(st);
            self.notify();
            return Err("No se pudo generar el código QR".to_string());
        }
        st.set_pairing(Some(PairingView {
            qr_svg: svg,
            expires_at_ms: offer.expires_at_ms,
        }));
        drop(st);
        self.notify();
        self.notify_after(offer.expires_at_ms.saturating_sub(now_ms()));
        Ok(())
    }

    fn cancel_pairing(&self) {
        let mut st = lock(&self.state);
        self.hub.cancel_pairing();
        st.set_pairing(None);
        drop(st);
        self.notify();
    }

    fn forget_device(&self, device_key: &str) -> Result<(), String> {
        let mut st = lock(&self.state);
        if !self.hub.forget_device(device_key) {
            return Err("No se pudo olvidar el dispositivo".to_string());
        }
        self.reload_paired(&mut st);
        drop(st);
        self.notify();
        Ok(())
    }

    /// Texto nuevo en el portapapeles del PC (desde el hilo del portapapeles).
    pub fn on_local_text(&self, text: String) {
        // el portapapeles ya no tiene imagen: no se ofrece a las sesiones nuevas
        self.replace_local_image(None);
        match classify_local_clip(&text) {
            LocalClip::Blank => self.set_local(None),
            LocalClip::TooLarge => {
                // no se envía, ni ahora ni a las sesiones que lleguen después
                self.set_local(None);
                lock(&self.state).show_clip_notice(now_ms());
                self.notify();
                self.notify_after(CLIP_NOTICE_MS);
            }
            LocalClip::Send => {
                self.set_local(Some(text.clone()));
                self.hub.broadcast_clip(&text);
                lock(&self.state).add_sent_text(text, now_ms());
                self.notify();
            }
        }
    }

    /// Cambia la imagen local; el PNG anterior, si cambia, va a la papelera (el hilo del
    /// portapapeles comprueba antes de borrarlo que nadie lo use).
    fn replace_local_image(&self, img: Option<LocalImage>) {
        let new_path = img.as_ref().map(|i| i.png_path.clone());
        let old = std::mem::replace(&mut *lock(&self.local_image), img);
        if let Some(old) = old.filter(|o| Some(&o.png_path) != new_path.as_ref()) {
            lock(&self.state).discard_image(old.png_path);
        }
    }

    fn show_notice_for(&self, text: &str) {
        lock(&self.state).show_notice(text, now_ms());
        self.notify();
        self.notify_after(CLIP_NOTICE_MS);
    }

    /// Consume los eventos del Hub mientras la app viva.
    pub async fn run_events(self: Arc<Self>, mut events: mpsc::UnboundedReceiver<HubEvent>) {
        while let Some(ev) = events.recv().await {
            match &ev {
                HubEvent::ClipReceived { text, .. } => self.clipboard.write(text.clone()),
                // decodificar y escribir lo hace el hilo del portapapeles, no el runtime
                HubEvent::ClipImageReceived {
                    session_id,
                    location,
                } => {
                    if !self
                        .clipboard
                        .write_received_image(*session_id, location.clone())
                    {
                        log("no se pudo poner la imagen: el portapapeles no está disponible");
                        self.show_notice_for(IMAGE_WRITE_ERROR);
                        lock(&self.state).add_received_file(location.clone(), now_ms());
                    }
                }
                _ => {}
            }
            let paired = matches!(ev, HubEvent::DevicePaired { .. });
            let mut st = lock(&self.state);
            st.apply(ev, now_ms());
            if paired {
                self.reload_paired(&mut st);
            }
            drop(st);
            self.notify();
            if paired {
                self.notify_after(PAIR_NOTICE_MS);
            }
        }
    }

    /// Emite `ui-state` tras cada cambio, agrupando los que llegan en menos de 250 ms.
    pub async fn run_emitter(self: Arc<Self>, app: AppHandle) {
        loop {
            self.changed.notified().await;
            let ui = lock(&self.state).snapshot(now_ms());
            if let Err(e) = app.emit("ui-state", ui) {
                log(&format!("no se pudo emitir ui-state: {e}"));
            }
            tokio::time::sleep(EMIT_INTERVAL).await;
        }
    }
}

#[tauri::command]
pub fn get_state(state: State<'_, Arc<Ctx>>) -> UiState {
    lock(&state.state).snapshot(now_ms())
}

/// Envía cada archivo y devuelve los transferId. Si ninguno sale, el primer error
/// (`no_peer` o `read_error`); los que fallan junto a otros que salen solo se registran.
#[tauri::command]
pub fn send_files(paths: Vec<String>, state: State<'_, Arc<Ctx>>) -> Result<Vec<String>, String> {
    // con el estado bloqueado: el evento de fin no puede procesarse antes de guardar la ruta
    let mut st = lock(&state.state);
    let mut ids = Vec::new();
    let mut first_err = None;
    for path in paths {
        match state.hub.send_file(Path::new(&path)) {
            Ok(id) => {
                st.add_out_path(id.clone(), path);
                ids.push(id);
            }
            Err(e) => {
                log(&format!("no se pudo enviar {path}: {e}"));
                let no_peer = e == "no_peer";
                first_err.get_or_insert(e);
                if no_peer {
                    break;
                }
            }
        }
    }
    match first_err {
        Some(e) if ids.is_empty() => Err(e),
        _ => Ok(ids),
    }
}

#[tauri::command]
pub fn cancel_transfer(transfer_id: String, state: State<'_, Arc<Ctx>>) {
    state.hub.cancel_transfer(&transfer_id);
}

/// Muestra un QR nuevo. `Err` si el PC no tiene ninguna red a la que conectar el móvil.
#[tauri::command]
pub fn start_pairing(state: State<'_, Arc<Ctx>>) -> Result<(), String> {
    state.start_pairing()
}

#[tauri::command]
pub fn cancel_pairing(state: State<'_, Arc<Ctx>>) {
    state.cancel_pairing();
}

/// Olvida un móvil emparejado; si estaba conectado, su sesión se cierra.
#[tauri::command]
pub fn forget_device(device_key: String, state: State<'_, Arc<Ctx>>) -> Result<(), String> {
    state.forget_device(&device_key)
}

/// Copia un texto del historial al portapapeles sin reenviarlo a los móviles.
#[tauri::command]
pub async fn copy_text(text: String, state: State<'_, Arc<Ctx>>) -> Result<(), String> {
    state.clipboard.write_and_wait(text).await
}

/// Vuelve a poner en el portapapeles la imagen de un item del historial, sin reenviarla a los
/// móviles. `Err("No se pudo poner la imagen en el portapapeles")` si el id no es de una imagen
/// o no se pudo poner.
#[tauri::command]
pub async fn copy_image(id: u64, state: State<'_, Arc<Ctx>>) -> Result<(), String> {
    let png = lock(&state.state)
        .image_path(id)
        .ok_or_else(|| IMAGE_WRITE_ERROR.to_string())?;
    state.clipboard.copy_image(png).await
}

impl clipboard::Host for Ctx {
    fn set_clipboard_error(&self, error: Option<String>) {
        Ctx::set_clipboard_error(self, error);
    }

    fn set_initial_local(&self, text: &str) {
        Ctx::set_initial_local(self, text);
    }

    fn on_local_text(&self, text: String) {
        Ctx::on_local_text(self, text);
    }

    fn text_written(&self, text: String) {
        self.set_local(Some(text));
        self.replace_local_image(None);
    }

    fn set_local_image(&self, img: Option<LocalImage>) {
        self.replace_local_image(img);
    }

    fn on_local_image(&self, img: LocalImage, thumbnail: Option<String>) {
        // antes del broadcast: el envío de inicio de las sesiones nuevas lee `local_image`
        self.replace_local_image(Some(img.clone()));
        match self.hub.broadcast_clip_image(&img) {
            Ok(()) => {
                lock(&self.state).add_sent_image(img.png_path, thumbnail, now_ms());
                self.notify();
            }
            Err(e) => {
                log(&format!("no se pudo difundir la imagen: {e}"));
                self.replace_local_image(None);
                if e == "too_large" {
                    self.show_notice_for(IMAGE_TOO_LARGE_NOTICE);
                }
            }
        }
    }

    fn on_image_received(
        &self,
        session_id: u64,
        hash: String,
        png: Option<(PathBuf, u64)>,
        thumbnail: Option<String>,
        location: String,
    ) {
        // ese móvil ya la tiene: con el hash leído de vuelta no rebota
        self.hub.mark_image_synced(session_id, &hash);
        match png {
            Some((path, size)) => {
                if size <= MAX_CLIP_IMAGE_BYTES {
                    // a los demás móviles; el de origen ya está sincronizado y se salta
                    let img = LocalImage {
                        hash,
                        png_path: path.clone(),
                    };
                    self.replace_local_image(Some(img.clone()));
                    if let Err(e) = self.hub.broadcast_clip_image(&img) {
                        log(&format!("no se pudo reenviar la imagen: {e}"));
                    }
                } else {
                    self.replace_local_image(None);
                }
                lock(&self.state).add_received_image(path, thumbnail, location, now_ms());
            }
            None => {
                self.replace_local_image(None);
                lock(&self.state).add_received_file(location, now_ms());
            }
        }
        self.notify();
    }

    fn on_image_receive_failed(&self, location: String) {
        lock(&self.state).add_received_file(location, now_ms());
        self.notify();
    }

    fn show_notice(&self, text: &'static str) {
        self.show_notice_for(text);
    }

    fn take_trash(&self) -> Vec<PathBuf> {
        lock(&self.state).take_trash()
    }

    fn image_in_use(&self, png: &Path) -> bool {
        let local = lock(&self.local_image)
            .as_ref()
            .is_some_and(|i| i.png_path == png);
        local || lock(&self.state).image_in_use(png)
    }

    fn retry_later(&self, failed: Vec<PathBuf>) {
        lock(&self.state).retry_later(failed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::MAX_CLIP_BYTES;

    fn st() -> AppState {
        AppState::new("mi-pc".into())
    }

    fn tu(id: &str, direction: Direction, state: TransferState, bytes: u64) -> TransferUpdate {
        TransferUpdate {
            transfer_id: id.into(),
            direction,
            name: format!("{id}.bin"),
            size: 100,
            bytes,
            state,
            error: None,
            location: None,
            purpose: None,
        }
    }

    fn connected(session_id: u64, device_id: &str) -> HubEvent {
        HubEvent::PeerConnected {
            session_id,
            device_id: device_id.into(),
            device_name: "Pixel 8".into(),
            transport: Transport::Wifi,
        }
    }

    #[test]
    fn historial_limitado_a_50_y_el_51_expulsa_al_mas_antiguo() {
        let mut s = st();
        for i in 1..=51 {
            s.add_text(DIR_OUT, i.to_string(), i);
        }
        let h = s.snapshot(0).history;
        assert_eq!(h.len(), 50);
        // el más reciente primero
        assert_eq!(h[0].text.as_deref(), Some("51"));
        assert_eq!(h[49].text.as_deref(), Some("2"));
        assert!(h.iter().all(|i| i.text.as_deref() != Some("1")));
    }

    #[test]
    fn items_de_texto_con_id_unico_y_hora() {
        let mut s = st();
        s.add_text(DIR_OUT, "a".into(), 10);
        s.add_text(DIR_OUT, "b".into(), 20);
        let h = s.snapshot(0).history;
        assert_ne!(h[0].id, h[1].id);
        assert_eq!(h[0].kind, "text");
        assert_eq!(h[0].direction, "out");
        assert_eq!(h[0].at_ms, 20);
        assert_eq!(h[0].file_name, None);
        assert_eq!(h[0].location, None);
    }

    #[test]
    fn transfer_inserta_y_actualiza_por_transfer_id() {
        let mut s = st();
        s.apply(
            HubEvent::Transfer(tu("t1", Direction::Out, TransferState::Queued, 0)),
            1,
        );
        s.apply(
            HubEvent::Transfer(tu("t2", Direction::Out, TransferState::Queued, 0)),
            1,
        );
        s.apply(
            HubEvent::Transfer(tu("t1", Direction::Out, TransferState::Active, 40)),
            2,
        );
        let t = s.snapshot(0).transfers;
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].transfer_id, "t1");
        assert_eq!(t[0].bytes, 40);
        assert_eq!(t[0].state, TransferState::Active);
        assert_eq!(t[1].transfer_id, "t2");
        assert_eq!(t[1].state, TransferState::Queued);
    }

    #[test]
    fn transfer_done_entrante_anade_archivo_al_historial_y_sale_de_activas() {
        let mut s = st();
        s.apply(
            HubEvent::Transfer(tu("t1", Direction::In, TransferState::Active, 0)),
            1,
        );
        let mut done = tu("t1", Direction::In, TransferState::Done, 100);
        done.name = "../foto.jpg".into();
        done.location = Some("/home/u/Descargas/foto.jpg".into());
        s.apply(HubEvent::Transfer(done), 7);
        let ui = s.snapshot(0);
        assert!(ui.transfers.is_empty());
        assert_eq!(ui.history.len(), 1);
        let h = &ui.history[0];
        assert_eq!(h.kind, "file");
        assert_eq!(h.direction, "in");
        assert_eq!(h.text, None);
        assert_eq!(h.file_name.as_deref(), Some("../foto.jpg"));
        assert_eq!(h.location.as_deref(), Some("/home/u/Descargas/foto.jpg"));
        assert_eq!(h.at_ms, 7);
    }

    #[test]
    fn transfer_done_saliente_usa_la_ruta_de_origen() {
        let mut s = st();
        s.add_out_path("t1".into(), "/home/u/doc.pdf".into());
        s.apply(
            HubEvent::Transfer(tu("t1", Direction::Out, TransferState::Done, 100)),
            3,
        );
        let h = &s.snapshot(0).history[0];
        assert_eq!(h.direction, "out");
        assert_eq!(h.location.as_deref(), Some("/home/u/doc.pdf"));
    }

    #[test]
    fn transfer_fallida_o_cancelada_se_queda_visible_sin_historial() {
        let mut s = st();
        let mut f = tu("t1", Direction::Out, TransferState::Failed, 10);
        f.error = Some("link_closed".into());
        s.apply(HubEvent::Transfer(f), 1);
        s.apply(
            HubEvent::Transfer(tu("t2", Direction::In, TransferState::Cancelled, 0)),
            1,
        );
        let ui = s.snapshot(0);
        assert!(ui.history.is_empty());
        assert_eq!(ui.transfers.len(), 2);
        assert_eq!(ui.transfers[0].error.as_deref(), Some("link_closed"));
    }

    #[test]
    fn las_terminadas_no_crecen_sin_limite() {
        let mut s = st();
        s.apply(
            HubEvent::Transfer(tu("viva", Direction::Out, TransferState::Active, 1)),
            1,
        );
        for i in 0..20 {
            let id = format!("f{i}");
            s.apply(
                HubEvent::Transfer(tu(&id, Direction::Out, TransferState::Failed, 0)),
                1,
            );
        }
        let t = s.snapshot(0).transfers;
        assert_eq!(t.len(), 1 + MAX_FINISHED_TRANSFERS);
        // la activa nunca se poda y se quedan las terminadas más recientes
        assert!(t.iter().any(|t| t.transfer_id == "viva"));
        assert!(t.iter().any(|t| t.transfer_id == "f19"));
        assert!(!t.iter().any(|t| t.transfer_id == "f0"));
    }

    #[test]
    fn local_clip_superseded_repetido_no_duplica() {
        let mut s = st();
        s.add_text(DIR_OUT, "A".into(), 1);
        // cada reconexión en la que gana el móvil vuelve a emitir el mismo texto local
        for i in 0..60 {
            s.apply(HubEvent::LocalClipSuperseded { text: "A".into() }, 2 + i);
        }
        let h = s.snapshot(0).history;
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].direction, "out");
    }

    #[test]
    fn local_clip_superseded_tras_el_mismo_texto_local_no_duplica() {
        let mut s = st();
        s.apply(HubEvent::LocalClipSuperseded { text: "A".into() }, 1);
        s.apply(HubEvent::LocalClipSuperseded { text: "A".into() }, 2);
        assert_eq!(s.snapshot(0).history.len(), 1);
    }

    #[test]
    fn local_clip_superseded_con_otro_texto_si_se_anade() {
        let mut s = st();
        s.add_text(DIR_OUT, "A".into(), 1);
        s.apply(HubEvent::LocalClipSuperseded { text: "B".into() }, 2);
        let h = s.snapshot(0).history;
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].direction, "local");
        assert_eq!(h[0].text.as_deref(), Some("B"));
    }

    #[test]
    fn solo_se_compara_con_el_texto_mas_reciente() {
        let mut s = st();
        s.add_text(DIR_OUT, "A".into(), 1);
        s.add_text(DIR_IN, "B".into(), 2);
        s.apply(HubEvent::LocalClipSuperseded { text: "A".into() }, 3);
        let h = s.snapshot(0).history;
        assert_eq!(h.len(), 3);
        assert_eq!(h[0].direction, "local");
    }

    #[test]
    fn local_clip_superseded_ignora_archivos_al_buscar_el_ultimo_texto() {
        let mut s = st();
        s.add_text(DIR_OUT, "A".into(), 1);
        let mut done = tu("t1", Direction::In, TransferState::Done, 100);
        done.location = Some("/d/t1.bin".into());
        s.apply(HubEvent::Transfer(done), 2);
        s.apply(HubEvent::LocalClipSuperseded { text: "A".into() }, 3);
        assert_eq!(s.snapshot(0).history.len(), 2);
    }

    #[test]
    fn texto_copiado_sin_movil_no_se_anota_como_enviado() {
        let mut s = st();
        s.add_sent_text("A".into(), 1);
        assert!(s.snapshot(0).history.is_empty());
        s.apply(connected(1, "movil"), 2);
        s.add_sent_text("B".into(), 3);
        let h = s.snapshot(0).history;
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].direction, "out");
        assert_eq!(h[0].text.as_deref(), Some("B"));
    }

    #[test]
    fn local_clip_superseded_anade_item_local() {
        let mut s = st();
        s.apply(
            HubEvent::LocalClipSuperseded {
                text: "del pc".into(),
            },
            5,
        );
        let h = &s.snapshot(0).history[0];
        assert_eq!(h.kind, "text");
        assert_eq!(h.direction, "local");
        assert_eq!(h.text.as_deref(), Some("del pc"));
    }

    #[test]
    fn clip_received_anade_item_entrante() {
        let mut s = st();
        s.apply(
            HubEvent::ClipReceived {
                session_id: 1,
                text: "del móvil".into(),
            },
            5,
        );
        let h = &s.snapshot(0).history[0];
        assert_eq!(h.direction, "in");
        assert_eq!(h.text.as_deref(), Some("del móvil"));
    }

    #[test]
    fn pares_por_session_id_y_replaced_deja_solo_la_nueva() {
        let mut s = st();
        s.apply(connected(1, "movil"), 1);
        // la nueva sesión del mismo dispositivo llega antes del cierre de la vieja
        s.apply(connected(2, "movil"), 2);
        s.apply(
            HubEvent::PeerDisconnected {
                session_id: 1,
                reason: "replaced".into(),
            },
            3,
        );
        let p = s.snapshot(0).peers;
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].session_id, 2);
        assert_eq!(p[0].device_name, "Pixel 8");
    }

    #[test]
    fn aviso_de_texto_grande_dura_5_s() {
        let mut s = st();
        s.show_clip_notice(1_000);
        assert_eq!(
            s.snapshot(1_000).clip_notice.as_deref(),
            Some(CLIP_TOO_LARGE_NOTICE)
        );
        assert_eq!(
            s.snapshot(5_999).clip_notice.as_deref(),
            Some(CLIP_TOO_LARGE_NOTICE)
        );
        assert_eq!(s.snapshot(6_000).clip_notice, None);
    }

    #[test]
    fn error_del_portapapeles_indica_si_cambio() {
        let mut s = st();
        assert!(s.set_clipboard_error(Some("sin data-control".into())));
        assert!(!s.set_clipboard_error(Some("sin data-control".into())));
        assert_eq!(
            s.snapshot(0).clipboard_error.as_deref(),
            Some("sin data-control")
        );
        assert!(s.set_clipboard_error(None));
        assert_eq!(s.snapshot(0).clipboard_error, None);
    }

    #[test]
    fn aviso_y_direccion_de_bluetooth_siguen_al_adaptador() {
        let dir = "00:1A:7D:DA:71:13".to_string();
        let mut s = st();
        // aún sin noticias del listener: ni aviso ni dirección
        assert_eq!(s.snapshot(0).bluetooth_notice, None);
        assert_eq!(s.bluetooth_address(), None);
        assert!(s.set_bluetooth(AdapterState::Unavailable));
        assert!(!s.set_bluetooth(AdapterState::Unavailable));
        assert_eq!(s.snapshot(0).bluetooth_notice.as_deref(), Some("Este PC no tiene Bluetooth"));
        assert_eq!(s.bluetooth_address(), None);
        assert!(s.set_bluetooth(AdapterState::Off { address: dir.clone() }));
        assert_eq!(s.snapshot(0).bluetooth_notice.as_deref(), Some("Bluetooth apagado"));
        assert_eq!(s.bluetooth_address().as_deref(), Some("00:1A:7D:DA:71:13"));
        assert!(s.set_bluetooth(AdapterState::On { address: dir }));
        assert_eq!(s.snapshot(0).bluetooth_notice, None);
        assert_eq!(s.bluetooth_address().as_deref(), Some("00:1A:7D:DA:71:13"));
    }

    #[test]
    fn avisos_de_arranque_se_acumulan_sin_repetirse() {
        let mut s = st();
        s.add_server_error(PAIRED_LOAD_ERROR);
        assert_eq!(s.snapshot(0).server_error.as_deref(), Some(PAIRED_LOAD_ERROR));
        s.add_server_error(IDENTITY_NOT_SAVED_ERROR);
        s.add_server_error(PAIRED_LOAD_ERROR);
        assert_eq!(
            s.snapshot(0).server_error,
            Some(format!("{PAIRED_LOAD_ERROR} {IDENTITY_NOT_SAVED_ERROR}"))
        );
    }

    #[test]
    fn error_del_servidor_se_muestra_en_el_estado() {
        let mut s = st();
        assert_eq!(s.snapshot(0).server_error, None);
        s.add_server_error(SERVER_PORT_ERROR);
        let v = serde_json::to_value(s.snapshot(0)).unwrap();
        assert_eq!(
            v["serverError"],
            "No se pudo abrir el puerto 52847: puede que otra copia de ClipSync esté abierta"
        );
    }

    #[test]
    fn clasifica_texto_local() {
        assert_eq!(classify_local_clip(""), LocalClip::Blank);
        assert_eq!(classify_local_clip(" \n\t"), LocalClip::Blank);
        assert_eq!(classify_local_clip("hola"), LocalClip::Send);
        assert_eq!(
            classify_local_clip(&"a".repeat(MAX_CLIP_BYTES)),
            LocalClip::Send
        );
        assert_eq!(
            classify_local_clip(&"a".repeat(MAX_CLIP_BYTES + 1)),
            LocalClip::TooLarge
        );
        // menos de 1 MiB, pero cada U+0001 ocupa 6 bytes en JSON: el mensaje pasa de 2 MiB
        assert_eq!(
            classify_local_clip(&"\u{1}".repeat(400_000)),
            LocalClip::TooLarge
        );
    }

    #[test]
    fn ui_state_se_serializa_en_camel_case_con_null() {
        let mut s = st();
        s.apply(connected(1, "movil"), 1);
        s.add_text(DIR_OUT, "x".into(), 2);
        let v = serde_json::to_value(s.snapshot(0)).unwrap();
        assert_eq!(v["pcName"], "mi-pc");
        assert_eq!(v["peers"][0]["sessionId"], 1);
        assert_eq!(v["peers"][0]["deviceName"], "Pixel 8");
        assert_eq!(v["peers"][0]["transport"], "wifi");
        assert_eq!(v["history"][0]["atMs"], 2);
        assert!(v["history"][0]["fileName"].is_null());
        assert!(v["clipboardError"].is_null());
        assert!(v["clipNotice"].is_null());
        assert!(v["serverError"].is_null());
        assert!(v["transfers"].as_array().unwrap().is_empty());
    }

    fn dispositivo(key: &str, nombre: &str, at: u64) -> PairedDevice {
        PairedDevice {
            public_key: key.into(),
            device_id: format!("id-{key}"),
            device_name: nombre.into(),
            paired_at_ms: at,
        }
    }

    fn oferta(expires_at_ms: u64) -> PairingView {
        PairingView {
            qr_svg: "<svg/>".into(),
            expires_at_ms,
        }
    }

    fn emparejado(key: &str, nombre: &str) -> HubEvent {
        HubEvent::DevicePaired {
            device_key: key.into(),
            device_name: nombre.into(),
        }
    }

    #[test]
    fn device_paired_cierra_el_qr_y_pone_el_aviso() {
        let mut s = st();
        s.set_pairing(Some(oferta(400_000)));
        assert!(s.snapshot(1_000).pairing.is_some());
        s.apply(emparejado("aa", "Pixel 8"), 1_000);
        let ui = s.snapshot(1_000);
        assert!(ui.pairing.is_none());
        assert_eq!(ui.pair_notice.as_deref(), Some("«Pixel 8» emparejado"));
    }

    #[test]
    fn el_aviso_de_emparejado_desaparece_a_los_5_s() {
        let mut s = st();
        s.apply(emparejado("aa", "Pixel 8"), 1_000);
        assert!(s.snapshot(5_999).pair_notice.is_some());
        assert_eq!(s.snapshot(6_000).pair_notice, None);
        assert_eq!(PAIR_NOTICE_MS, 5_000);
    }

    #[test]
    fn snapshot_omite_el_qr_caducado() {
        let mut s = st();
        s.set_pairing(Some(oferta(10_000)));
        let ui = s.snapshot(9_999);
        assert_eq!(ui.pairing.map(|p| p.expires_at_ms), Some(10_000));
        assert!(s.snapshot(10_000).pairing.is_none());
        assert!(s.snapshot(20_000).pairing.is_none());
        s.set_pairing(None);
        assert!(s.snapshot(0).pairing.is_none());
    }

    #[test]
    fn connected_refleja_los_peers() {
        let mut s = st();
        s.set_paired(vec![dispositivo("aa", "Pixel 8", 1), dispositivo("bb", "Moto", 2)]);
        let p = s.snapshot(0).paired;
        assert_eq!(p.len(), 2);
        assert!(p.iter().all(|d| !d.connected));
        s.apply(connected(1, "bb"), 5);
        let p = s.snapshot(0).paired;
        assert_eq!(p[0].device_key, "aa");
        assert!(!p[0].connected);
        assert_eq!(p[1].device_key, "bb");
        assert_eq!(p[1].device_name, "Moto");
        assert_eq!(p[1].paired_at_ms, 2);
        assert!(p[1].connected);
        s.apply(
            HubEvent::PeerDisconnected {
                session_id: 1,
                reason: "link_closed".into(),
            },
            6,
        );
        assert!(s.snapshot(0).paired.iter().all(|d| !d.connected));
    }

    #[test]
    fn olvidar_un_movil_quita_el_peer_y_deja_de_estar_conectado() {
        let mut s = st();
        s.set_paired(vec![dispositivo("aa", "Pixel 8", 1)]);
        s.apply(connected(7, "aa"), 1);
        assert!(s.snapshot(1).paired[0].connected);
        // el Hub cierra la sesión con «forgotten» y la app recarga la lista
        s.apply(
            HubEvent::PeerDisconnected {
                session_id: 7,
                reason: "forgotten".into(),
            },
            2,
        );
        s.set_paired(Vec::new());
        let ui = s.snapshot(2);
        assert!(ui.peers.is_empty());
        assert!(ui.paired.is_empty());
    }

    #[test]
    fn ui_state_serializa_el_emparejamiento_en_camel_case() {
        let mut s = st();
        s.set_paired(vec![dispositivo("aa", "Pixel 8", 3)]);
        s.set_pairing(Some(oferta(99)));
        let v = serde_json::to_value(s.snapshot(0)).unwrap();
        assert_eq!(v["paired"][0]["deviceKey"], "aa");
        assert_eq!(v["paired"][0]["deviceName"], "Pixel 8");
        assert_eq!(v["paired"][0]["pairedAtMs"], 3);
        assert_eq!(v["paired"][0]["connected"], false);
        assert_eq!(v["pairing"]["qrSvg"], "<svg/>");
        assert_eq!(v["pairing"]["expiresAtMs"], 99);
        assert!(v["pairNotice"].is_null());
        let vacio = serde_json::to_value(st().snapshot(0)).unwrap();
        assert!(vacio["pairing"].is_null());
        assert!(vacio["paired"].as_array().unwrap().is_empty());
    }

    // --- imágenes ---

    fn png(n: u32) -> PathBuf {
        PathBuf::from(format!("/cache/images/{n:064x}.png"))
    }

    #[test]
    fn imagen_enviada_va_al_historial_con_miniatura() {
        let mut s = st();
        s.apply(connected(1, "movil"), 1);
        s.add_sent_image(png(1), Some("data:image/jpeg;base64,AAAA".into()), 9);
        let ui = s.snapshot(0);
        let h = &ui.history[0];
        assert_eq!(h.kind, "image");
        assert_eq!(h.direction, "out");
        assert_eq!(h.thumbnail.as_deref(), Some("data:image/jpeg;base64,AAAA"));
        assert_eq!(h.text, None);
        assert_eq!(h.location, None);
        assert_eq!(h.at_ms, 9);
        assert_eq!(s.image_path(h.id), Some(png(1)));
        let v = serde_json::to_value(&ui).unwrap();
        assert_eq!(v["history"][0]["kind"], "image");
        assert_eq!(v["history"][0]["thumbnail"], "data:image/jpeg;base64,AAAA");
    }

    #[test]
    fn imagen_copiada_sin_movil_no_se_anota() {
        let mut s = st();
        s.add_sent_image(png(1), Some("data:image/jpeg;base64,AAAA".into()), 1);
        assert!(s.snapshot(0).history.is_empty());
        // su PNG no queda referenciado por el historial
        assert!(!s.image_in_use(&png(1)));
    }

    #[test]
    fn imagen_recibida_va_al_historial_con_su_ubicacion() {
        let mut s = st();
        s.add_received_image(
            png(2),
            Some("data:image/jpeg;base64,BBBB".into()),
            "/home/u/Imágenes/ClipSync/foto.jpg".into(),
            4,
        );
        let h = &s.snapshot(0).history[0];
        assert_eq!(h.kind, "image");
        assert_eq!(h.direction, "in");
        assert_eq!(h.file_name.as_deref(), Some("foto.jpg"));
        assert_eq!(h.location.as_deref(), Some("/home/u/Imágenes/ClipSync/foto.jpg"));
        assert_eq!(s.image_path(h.id), Some(png(2)));
    }

    #[test]
    fn imagen_recibida_que_no_se_pudo_poner_queda_como_archivo() {
        let mut s = st();
        s.add_received_file("/home/u/Imágenes/ClipSync/rota.png".into(), 4);
        let h = &s.snapshot(0).history[0];
        assert_eq!(h.kind, "file");
        assert_eq!(h.direction, "in");
        assert_eq!(h.file_name.as_deref(), Some("rota.png"));
        assert_eq!(h.location.as_deref(), Some("/home/u/Imágenes/ClipSync/rota.png"));
        assert_eq!(h.thumbnail, None);
        assert_eq!(s.image_path(h.id), None);
    }

    #[test]
    fn items_que_no_son_imagen_llevan_thumbnail_null() {
        let mut s = st();
        s.add_text(DIR_OUT, "x".into(), 1);
        let v = serde_json::to_value(s.snapshot(0)).unwrap();
        assert!(v["history"][0]["thumbnail"].is_null());
        assert_eq!(s.image_path(v["history"][0]["id"].as_u64().unwrap()), None);
        assert_eq!(s.image_path(999), None);
    }

    #[test]
    fn transferencias_de_portapapeles_terminadas_no_anaden_archivo() {
        let mut s = st();
        for (id, dir) in [("i", Direction::In), ("o", Direction::Out)] {
            let mut done = tu(id, dir, TransferState::Done, 100);
            done.purpose = Some("clipboard".into());
            done.location = Some("/home/u/Imágenes/ClipSync/a.png".into());
            s.apply(HubEvent::Transfer(done), 2);
        }
        let ui = s.snapshot(0);
        assert!(ui.history.is_empty());
        assert!(ui.transfers.is_empty());
        // la imagen la anota el hilo del portapapeles tras ponerla
        s.apply(
            HubEvent::ClipImageReceived {
                session_id: 1,
                location: "/home/u/Imágenes/ClipSync/a.png".into(),
            },
            3,
        );
        assert!(s.snapshot(0).history.is_empty());
    }

    #[test]
    fn historial_con_imagenes_limitado_a_50_y_poda_sus_png() {
        let mut s = st();
        s.apply(connected(1, "movil"), 1);
        for i in 1..=51 {
            s.add_sent_image(png(i), Some(format!("data:image/jpeg;base64,{i}")), i as u64);
        }
        let h = s.snapshot(0).history;
        assert_eq!(h.len(), 50);
        assert_eq!(h[49].thumbnail.as_deref(), Some("data:image/jpeg;base64,2"));
        assert_eq!(s.take_trash(), vec![png(1)]);
        assert!(s.take_trash().is_empty());
        assert!(!s.image_in_use(&png(1)));
        assert!(s.image_in_use(&png(2)));
        // un archivo o un texto también expulsa a la imagen más antigua
        s.add_text(DIR_OUT, "t".into(), 60);
        assert_eq!(s.take_trash(), vec![png(2)]);
    }

    #[test]
    fn un_png_compartido_sigue_en_uso_aunque_se_pode_un_item() {
        let mut s = st();
        s.apply(connected(1, "movil"), 1);
        s.add_sent_image(png(1), Some("data:image/jpeg;base64,A".into()), 1);
        for i in 0..49 {
            s.add_text(DIR_OUT, i.to_string(), 2);
        }
        // la misma imagen copiada otra vez
        s.add_sent_image(png(1), Some("data:image/jpeg;base64,A".into()), 3);
        assert_eq!(s.take_trash(), vec![png(1)]);
        // quien borra comprueba antes si sigue en uso
        assert!(s.image_in_use(&png(1)));
    }

    #[test]
    fn los_borrados_fallidos_se_reintentan_en_la_siguiente_poda() {
        let mut s = st();
        s.apply(connected(1, "movil"), 1);
        for i in 1..=51 {
            s.add_sent_image(png(i), Some("data:image/jpeg;base64,A".into()), 1);
        }
        let fallidos = s.take_trash();
        s.retry_later(fallidos);
        // no se reintenta en cada sondeo, solo al podar de nuevo
        assert!(s.take_trash().is_empty());
        s.add_sent_image(png(52), Some("data:image/jpeg;base64,A".into()), 2);
        assert_eq!(s.take_trash(), vec![png(2), png(1)]);
    }

    #[test]
    fn descartar_un_png_lo_manda_a_la_papelera_con_los_pendientes() {
        let mut s = st();
        s.retry_later(vec![png(7)]);
        s.discard_image(png(8));
        assert_eq!(s.take_trash(), vec![png(8), png(7)]);
    }

    #[test]
    fn avisos_de_imagen_usan_clip_notice_5_s() {
        let mut s = st();
        s.show_notice(IMAGE_TOO_LARGE_NOTICE, 1_000);
        assert_eq!(
            s.snapshot(5_999).clip_notice.as_deref(),
            Some("Imagen demasiado grande para sincronizar (máx. 20 MB)")
        );
        assert_eq!(s.snapshot(6_000).clip_notice, None);
        s.show_notice(IMAGE_WRITE_ERROR, 7_000);
        assert_eq!(
            s.snapshot(7_000).clip_notice.as_deref(),
            Some("No se pudo poner la imagen en el portapapeles")
        );
        // el de texto sigue igual
        s.show_clip_notice(8_000);
        assert_eq!(
            s.snapshot(8_000).clip_notice.as_deref(),
            Some(CLIP_TOO_LARGE_NOTICE)
        );
    }
}
