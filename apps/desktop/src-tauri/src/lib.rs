mod bluetooth;
mod discovery;
mod protocol;
mod transport;
mod usb;

use protocol::DEFAULT_TCP_PORT;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|_app| {
            // El ServiceDaemon debe seguir vivo mientras la app corra; Box::leak lo mantiene
            // anunciado hasta que el proceso termine (en Fase 2 no hay un ciclo de vida más
            // fino que gestionar).
            match discovery::advertise(DEFAULT_TCP_PORT) {
                Ok(daemon) => {
                    Box::leak(Box::new(daemon));
                }
                Err(err) => println!("[mDNS] No se pudo anunciar el servicio: {err}"),
            }

            tauri::async_runtime::spawn(async move {
                if let Err(err) = transport::run_server(DEFAULT_TCP_PORT).await {
                    println!("[TCP] El servidor terminó con error: {err}");
                }
            });

            // Sondeo periódico en background: detecta un móvil por USB y establece
            // `adb reverse` para P2P y Modo Invitado. Si `adb` no está instalado, el
            // watcher lo loguea una vez y sigue reintentando sin tumbar la app.
            usb::spawn_reverse_tunnel_watcher();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
