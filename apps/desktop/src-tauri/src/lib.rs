// Público para que el ejemplo `headless` (Tarea 9) y la app usen el Hub.
pub mod core;
mod app;
mod discovery;
mod listeners;
mod protocol;
mod usb;

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Manager;

use app::Ctx;
use core::pairing::{fingerprint, PairedStore};
use core::{identity, Hub, HubConfig, LocalImage};
use protocol::DEFAULT_TCP_PORT;

fn log(msg: &str) {
    // writeln no hace panic si stderr no está disponible (panic = "abort")
    let _ = writeln!(std::io::stderr(), "{msg}");
}

/// UUID guardado en `app_data_dir/device_id`; si no se puede guardar, vale para esta ejecución.
fn load_device_id(dir: Option<&Path>) -> String {
    let Some(dir) = dir else {
        log("[App] sin carpeta de datos: device_id temporal");
        return uuid::Uuid::new_v4().to_string();
    };
    let path = dir.join("device_id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(id) = uuid::Uuid::parse_str(s.trim()) {
            return id.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    if let Err(e) = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&path, &id)) {
        log(&format!(
            "[App] no se pudo guardar {}: {e}",
            path.display()
        ));
    }
    id
}

fn pc_name() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "PC".to_string())
}

fn download_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Imágenes recibidas para el portapapeles: `~/Imágenes/ClipSync` (o `Descargas/ClipSync`).
fn image_dir() -> PathBuf {
    dirs::picture_dir()
        .unwrap_or_else(download_dir)
        .join("ClipSync")
}

async fn serve(hub: Hub, ctx: Arc<Ctx>) {
    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_TCP_PORT));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            log(&format!("[TCP] Escuchando en {addr}"));
            hub.serve_tcp(listener).await;
        }
        Err(e) => {
            log(&format!("[TCP] No se pudo escuchar en {addr}: {e}"));
            ctx.add_server_error(app::SERVER_PORT_ERROR);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app::get_state,
            app::send_files,
            app::cancel_transfer,
            app::copy_text,
            app::copy_image,
            app::start_pairing,
            app::cancel_pairing,
            app::forget_device
        ])
        .setup(|tauri_app| {
            let data_dir = tauri_app.path().app_data_dir().ok();
            let local_clip = Arc::new(Mutex::new(None::<String>));
            let local_read = local_clip.clone();
            let local_image = Arc::new(Mutex::new(None::<LocalImage>));
            let image_read = local_image.clone();
            // PNG de las imágenes copiadas o recibidas (uno por imagen, podados con el historial)
            let images_cache = tauri_app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("clipsync"))
                .join("images");
            let pc_name = pc_name();
            let (keys, identity_saved) = identity::load_or_create_status(data_dir.as_deref());
            let (hub, events) = Hub::new(HubConfig {
                device_id: load_device_id(data_dir.as_deref()),
                pc_name: pc_name.clone(),
                download_dir: download_dir(),
                image_dir: image_dir(),
                // como el texto: la copia en memoria, sin tocar arboard
                local_image: Arc::new(move || match image_read.lock() {
                    Ok(g) => g.clone(),
                    Err(p) => p.into_inner().clone(),
                }),
                // solo lee la copia en memoria: nunca toca arboard
                local_clip: Arc::new(move || match local_read.lock() {
                    Ok(g) => g.clone(),
                    Err(p) => p.into_inner().clone(),
                }),
                keys,
                paired: PairedStore::load(data_dir.as_ref().map(|d| d.join("paired.json"))),
            });
            let (clipboard, clipboard_worker) = app::clipboard::channel();
            let fp = fingerprint(&hub.public_key());
            let ctx = Arc::new(Ctx::new(
                hub.clone(),
                pc_name,
                local_clip,
                local_image,
                clipboard,
            ));
            if !identity_saved {
                ctx.add_server_error(app::IDENTITY_NOT_SAVED_ERROR);
            }
            if hub.paired_load_failed() {
                ctx.add_server_error(app::PAIRED_LOAD_ERROR);
            }
            tauri_app.manage(ctx.clone());

            tauri::async_runtime::spawn(ctx.clone().run_emitter(tauri_app.handle().clone()));
            tauri::async_runtime::spawn(ctx.clone().run_events(events));
            tauri::async_runtime::spawn(serve(hub.clone(), ctx.clone()));
            // RFCOMM (Bluetooth): sin adaptador o con BlueZ apagado no hace nada salvo avisar y
            // reintentar cada 30 s; nunca bloquea el arranque
            tauri::async_runtime::spawn(listeners::run(hub, {
                let ctx = ctx.clone();
                Arc::new(move |estado| ctx.set_bluetooth(estado))
            }));

            // El ServiceDaemon debe seguir vivo mientras la app corra; Box::leak lo mantiene
            // anunciado hasta que el proceso termine.
            match discovery::advertise(DEFAULT_TCP_PORT, &fp) {
                Ok(daemon) => {
                    Box::leak(Box::new(daemon));
                }
                Err(err) => log(&format!("[mDNS] No se pudo anunciar el servicio: {err}")),
            }

            // Sondeo periódico en background: detecta un móvil por USB y establece
            // `adb reverse` de la sesión. Si `adb` no está instalado, el
            // watcher lo loguea una vez y sigue reintentando sin tumbar la app.
            usb::spawn_reverse_tunnel_watcher();

            clipboard_worker.spawn(ctx, images_cache);
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        log(&format!("[App] Error al ejecutar la aplicación: {e}"));
    }
}
