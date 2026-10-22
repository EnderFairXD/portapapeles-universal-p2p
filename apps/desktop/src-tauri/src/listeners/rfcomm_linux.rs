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

/// Canal RFCOMM fijo. Con un UUID propio, BlueZ solo publica el canal en el registro SDP si
/// se le indica: sin él, Android encuentra el servicio pero con `scn:0` y no puede conectar.
/// El 22 no lo usa ningún perfil estándar de BlueZ.
pub(crate) const RFCOMM_CHANNEL: u16 = 22;

fn clipsync_profile(uuid: uuid::Uuid) -> Profile {
    Profile {
        uuid,
        name: Some("ClipSync".to_string()),
        role: Some(Role::Server),
        channel: Some(RFCOMM_CHANNEL),
        // solo dispositivos ya emparejados en el sistema; el cifrado Noise va por encima
        require_authentication: Some(true),
        require_authorization: Some(false),
        ..Default::default()
    }
}

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
    let mut handle = session
        .register_profile(clipsync_profile(uuid))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_perfil_publica_un_canal_rfcomm_fijo() {
        let uuid = uuid::Uuid::parse_str(RFCOMM_SERVICE_UUID).expect("UUID válido");
        let p = clipsync_profile(uuid);
        assert_eq!(p.channel, Some(RFCOMM_CHANNEL));
        assert_eq!(p.uuid, uuid);
    }
}
