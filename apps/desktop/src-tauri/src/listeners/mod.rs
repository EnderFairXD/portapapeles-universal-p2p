//! Escuchas de medios distintos de TCP. Hoy solo RFCOMM (Bluetooth Classic): cada conexión
//! entrante se entrega al Hub con `accept_stream(flujo, Transport::Bluetooth)` y desde ahí es
//! una sesión más (mismo Noise IK, mismo protocolo).
//!
//! El Bluetooth es opcional: sin adaptador, sin BlueZ o con el adaptador apagado el PC arranca
//! igual, avisa en la interfaz y vuelve a intentarlo cada 30 s por si se enchufa uno.

use std::future::Future;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use crate::core::pairing::is_bt_address;
use crate::core::Hub;

#[cfg(target_os = "linux")]
mod rfcomm_linux;
#[cfg(target_os = "linux")]
use rfcomm_linux::serve_rfcomm;
#[cfg(windows)]
mod rfcomm_windows;
#[cfg(windows)]
use rfcomm_windows::serve_rfcomm;

/// Cada cuánto se reintenta abrir el listener si no hay adaptador o BlueZ no responde.
pub const RETRY_INTERVAL: Duration = Duration::from_secs(30);

/// Aviso cuando no hay adaptador Bluetooth (o el servicio del sistema no está disponible).
pub const NO_BLUETOOTH_NOTICE: &str = "Este PC no tiene Bluetooth";
/// Aviso cuando hay adaptador pero está apagado.
pub const BLUETOOTH_OFF_NOTICE: &str = "Bluetooth apagado";

/// Estado del Bluetooth del PC, lo que importa a la interfaz y al QR.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdapterState {
    /// Sin adaptador, o sin BlueZ/servicio de Bluetooth del sistema.
    Unavailable,
    /// Hay adaptador pero está apagado.
    Off { address: String },
    /// Adaptador encendido: el PC escucha.
    On { address: String },
}

impl AdapterState {
    /// Estado a partir de lo que se sabe del adaptador por defecto: su dirección (si hay) y si
    /// está encendido.
    pub fn from_adapter(address: Option<String>, powered: bool) -> Self {
        match address {
            None => Self::Unavailable,
            Some(address) if powered => Self::On { address },
            Some(address) => Self::Off { address },
        }
    }

    /// Aviso para la interfaz; `None` si el Bluetooth funciona.
    pub fn notice(&self) -> Option<&'static str> {
        match self {
            Self::Unavailable => Some(NO_BLUETOOTH_NOTICE),
            Self::Off { .. } => Some(BLUETOOTH_OFF_NOTICE),
            Self::On { .. } => None,
        }
    }

    /// Dirección que lleva el QR (`bt`): la del adaptador si existe, aunque esté apagado (el
    /// usuario puede encenderlo después). Una dirección con formato raro no se ofrece.
    pub fn qr_address(&self) -> Option<&str> {
        match self {
            Self::Unavailable => None,
            Self::Off { address } | Self::On { address } => Some(address.as_str()).filter(|a| is_bt_address(a)),
        }
    }
}

/// Cómo avisa el listener del estado del adaptador (la app lo guarda en `UiState`).
pub type Report = Arc<dyn Fn(AdapterState) + Send + Sync>;

fn log(msg: &str) {
    // writeln no hace panic si stderr no está disponible (panic = "abort")
    let _ = writeln!(std::io::stderr(), "[Bluetooth] {msg}");
}

/// Sin soporte de RFCOMM en este sistema (Linux y Windows tienen su propio módulo).
#[cfg(not(any(target_os = "linux", windows)))]
async fn serve_rfcomm(_hub: Hub, report: Report) -> Result<(), String> {
    report(AdapterState::Unavailable);
    Err("RFCOMM no está disponible en este sistema".to_string())
}

/// Dirección Bluetooth `AA:BB:CC:DD:EE:FF` a partir del entero de 48 bits que da Windows.
#[cfg(any(windows, test))]
fn address_from_u64(address: u64) -> String {
    let b = address.to_be_bytes(); // los dos primeros bytes son 0: la dirección usa 48 bits
    format!("{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}", b[2], b[3], b[4], b[5], b[6], b[7])
}

/// Repite `serve` con una pausa de `retry` entre intentos; no termina. Un error se registra
/// solo cuando cambia, para no llenar el registro con el mismo aviso cada 30 s.
async fn supervise<F, Fut>(mut serve: F, retry: Duration)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut ultimo: Option<String> = None;
    loop {
        let error = match serve().await {
            Ok(()) => "el listener terminó".to_string(),
            Err(e) => e,
        };
        if ultimo.as_deref() != Some(error.as_str()) {
            log(&format!("{error}; se reintenta cada {} s", retry.as_secs()));
            ultimo = Some(error);
        }
        tokio::time::sleep(retry).await;
    }
}

/// Mantiene el listener RFCOMM vivo mientras la app corra: no termina ni hace pánico, pase lo
/// que pase con el adaptador. Debe lanzarse dentro de un runtime de tokio.
pub async fn run(hub: Hub, report: Report) {
    supervise(move || serve_rfcomm(hub.clone(), report.clone()), RETRY_INTERVAL).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const DIR: &str = "00:1A:7D:DA:71:13";

    #[test]
    fn estado_segun_el_adaptador() {
        assert_eq!(AdapterState::from_adapter(None, false), AdapterState::Unavailable);
        assert_eq!(AdapterState::from_adapter(None, true), AdapterState::Unavailable);
        assert_eq!(AdapterState::from_adapter(Some(DIR.into()), false), AdapterState::Off { address: DIR.into() });
        assert_eq!(AdapterState::from_adapter(Some(DIR.into()), true), AdapterState::On { address: DIR.into() });
    }

    #[test]
    fn direccion_desde_el_entero_de_windows() {
        assert_eq!(address_from_u64(0x001A_7DDA_7113), DIR);
        assert_eq!(address_from_u64(0xFFFF_FFFF_FFFF), "FF:FF:FF:FF:FF:FF");
        assert!(is_bt_address(&address_from_u64(0x0000_0000_000A)));
    }

    #[test]
    fn aviso_segun_el_estado() {
        assert_eq!(AdapterState::Unavailable.notice(), Some("Este PC no tiene Bluetooth"));
        assert_eq!(AdapterState::Off { address: DIR.into() }.notice(), Some("Bluetooth apagado"));
        assert_eq!(AdapterState::On { address: DIR.into() }.notice(), None);
    }

    #[test]
    fn el_qr_lleva_la_direccion_si_hay_adaptador() {
        assert_eq!(AdapterState::Unavailable.qr_address(), None);
        assert_eq!(AdapterState::Off { address: DIR.into() }.qr_address(), Some(DIR));
        assert_eq!(AdapterState::On { address: DIR.into() }.qr_address(), Some(DIR));
        assert_eq!(AdapterState::On { address: "no-es-una-direccion".into() }.qr_address(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn el_supervisor_reintenta_cada_30_s_sin_terminar() {
        let intentos = Arc::new(AtomicUsize::new(0));
        let contador = intentos.clone();
        let tarea = tokio::spawn(supervise(
            move || {
                let contador = contador.clone();
                async move {
                    contador.fetch_add(1, Ordering::SeqCst);
                    Err::<(), String>("sin adaptador".to_string())
                }
            },
            RETRY_INTERVAL,
        ));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(intentos.load(Ordering::SeqCst), 1, "el primer intento es inmediato");
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(intentos.load(Ordering::SeqCst), 2);
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(intentos.load(Ordering::SeqCst), 4);
        assert!(!tarea.is_finished());
        tarea.abort();
    }
}
