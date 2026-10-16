//! Lógica de núcleo independiente de la red: anti-rebote del portapapeles, recepción segura
//! de archivos en disco, y la sesión y el Hub del protocolo v2 (rol servidor).

mod clip_sync;
mod files;
mod hub;
mod session;

pub use clip_sync::{ClipDecision, ClipboardSync};
pub use files::{sanitize_file_name, unique_path, FileReceiver};
pub use hub::{Hub, HubConfig, HubEvent};
pub use session::{Direction, TransferState, TransferUpdate, Transport};
