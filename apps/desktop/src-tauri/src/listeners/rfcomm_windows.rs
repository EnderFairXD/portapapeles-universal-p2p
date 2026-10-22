//! Listener RFCOMM en Windows, con las API WinRT (crate `windows`): publica un servicio RFCOMM
//! con el UUID de ClipSync, escucha con un `StreamSocketListener` y entrega cada conexión al Hub.
//! Release con `panic = "abort"`: nada de lo que llega por la red puede entrar en pánico, todo
//! error se devuelve como texto.
//!
//! Las llamadas WinRT `.join()` bloquean el hilo, así que se hacen en `spawn_blocking` o en los
//! hilos puente de cada conexión, nunca en un hilo del runtime de tokio.

use std::time::Duration;

use tokio::io::{duplex, split, AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::runtime::Handle;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio::time::MissedTickBehavior;
use windows::core::GUID;
use windows::Devices::Bluetooth::BluetoothAdapter;
use windows::Devices::Bluetooth::Rfcomm::{RfcommServiceId, RfcommServiceProvider};
use windows::Devices::Radios::RadioState;
use windows::Foundation::TypedEventHandler;
use windows::Networking::Sockets::{
    SocketProtectionLevel, StreamSocket, StreamSocketListener, StreamSocketListenerConnectionReceivedEventArgs,
};
use windows::Storage::Streams::{DataReader, DataWriter, InputStreamOptions};

use super::{address_from_u64, AdapterState, Report};
use crate::core::{Hub, Transport};
use crate::protocol::RFCOMM_SERVICE_UUID;

/// Cada cuánto se comprueba si el adaptador se ha encendido o apagado.
const POWER_POLL: Duration = Duration::from_secs(10);
/// Tamaño del búfer de cada puente (en bytes) entre el socket de Windows y el flujo de la sesión.
const BRIDGE_BUFFER: usize = 64 * 1024;
/// Trozo máximo que se lee del socket de una vez.
const READ_CHUNK: u32 = 16 * 1024;

/// Lo que se sabe del adaptador por defecto en un instante.
struct Lectura {
    address: String,
    powered: bool,
}

/// Lee el adaptador por defecto (bloquea el hilo). Sin adaptador devuelve el motivo.
fn leer_adaptador() -> Result<Lectura, String> {
    let adapter = BluetoothAdapter::GetDefaultAsync()
        .and_then(|op| op.join())
        .map_err(|e| format!("no hay adaptador Bluetooth: {e}"))?;
    let address = address_from_u64(adapter.BluetoothAddress().map_err(|e| format!("no se puede leer el adaptador Bluetooth: {e}"))?);
    // si el estado de la radio no se puede leer se da por encendida: si no lo está, abrir el
    // listener fallará y el supervisor lo reintenta
    let powered = adapter
        .GetRadioAsync()
        .and_then(|op| op.join())
        .and_then(|radio| radio.State())
        .map(|estado| estado == RadioState::On)
        .unwrap_or(true);
    Ok(Lectura { address, powered })
}

/// `leer_adaptador` fuera del hilo del runtime.
async fn leer_adaptador_async() -> Result<Lectura, String> {
    tokio::task::spawn_blocking(leer_adaptador)
        .await
        .map_err(|e| format!("la lectura del adaptador falló: {e}"))?
}

/// Servicio publicado: mientras exista, Windows acepta conexiones RFCOMM con el UUID de ClipSync.
struct Servicio {
    provider: RfcommServiceProvider,
    // el listener tiene que seguir vivo mientras se anuncia el servicio
    _listener: StreamSocketListener,
    conexiones: UnboundedReceiver<StreamSocket>,
}

impl Drop for Servicio {
    fn drop(&mut self) {
        let _ = self.provider.StopAdvertising();
    }
}

/// Publica el servicio RFCOMM y empieza a anunciarlo (bloquea el hilo).
fn abrir_servicio() -> Result<Servicio, String> {
    let uuid = uuid::Uuid::parse_str(RFCOMM_SERVICE_UUID).map_err(|e| format!("UUID del servicio no válido: {e}"))?;
    let guid = GUID::from_u128(uuid.as_u128());
    let id = RfcommServiceId::FromUuid(guid).map_err(|e| format!("identificador de servicio RFCOMM no válido: {e}"))?;
    let provider = RfcommServiceProvider::CreateAsync(&id)
        .and_then(|op| op.join())
        .map_err(|e| format!("no se pudo registrar el servicio RFCOMM: {e}"))?;

    let listener = StreamSocketListener::new().map_err(|e| format!("no se pudo crear el listener: {e}"))?;
    let (tx, conexiones) = unbounded_channel();
    // el manejador corre en un hilo del sistema: solo pasa el socket al runtime
    listener
        .ConnectionReceived(&TypedEventHandler::<StreamSocketListener, StreamSocketListenerConnectionReceivedEventArgs>::new(
            move |_, args| {
                if let Some(socket) = args.as_ref().and_then(|a| a.Socket().ok()) {
                    let _ = tx.send(socket);
                }
                Ok(())
            },
        ))
        .map_err(|e| format!("no se pudo escuchar conexiones RFCOMM: {e}"))?;

    let nombre = id
        .AsString()
        .map_err(|e| format!("identificador de servicio RFCOMM no válido: {e}"))?;
    // solo dispositivos emparejados, con cifrado; el Noise va por encima
    listener
        .BindServiceNameWithProtectionLevelAsync(&nombre, SocketProtectionLevel::BluetoothEncryptionWithAuthentication)
        .and_then(|op| op.join())
        .map_err(|e| format!("no se pudo abrir el canal RFCOMM: {e}"))?;
    provider
        .StartAdvertising(&listener)
        .map_err(|e| format!("no se pudo anunciar el servicio RFCOMM: {e}"))?;
    Ok(Servicio { provider, _listener: listener, conexiones })
}

/// Bombea del socket al flujo de la sesión hasta que uno de los dos se cierre. Al terminar, por
/// cualquier camino, cierra el flujo con `shutdown` para que la sesión vea el fin (EOF).
fn bombear_entrada(socket: &StreamSocket, mut destino: WriteHalf<DuplexStream>, rt: &Handle) -> windows::core::Result<()> {
    let resultado = bombear_entrada_datos(socket, &mut destino, rt);
    // soltar el `WriteHalf` no cierra el `duplex` (queda el otro medio de `split`): hay que cerrarlo
    let _ = rt.block_on(destino.shutdown());
    resultado
}

fn bombear_entrada_datos(socket: &StreamSocket, destino: &mut WriteHalf<DuplexStream>, rt: &Handle) -> windows::core::Result<()> {
    let reader = DataReader::CreateDataReader(&socket.InputStream()?)?;
    // con `Partial`, `LoadAsync` vuelve en cuanto hay algún dato en vez de esperar a llenar el trozo
    reader.SetInputStreamOptions(InputStreamOptions::Partial)?;
    loop {
        let n = reader.LoadAsync(READ_CHUNK)?.join()? as usize;
        if n == 0 {
            return Ok(()); // el otro extremo cerró
        }
        let mut trozo = vec![0u8; n];
        reader.ReadBytes(&mut trozo)?;
        // si la sesión ya no escucha (flujo cerrado), se acaba el puente
        if rt.block_on(destino.write_all(&trozo)).is_err() {
            return Ok(());
        }
    }
}

/// Bombea del flujo de la sesión al socket hasta que uno de los dos se cierre.
fn bombear_salida(socket: &StreamSocket, mut origen: ReadHalf<DuplexStream>, rt: &Handle) -> windows::core::Result<()> {
    let writer = DataWriter::CreateDataWriter(&socket.OutputStream()?)?;
    let mut trozo = vec![0u8; READ_CHUNK as usize];
    loop {
        let n = match rt.block_on(origen.read(&mut trozo)) {
            Ok(0) | Err(_) => return Ok(()), // la sesión cerró su lado
            Ok(n) => n,
        };
        writer.WriteBytes(&trozo[..n])?;
        writer.StoreAsync()?.join()?;
    }
}

/// Adapta un `StreamSocket` a `AsyncRead + AsyncWrite` y lo entrega al Hub como sesión
/// Bluetooth. Cada conexión usa un `duplex` en memoria y dos hilos puente (uno por sentido);
/// ninguno pierde ni reordena bytes. Los hilos se acaban cuando cualquiera de los lados se cierra.
fn entregar(hub: &Hub, socket: StreamSocket, rt: &Handle) {
    let (lado_sesion, lado_puente) = duplex(BRIDGE_BUFFER);
    let (lectura, escritura) = split(lado_puente);

    let socket_entrada = socket.clone();
    let rt_entrada = rt.clone();
    let entrada = std::thread::Builder::new().name("rfcomm-entrada".to_string()).spawn(move || {
        if let Err(e) = bombear_entrada(&socket_entrada, escritura, &rt_entrada) {
            super::log(&format!("lectura del socket RFCOMM: {e}"));
        }
        // `bombear_entrada` ya cerró el flujo (la sesión ve el EOF); el socket se cierra para que
        // el hilo de salida no se quede esperando
        let _ = socket_entrada.Close();
    });
    if let Err(e) = entrada {
        super::log(&format!("no se pudo crear el hilo de lectura RFCOMM: {e}"));
        let _ = socket.Close();
        return;
    }

    let socket_salida = socket.clone();
    let rt_salida = rt.clone();
    let salida = std::thread::Builder::new().name("rfcomm-salida".to_string()).spawn(move || {
        if let Err(e) = bombear_salida(&socket_salida, lectura, &rt_salida) {
            super::log(&format!("escritura en el socket RFCOMM: {e}"));
        }
        // desbloquea el hilo de entrada, que espera datos del socket
        let _ = socket_salida.Close();
    });
    if let Err(e) = salida {
        super::log(&format!("no se pudo crear el hilo de escritura RFCOMM: {e}"));
        let _ = socket.Close();
        return;
    }

    hub.accept_stream(lado_sesion, Transport::Bluetooth);
}

/// Escucha conexiones RFCOMM. Sin adaptador (o sin servicio Bluetooth de Windows) avisa con
/// `AdapterState::Unavailable` y devuelve el motivo; el llamador (`listeners::run`) reintenta
/// cada 30 s. Con el adaptador apagado avisa y espera a que se encienda.
pub async fn serve_rfcomm(hub: Hub, report: Report) -> Result<(), String> {
    let rt = Handle::current();
    let mut sondeo = tokio::time::interval(POWER_POLL);
    sondeo.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        // espera a que el adaptador esté encendido
        loop {
            let lectura = leer_adaptador_async().await.map_err(|e| {
                report(AdapterState::Unavailable);
                e
            })?;
            report(AdapterState::from_adapter(Some(lectura.address), lectura.powered));
            if lectura.powered {
                break;
            }
            sondeo.tick().await;
        }

        let mut servicio = tokio::task::spawn_blocking(abrir_servicio)
            .await
            .map_err(|e| format!("abrir el servicio RFCOMM falló: {e}"))?
            .map_err(|e| {
                report(AdapterState::Unavailable);
                e
            })?;

        // escucha hasta que el adaptador se apague o desaparezca
        loop {
            tokio::select! {
                socket = servicio.conexiones.recv() => {
                    let Some(socket) = socket else {
                        return Err("el listener RFCOMM se cerró".to_string());
                    };
                    entregar(&hub, socket, &rt);
                }
                _ = sondeo.tick() => {
                    let lectura = leer_adaptador_async().await.map_err(|e| {
                        report(AdapterState::Unavailable);
                        e
                    })?;
                    let encendido = lectura.powered;
                    report(AdapterState::from_adapter(Some(lectura.address), encendido));
                    if !encendido {
                        break; // se suelta el servicio y se vuelve a esperar el encendido
                    }
                }
            }
        }
    }
}
