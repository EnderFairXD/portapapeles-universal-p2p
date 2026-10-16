//! Estado de la interfaz del PC: pares, historial y transferencias, a partir de los `HubEvent`.
//! La parte pura (`AppState`) no depende de Tauri; el cableado está en `lib.rs`.

pub mod clipboard;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Notify};

use clipboard::ClipboardHandle;

use crate::core::{
    ClipDecision, ClipboardSync, Direction, Hub, HubEvent, TransferState, TransferUpdate, Transport,
};
use crate::protocol::{encode_control, ControlMessage, MAX_HISTORY};

pub const CLIP_TOO_LARGE_NOTICE: &str = "Texto demasiado grande para sincronizar (máx. 1 MB)";
pub const CLIP_NOTICE_MS: u64 = 5_000;

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

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: u64,
    pub kind: String,
    pub direction: String,
    pub text: Option<String>,
    pub file_name: Option<String>,
    pub location: Option<String>,
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
    clip_notice_until: Option<u64>,
    next_id: u64,
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
            clip_notice_until: None,
            next_id: 1,
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
            HubEvent::LocalClipSuperseded { text } => self.add_text(DIR_LOCAL, text, now_ms),
            HubEvent::Transfer(u) => self.on_transfer(u, now_ms),
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
        self.history.truncate(MAX_HISTORY);
    }

    pub fn add_text(&mut self, direction: &str, text: String, now_ms: u64) {
        self.push(HistoryItem {
            id: 0,
            kind: "text".into(),
            direction: direction.into(),
            text: Some(text),
            file_name: None,
            location: None,
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

    pub fn show_clip_notice(&mut self, now_ms: u64) {
        self.clip_notice_until = Some(now_ms.saturating_add(CLIP_NOTICE_MS));
    }

    pub fn snapshot(&self, now_ms: u64) -> UiState {
        let notice = self.clip_notice_until.is_some_and(|until| now_ms < until);
        UiState {
            pc_name: self.pc_name.clone(),
            peers: self.peers.clone(),
            history: self.history.iter().cloned().collect(),
            transfers: self.transfers.clone(),
            clipboard_error: self.clipboard_error.clone(),
            clip_notice: notice.then(|| CLIP_TOO_LARGE_NOTICE.to_string()),
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
/// Orden de bloqueo: `state` antes que el Hub, nunca al revés.
pub struct Ctx {
    hub: Hub,
    state: Mutex<AppState>,
    /// texto local que el Hub ofrece a las sesiones nuevas; se actualiza antes de cada broadcast
    local_clip: Arc<Mutex<Option<String>>>,
    clipboard: ClipboardHandle,
    changed: Arc<Notify>,
}

impl Ctx {
    pub fn new(
        hub: Hub,
        pc_name: String,
        local_clip: Arc<Mutex<Option<String>>>,
        clipboard: ClipboardHandle,
    ) -> Self {
        Self {
            hub,
            state: Mutex::new(AppState::new(pc_name)),
            local_clip,
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

    pub fn set_clipboard_error(&self, error: Option<String>) {
        if !lock(&self.state).set_clipboard_error(error.clone()) {
            return;
        }
        if let Some(e) = error {
            let _ = writeln!(std::io::stderr(), "[Portapapeles] {e}");
        }
        self.notify();
    }

    /// Texto nuevo en el portapapeles del PC (desde el hilo del portapapeles).
    pub fn on_local_text(&self, text: String) {
        match classify_local_clip(&text) {
            LocalClip::Blank => self.set_local(None),
            LocalClip::TooLarge => {
                // no se envía, ni ahora ni a las sesiones que lleguen después
                self.set_local(None);
                lock(&self.state).show_clip_notice(now_ms());
                self.notify();
                let changed = self.changed.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(CLIP_NOTICE_MS + 50)).await;
                    changed.notify_one();
                });
            }
            LocalClip::Send => {
                self.set_local(Some(text.clone()));
                self.hub.broadcast_clip(&text);
                lock(&self.state).add_text(DIR_OUT, text, now_ms());
                self.notify();
            }
        }
    }

    /// Consume los eventos del Hub mientras la app viva.
    pub async fn run_events(self: Arc<Self>, mut events: mpsc::UnboundedReceiver<HubEvent>) {
        while let Some(ev) = events.recv().await {
            if let HubEvent::ClipReceived { text, .. } = &ev {
                self.clipboard.write(text.clone());
            }
            lock(&self.state).apply(ev, now_ms());
            self.notify();
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

/// Copia un texto del historial al portapapeles sin reenviarlo a los móviles.
#[tauri::command]
pub async fn copy_text(text: String, state: State<'_, Arc<Ctx>>) -> Result<(), String> {
    state.clipboard.write_and_wait(text).await
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
        assert!(v["transfers"].as_array().unwrap().is_empty());
    }
}
