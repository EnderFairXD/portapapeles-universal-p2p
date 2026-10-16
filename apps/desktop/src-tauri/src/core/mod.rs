//! Lógica de núcleo independiente de la red: anti-rebote del portapapeles y
//! recepción segura de archivos en disco.

mod clip_sync;
mod files;

// TODO(Tarea 8): quitar los allow cuando el Hub use el módulo
#[allow(unused_imports)]
pub use clip_sync::{ClipDecision, ClipboardSync};
#[allow(unused_imports)]
pub use files::{sanitize_file_name, unique_path, FileReceiver};
