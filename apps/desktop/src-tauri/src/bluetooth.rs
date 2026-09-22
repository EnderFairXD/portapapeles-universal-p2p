//! Fase 4 (Bluetooth) — scaffold, sin envío/recepción real todavía. Ver
//! docs/architecture.md §5: BLE para texto/handshake, Classic (solo Android) para
//! archivos.
//!
//! **Nota de arquitectura pendiente de resolver antes de implementar de verdad**:
//! `btleplug` (aquí) y `react-native-ble-plx` (`apps/mobile/src/lib/bleTransport.ts`) son
//! ambas librerías de rol **central** — escanean y se conectan a periféricos, ninguna
//! anuncia un servicio GATT propio como periférico. Para que un extremo encuentre al otro
//! por BLE, alguien tiene que hacer de periférico (anunciar el servicio); lo más probable
//! es que sea el móvil, con una librería distinta con soporte de advertising GATT —
//! `react-native-ble-plx` no lo tiene. Hay que decidir esto (y qué librería de
//! advertising usar) antes de que `start_scan` de abajo tenga algo real que encontrar.
//!
//! Nada de este módulo se llama desde `lib.rs` todavía. `#![allow(dead_code)]` evita el
//! ruido de warnings hasta que se enlace.
#![allow(dead_code)]

use btleplug::api::{Central, Manager as _, ScanFilter};
use btleplug::platform::{Adapter, Manager};
use uuid::Uuid;

/// UUID v4 estático del servicio GATT BLE. Debe coincidir con BLE_SERVICE_UUID en
/// packages/protocol/src/constants.ts.
pub const BLE_SERVICE_UUID: &str = "2c9a7e4a-4f1b-4d6e-9c3a-8b7f61d2e5a4";

fn service_uuid() -> Uuid {
    Uuid::parse_str(BLE_SERVICE_UUID).expect("BLE_SERVICE_UUID es un UUID v4 válido, verificado en tests")
}

/// Primer adaptador Bluetooth disponible en el sistema, o error si no hay ninguno
/// (Bluetooth apagado, sin hardware, o sin permisos del SO).
pub async fn first_adapter() -> Result<Adapter, String> {
    let manager = Manager::new().await.map_err(|e| format!("no se pudo iniciar btleplug: {e}"))?;
    let adapters = manager.adapters().await.map_err(|e| format!("no se pudieron listar adaptadores: {e}"))?;

    adapters
        .into_iter()
        .next()
        .ok_or_else(|| "no se encontró ningún adaptador Bluetooth".to_string())
}

/// Arranca un escaneo filtrado por BLE_SERVICE_UUID. Ver la nota de arquitectura arriba:
/// hoy no encontrará nada real hasta que exista un periférico anunciando ese servicio.
pub async fn start_scan(adapter: &Adapter) -> Result<(), String> {
    let filter = ScanFilter {
        services: vec![service_uuid()],
    };
    adapter
        .start_scan(filter)
        .await
        .map_err(|e| format!("no se pudo iniciar el escaneo BLE: {e}"))?;

    println!("[BLE] Escaneo iniciado, filtrando por servicio {BLE_SERVICE_UUID}");
    Ok(())
}

// TODO(Fase 4): conectar a un Peripheral encontrado, descubrir sus características GATT,
// y enviar/recibir un SyncMessage por una característica propia (definir su UUID junto a
// BLE_SERVICE_UUID). Depende de resolver primero el rol central/periférico de arriba.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ble_service_uuid_is_a_valid_v4_uuid() {
        let parsed = Uuid::parse_str(BLE_SERVICE_UUID).expect("debe parsear como UUID válido");
        assert_eq!(parsed.get_version_num(), 4);
    }
}
