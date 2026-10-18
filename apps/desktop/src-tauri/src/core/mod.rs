//! Lógica de núcleo independiente de la red: anti-rebote del portapapeles, recepción segura
//! de archivos en disco, la sesión y el Hub del protocolo v2 (rol servidor), y la identidad
//! del PC con el emparejamiento por QR.

mod clip_sync;
mod files;
mod hub;
mod image_sync;
mod session;

pub mod identity;
pub mod pairing;

pub use clip_sync::{ClipDecision, ClipboardSync};
pub use files::{sanitize_file_name, unique_path, FileReceiver};
pub use hub::{Hub, HubConfig, HubEvent, LocalImage};
pub use session::{Direction, TransferState, TransferUpdate, Transport};
