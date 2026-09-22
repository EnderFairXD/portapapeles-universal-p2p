//! Fase 3 (USB / túnel ADB). El túnel USB no es un transporte nuevo: es una tubería para
//! el mismo `LanTransport` (TCP) — ver docs/architecture.md §4. Este módulo cubre las dos
//! piezas que sí son nuevas: detectar el móvil por cable y establecer el túnel.
//!
//! Scaffold: invoca el binario `adb` del sistema vía `std::process::Command`, en vez de
//! un cliente ADB puro en Rust (se evaluó `adb_client`/`rsadb`, ver conversación de la
//! Fase 3) — es la vía más simple para arrancar sin depender de reimplementar el
//! protocolo ADB. Si el binario del sistema resulta poco fiable en algún entorno
//! (no está en PATH, versión vieja del SDK...), migrar a un crate puro es el siguiente
//! paso natural sin tocar el resto de LanTransport.
//!
//! Nada de este módulo se llama desde `lib.rs` todavía — no hay UI ni triaje que lo
//! dispare. `#![allow(dead_code)]` evita el ruido de warnings hasta que se enlace.
#![allow(dead_code)]

use std::process::Command;

use crate::protocol::DEFAULT_TCP_PORT;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsbDevice {
    pub serial: String,
}

/// Lista los dispositivos Android conectados por USB en estado "device" (autorizados y
/// listos). Ignora "unauthorized" (el usuario no aceptó el diálogo de depuración todavía)
/// y "offline".
pub fn list_devices() -> Result<Vec<UsbDevice>, String> {
    let output = Command::new("adb")
        .arg("devices")
        .output()
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
/// puerto `<port>` de este PC — el mismo que ya escucha `transport::run_server`.
///
/// Es `reverse`, no `forward`: el servidor TCP vive en el PC y el móvil es quien inicia
/// la conexión, exactamente igual que en LAN — `reverse` reenvía conexiones que arrancan
/// *en el dispositivo* hacia el host; `forward` es lo contrario (para cuando el servidor
/// vive en el móvil, que no es nuestro caso).
pub fn establish_reverse_tunnel(device: &UsbDevice, port: u16) -> Result<(), String> {
    let spec = format!("tcp:{port}");
    let output = Command::new("adb")
        .args(["-s", &device.serial, "reverse", &spec, &spec])
        .output()
        .map_err(|e| format!("no se pudo ejecutar `adb reverse`: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "`adb reverse` falló para {}: {}",
            device.serial,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    println!("[USB] Túnel reverse establecido con {} en el puerto {port}", device.serial);
    Ok(())
}

/// Atajo para el puerto por defecto de LanTransport (52847).
pub fn establish_default_reverse_tunnel(device: &UsbDevice) -> Result<(), String> {
    establish_reverse_tunnel(device, DEFAULT_TCP_PORT)
}

/// Quita el túnel — llamar al desconectar el cable o cerrar la app, para no dejar
/// reversos huérfanos registrados en el dispositivo.
pub fn remove_reverse_tunnel(device: &UsbDevice, port: u16) -> Result<(), String> {
    let spec = format!("tcp:{port}");
    let output = Command::new("adb")
        .args(["-s", &device.serial, "reverse", "--remove", &spec])
        .output()
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
}
