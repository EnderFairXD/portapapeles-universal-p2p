//! Fase 3 (USB / túnel ADB). El túnel USB no es un transporte nuevo: es una tubería para
//! el mismo `LanTransport` (TCP) — ver docs/architecture.md §4. Este módulo cubre las dos
//! piezas que sí son nuevas: detectar el móvil por cable y establecer el túnel.
//!
//! Invoca el binario `adb` del sistema vía `tokio::process::Command` (async, no bloquea
//! el runtime de Tauri), en vez de un cliente ADB puro en Rust (se evaluó
//! `adb_client`/`rsadb`, ver conversación de la Fase 3) — es la vía más simple para
//! arrancar sin depender de reimplementar el protocolo ADB. Si el binario del sistema
//! resulta poco fiable en algún entorno, migrar a un crate puro es el siguiente paso
//! natural sin tocar el resto de LanTransport.
//!
//! Enlazado a `lib.rs`: `spawn_reverse_tunnel_watcher()` corre en background desde
//! `setup()`, sondeando cada POLL_INTERVAL por un dispositivo autorizado y
//! (re)estableciendo `adb reverse` para los dos puertos del sistema. `adb reverse` es
//! idempotente — repetirlo con la misma pareja de puertos no rompe nada — así que un
//! sondeo simple es suficiente sin necesitar detectar hotplug de verdad.

use std::time::Duration;

use tokio::process::Command;
use tokio::time::sleep;

use crate::protocol::{DEFAULT_TCP_PORT, GUEST_MODE_PORT};

const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Los dos puertos que ClipSync necesita re-exponer por USB: LanTransport (P2P) y el
/// servidor del Modo Invitado.
pub const REVERSE_PORTS: [u16; 2] = [DEFAULT_TCP_PORT, GUEST_MODE_PORT];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbDevice {
    pub serial: String,
}

/// Lista los dispositivos Android conectados por USB en estado "device" (autorizados y
/// listos). Ignora "unauthorized" (el usuario no aceptó el diálogo de depuración todavía)
/// y "offline".
pub async fn list_devices() -> Result<Vec<UsbDevice>, String> {
    let output = Command::new("adb")
        .arg("devices")
        .output()
        .await
        .map_err(|e| format!("no se pudo ejecutar `adb` (¿está instalado y en PATH?): {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "`adb devices` terminó con error: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(parse_adb_devices_output(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_adb_devices_output(stdout: &str) -> Vec<UsbDevice> {
    stdout
        .lines()
        .skip(1) // primera línea: "List of devices attached"
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?;
            let state = parts.next()?;
            (state == "device").then(|| UsbDevice {
                serial: serial.to_string(),
            })
        })
        .collect()
}

/// Establece `adb reverse tcp:<port> tcp:<port>`: cuando el móvil conecte a
/// `127.0.0.1:<port>` (desde su propio punto de vista), ADB reenvía esa conexión al
/// puerto `<port>` de este PC.
///
/// Es `reverse`, no `forward`: el servidor TCP vive en el PC y el móvil es quien inicia
/// la conexión, exactamente igual que en LAN — `reverse` reenvía conexiones que arrancan
/// *en el dispositivo* hacia el host; `forward` es lo contrario (para cuando el servidor
/// vive en el móvil, que no es nuestro caso).
pub async fn establish_reverse_tunnel(device: &UsbDevice, port: u16) -> Result<(), String> {
    let spec = format!("tcp:{port}");
    let output = Command::new("adb")
        .args(["-s", &device.serial, "reverse", &spec, &spec])
        .output()
        .await
        .map_err(|e| format!("no se pudo ejecutar `adb reverse`: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "`adb reverse` falló para {} en el puerto {port}: {}",
            device.serial,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Establece el túnel reverse para todos los REVERSE_PORTS. Devuelve el resultado de
/// cada puerto por separado — un fallo en uno no impide intentar los demás.
pub async fn establish_all_reverse_tunnels(device: &UsbDevice) -> Vec<(u16, Result<(), String>)> {
    let mut results = Vec::with_capacity(REVERSE_PORTS.len());
    for port in REVERSE_PORTS {
        results.push((port, establish_reverse_tunnel(device, port).await));
    }
    results
}

/// Quita un túnel — pensado para cuando se desconecta el cable o se cierra la app, para
/// no dejar reversos huérfanos registrados en el dispositivo. Todavía no se llama desde
/// ningún sitio (no hay hook de desconexión implementado), queda listo para cuando lo haya.
#[allow(dead_code)]
pub async fn remove_reverse_tunnel(device: &UsbDevice, port: u16) -> Result<(), String> {
    let spec = format!("tcp:{port}");
    let output = Command::new("adb")
        .args(["-s", &device.serial, "reverse", "--remove", &spec])
        .output()
        .await
        .map_err(|e| format!("no se pudo ejecutar `adb reverse --remove`: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "`adb reverse --remove` falló para {}: {}",
            device.serial,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Arranca el sondeo periódico en background (llamar una vez desde `setup()`). Nunca
/// hace panic ni bloquea el arranque de la app: cualquier fallo (adb ausente, sin
/// dispositivo, comando no autorizado) se loguea y se reintenta en el siguiente ciclo.
/// Dedupea logs repetidos — sin esto, un `adb` ausente imprimiría el mismo error cada
/// POLL_INTERVAL para siempre.
pub fn spawn_reverse_tunnel_watcher() {
    tauri::async_runtime::spawn(async move {
        let mut last_tunneled_serial: Option<String> = None;
        let mut last_list_error: Option<String> = None;

        loop {
            match list_devices().await {
                Ok(devices) => {
                    last_list_error = None;

                    match devices.first() {
                        Some(device) => {
                            let is_new = last_tunneled_serial.as_deref() != Some(device.serial.as_str());
                            if is_new {
                                println!("[USB] Dispositivo detectado: {} — estableciendo túneles reverse", device.serial);
                            }

                            let results = establish_all_reverse_tunnels(device).await;
                            let mut all_ok = true;
                            for (port, result) in &results {
                                if let Err(err) = result {
                                    all_ok = false;
                                    println!("[USB] No se pudo establecer el túnel en el puerto {port}: {err}");
                                }
                            }

                            if all_ok {
                                if is_new {
                                    println!(
                                        "[USB] Túneles activos: 127.0.0.1:{DEFAULT_TCP_PORT} (P2P) y 127.0.0.1:{GUEST_MODE_PORT} (Modo Invitado)"
                                    );
                                }
                                last_tunneled_serial = Some(device.serial.clone());
                            } else {
                                last_tunneled_serial = None;
                            }
                        }
                        None => last_tunneled_serial = None,
                    }
                }
                Err(err) => {
                    // Lo más común: `adb` no está instalado o no está en PATH — no es
                    // fatal, USB simplemente no está disponible en esta máquina.
                    if last_list_error.as_deref() != Some(err.as_str()) {
                        println!("[USB] {err}");
                        last_list_error = Some(err);
                    }
                    last_tunneled_serial = None;
                }
            }

            sleep(POLL_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_authorized_devices() {
        let sample = "List of devices attached\nABC123\tdevice\nXYZ999\tunauthorized\nQWE111\toffline\n\n";
        let devices = parse_adb_devices_output(sample);

        assert_eq!(devices, vec![UsbDevice { serial: "ABC123".to_string() }]);
    }

    #[test]
    fn returns_empty_when_no_devices_attached() {
        let sample = "List of devices attached\n\n";
        assert!(parse_adb_devices_output(sample).is_empty());
    }

    #[test]
    fn reverse_ports_cover_p2p_and_guest_mode() {
        assert!(REVERSE_PORTS.contains(&DEFAULT_TCP_PORT));
        assert!(REVERSE_PORTS.contains(&GUEST_MODE_PORT));
        assert_ne!(DEFAULT_TCP_PORT, GUEST_MODE_PORT);
    }
}
