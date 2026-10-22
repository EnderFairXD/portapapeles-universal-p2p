//! Listener RFCOMM en Linux, con BlueZ (crate `bluer`): registra un perfil servidor con el UUID
//! del servicio y entrega cada conexión al Hub. Nada de lo que llega por la red puede entrar
//! en pánico (release con `panic = "abort"`): todo error se devuelve como texto.

use std::time::Duration;

use bluer::rfcomm::{Profile, Role};
use futures::StreamExt;
use tokio::time::MissedTickBehavior;

use super::{AdapterState, Report};
use crate::core::{Hub, Transport};
use crate::protocol::RFCOMM_SERVICE_UUID;

/// Cada cuánto se comprueba si el adaptador se ha encendido o apagado.
const POWER_POLL: Duration = Duration::from_secs(10);

/// Escucha conexiones RFCOMM hasta que el adaptador desaparece o BlueZ se cae; entonces
/// devuelve el motivo. Sin adaptador o sin BlueZ avisa con `AdapterState::Unavailable`; el
/// llamador (`listeners::run`) reintenta cada 30 s.
pub async fn serve_rfcomm(hub: Hub, report: Report) -> Result<(), String> {
    let session = bluer::Session::new().await.map_err(|e| {
        report(AdapterState::Unavailable);
        format!("BlueZ no está disponible: {e}")
    })?;
    let adapter = session.default_adapter().await.map_err(|e| {
        report(AdapterState::Unavailable);
        format!("no hay adaptador Bluetooth: {e}")
    })?;
    let address = adapter.address().await.map_err(|e| {
        report(AdapterState::Unavailable);
        format!("no se puede leer el adaptador Bluetooth: {e}")
    })?;
    let address = address.to_string();
    let estado = |powered: bool| AdapterState::from_adapter(Some(address.clone()), powered);

    // aviso inicial; un fallo al leer el encendido cuenta como apagado
    report(estado(adapter.is_powered().await.unwrap_or(false)));

    let uuid = uuid::Uuid::parse_str(RFCOMM_SERVICE_UUID).map_err(|e| format!("UUID del servicio no válido: {e}"))?;
    let profile = Profile {
        uuid,
        name: Some("ClipSync".to_string()),
        role: Some(Role::Server),
        // solo dispositivos ya emparejados en el sistema; el cifrado Noise va por encima
        require_authentication: Some(true),
        require_authorization: Some(false),
        ..Default::default()
    };
    let mut handle = session
        .register_profile(profile)
        .await
        .map_err(|e| format!("no se pudo registrar el perfil RFCOMM: {e}"))?;

    let mut sondeo = tokio::time::interval(POWER_POLL);
    sondeo.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            peticion = handle.next() => {
                let Some(peticion) = peticion else {
                    return Err("BlueZ dio de baja el perfil RFCOMM".to_string());
                };
                match peticion.accept() {
                    Ok(flujo) => hub.accept_stream(flujo, Transport::Bluetooth),
                    Err(e) => super::log(&format!("conexión RFCOMM rechazada: {e}")),
                }
            }
            _ = sondeo.tick() => {
                match adapter.is_powered().await {
                    Ok(encendido) => report(estado(encendido)),
                    Err(e) => {
                        report(AdapterState::Unavailable);
                        return Err(format!("el adaptador Bluetooth ya no responde: {e}"));
                    }
                }
            }
        }
    }
}
