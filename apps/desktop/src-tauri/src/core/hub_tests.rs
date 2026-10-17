//! Tests del Hub con un cliente de prueba que habla el protocolo a mano sobre `tokio::io::duplex`:
//! hace el handshake Noise IK como el móvil y cifra y descifra cada trama.

use super::*;
use crate::core::pairing::{PairedDevice, PairedStore};
use crate::protocol::hello::{decode_server_hello, ClientHello, RejectReason, ServerHello};
use crate::protocol::secure::{self, StaticKeys};
use crate::protocol::{
    encode_control, encode_file_data, frame_codec, ControlMessage, Decoded, MessageDecoder,
    FILE_CHUNK_BYTES, MAX_FRAME_BYTES,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use snow::TransportState;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncWriteExt, DuplexStream, ReadBuf, WriteHalf};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::oneshot;
use tokio::time::{timeout, Instant};
use tokio_util::bytes::Bytes;
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};

const WAIT: Duration = Duration::from_secs(10);
const MIB: u64 = 1_048_576;
const TID: &str = "0123456789abcdef0123456789abcdef";

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn datos(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 31 % 251) as u8).collect()
}

fn js(ev: &HubEvent) -> Value {
    serde_json::to_value(ev).unwrap()
}

/// Claves fijas de un móvil de prueba: `sha256("test/" + device_id)`.
fn test_keys(device_id: &str) -> StaticKeys {
    StaticKeys::from_private(Sha256::digest(format!("test/{device_id}").as_bytes()).into())
}

/// Clave pública del móvil en hex: su identidad en el PC (D4).
fn key_hex(device_id: &str) -> String {
    hex::encode(test_keys(device_id).public)
}

/// Claves del PC de prueba.
fn pc_keys() -> StaticKeys {
    test_keys("pc")
}

struct Setup {
    hub: Hub,
    events: UnboundedReceiver<HubEvent>,
    dir: tempfile::TempDir,
    /// carpeta de datos del PC (aquí vive `paired.json`), aparte de la de descargas
    data: tempfile::TempDir,
    /// lo que devuelve `local_clip` (el último texto del portapapeles del PC)
    local: Arc<Mutex<Option<String>>>,
}

/// Hub con `m1` y `m2` ya emparejados.
fn setup(local: Option<&str>) -> Setup {
    setup_with(local, &["m1", "m2"])
}

fn setup_with(local: Option<&str>, emparejados: &[&str]) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut paired = PairedStore::load(Some(data.path().join("paired.json")));
    for id in emparejados {
        paired
            .upsert(PairedDevice {
                public_key: key_hex(id),
                device_id: id.to_string(),
                device_name: format!("Móvil {id}"),
                paired_at_ms: 1,
            })
            .unwrap();
    }
    let local = Arc::new(Mutex::new(local.map(String::from)));
    let l = local.clone();
    let (hub, events) = Hub::new(HubConfig {
        device_id: "pc-1".into(),
        pc_name: "PC de prueba".into(),
        download_dir: dir.path().to_path_buf(),
        local_clip: Arc::new(move || l.lock().unwrap().clone()),
        keys: pc_keys(),
        paired,
    });
    Setup {
        hub,
        events,
        dir,
        data,
        local,
    }
}

impl Setup {
    /// El PC copia un texto: se actualiza `local_clip` y luego se difunde, como hará la app.
    fn copy(&self, text: &str) {
        *self.local.lock().unwrap() = Some(text.to_string());
        self.hub.broadcast_clip(text);
    }

    async fn event(&mut self) -> Value {
        js(&timeout(WAIT, self.events.recv())
            .await
            .expect("sin evento")
            .expect("canal cerrado"))
    }

    /// Eventos de transferencia hasta el estado final (incluido).
    async fn transfer_until_end(&mut self) -> Vec<Value> {
        let mut v = Vec::new();
        loop {
            let e = self.event().await;
            assert_eq!(e["type"], "transfer", "{e}");
            let fin = !matches!(e["state"].as_str(), Some("queued" | "active"));
            v.push(e);
            if fin {
                return v;
            }
        }
    }

    fn no_events(&mut self) {
        if let Ok(e) = self.events.try_recv() {
            panic!("evento inesperado: {}", js(&e));
        }
    }

    fn files(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    /// Contenido de `paired.json` (vacío si no existe).
    fn paired_json(&self) -> String {
        std::fs::read_to_string(self.data.path().join("paired.json")).unwrap_or_default()
    }
}

/// Carga del mensaje 1 de un móvil de prueba, sin token.
fn client_hello(device_id: &str, will_send_clip: Option<bool>) -> ClientHello {
    ClientHello {
        v: 2,
        device_id: device_id.into(),
        device_name: format!("Móvil {device_id}"),
        will_send_clip,
        pairing_token: None,
    }
}

/// `hello` en claro de la fase 1, que ya no es un mensaje de control.
fn hello_fase_1(device_id: &str) -> Vec<u8> {
    let mut p = vec![0x01];
    p.extend_from_slice(
        format!(
            r#"{{"kind":"hello","v":2,"deviceId":"{device_id}","deviceName":"Móvil {device_id}"}}"#
        )
        .as_bytes(),
    );
    p
}

fn clip(text: &str) -> ControlMessage {
    ControlMessage::Clip {
        id: "c".repeat(32),
        text: text.into(),
        hash: sha(text.as_bytes()),
    }
}

fn server_hello() -> ServerHello {
    ServerHello::accept("pc-1", "PC de prueba")
}

fn peer_connected(session_id: u64, device_id: &str, transport: &str) -> Value {
    json!({"type": "peerConnected", "sessionId": session_id, "deviceId": key_hex(device_id),
           "deviceName": format!("Móvil {device_id}"), "transport": transport})
}

fn device_paired(device_id: &str) -> Value {
    json!({"type": "devicePaired", "deviceKey": key_hex(device_id),
           "deviceName": format!("Móvil {device_id}")})
}

fn transfer(id: &str, dir: &str, name: &str, size: u64, bytes: u64, state: &str) -> Value {
    json!({"type": "transfer", "transferId": id, "direction": dir, "name": name, "size": size,
           "bytes": bytes, "state": state, "error": null, "location": null})
}

fn with(mut v: Value, key: &str, val: Value) -> Value {
    v[key] = val;
    v
}

/// Canal de transporte Noise del cliente, compartido entre quien escribe y el hilo lector.
type Canal = Arc<Mutex<TransportState>>;

/// Cliente de prueba: hace el handshake como el móvil, escribe a mano y un hilo lector descifra
/// y decodifica todo lo que llega.
struct Client<W> {
    w: FramedWrite<W, LengthDelimitedCodec>,
    rx: UnboundedReceiver<Decoded>,
    /// primera trama del PC (el mensaje 2); `None` si cerró sin enviarla
    msg2: Option<oneshot::Receiver<Option<Vec<u8>>>>,
    /// entrega el canal al hilo lector si el PC acepta; si se suelta, el lector solo espera al cierre
    al_lector: Option<oneshot::Sender<Canal>>,
    canal: Option<Canal>,
}

fn connect(hub: &Hub) -> Client<WriteHalf<DuplexStream>> {
    let (a, b) = tokio::io::duplex(256 * 1024);
    hub.accept_stream(b, Transport::Wifi);
    over(a)
}

fn over<S: AsyncRead + AsyncWrite + Send + 'static>(s: S) -> Client<WriteHalf<S>> {
    let (r, w) = tokio::io::split(s);
    let (tx, rx) = mpsc::unbounded_channel();
    let (msg2_tx, msg2_rx) = oneshot::channel();
    let (canal_tx, canal_rx) = oneshot::channel::<Canal>();
    tokio::spawn(async move {
        let mut frames = FramedRead::new(r, frame_codec());
        let Some(Ok(primera)) = frames.next().await else {
            let _ = msg2_tx.send(None);
            return; // cerró sin responder: `rx` queda cerrado
        };
        let _ = msg2_tx.send(Some(primera.to_vec()));
        let Ok(canal) = canal_rx.await else {
            // rechazado (o sin handshake): tras el mensaje 2 solo cabe el cierre
            if let Some(Ok(f)) = frames.next().await {
                panic!("el servidor envió {} bytes tras rechazar", f.len());
            }
            return;
        };
        let mut dec = MessageDecoder::default();
        let mut buf = vec![0u8; MAX_FRAME_BYTES];
        while let Some(Ok(f)) = frames.next().await {
            let n = canal
                .lock()
                .unwrap()
                .read_message(&f, &mut buf)
                .expect("el servidor envió una trama que no descifra");
            match dec.push(&buf[..n]) {
                Ok(Some(d)) => {
                    if tx.send(d).is_err() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(e) => panic!("el servidor envió algo inválido: {e}"),
            }
        }
    });
    Client {
        w: FramedWrite::new(w, frame_codec()),
        rx,
        msg2: Some(msg2_rx),
        al_lector: Some(canal_tx),
        canal: None,
    }
}

impl<W: AsyncWrite + Unpin> Client<W> {
    /// Handshake con las claves de `hello.device_id` contra la clave pública `pc`. Devuelve la
    /// respuesta del PC, o `None` si cerró sin responder.
    async fn handshake_to(
        &mut self,
        keys: &StaticKeys,
        pc: &[u8; 32],
        hello: &ClientHello,
    ) -> Option<ServerHello> {
        let mut hs = secure::initiator(keys, pc).unwrap();
        let mut buf = vec![0u8; MAX_FRAME_BYTES];
        let n = hs
            .write_message(&serde_json::to_vec(hello).unwrap(), &mut buf)
            .unwrap();
        if self
            .w
            .send(Bytes::copy_from_slice(&buf[..n]))
            .await
            .is_err()
        {
            return None; // el PC ya había cerrado (p. ej. sin hueco)
        }
        let msg2 = timeout(WAIT, self.msg2.take().expect("handshake repetido"))
            .await
            .expect("el PC no respondió al mensaje 1")
            .unwrap()?;
        let n = hs
            .read_message(&msg2, &mut buf)
            .expect("mensaje 2 inválido");
        let answer = decode_server_hello(&buf[..n]).unwrap();
        let al_lector = self.al_lector.take().unwrap();
        if matches!(answer, ServerHello::Accepted { .. }) {
            let canal = Arc::new(Mutex::new(hs.into_transport_mode().unwrap()));
            let _ = al_lector.send(canal.clone());
            self.canal = Some(canal);
        }
        Some(answer)
    }

    async fn handshake(&mut self, hello: &ClientHello) -> Option<ServerHello> {
        let keys = test_keys(&hello.device_id);
        self.handshake_to(&keys, &pc_keys().public, hello).await
    }

    async fn hello(&mut self, device_id: &str, will_send_clip: Option<bool>) {
        let answer = self
            .handshake(&client_hello(device_id, will_send_clip))
            .await;
        assert_eq!(answer, Some(server_hello()));
    }

    async fn send(&mut self, msg: ControlMessage) {
        for f in encode_control(&msg).unwrap() {
            self.send_payload(&f).await;
        }
    }

    /// Envía un payload: cifrado tras el handshake y en claro antes (como un par hostil). Antes
    /// del handshake el PC puede cerrar en cualquier momento, así que ahí se ignoran los errores.
    async fn send_payload(&mut self, payload: &[u8]) {
        let Some(canal) = &self.canal else {
            let _ = self.w.send(Bytes::copy_from_slice(payload)).await;
            return;
        };
        let mut buf = vec![0u8; MAX_FRAME_BYTES];
        let n = canal
            .lock()
            .unwrap()
            .write_message(payload, &mut buf)
            .unwrap();
        self.w
            .send(Bytes::copy_from_slice(&buf[..n]))
            .await
            .unwrap();
    }

    /// Cifra el payload y cambia un bit del mensaje cifrado antes de enviarlo.
    async fn send_corrupt(&mut self, payload: &[u8]) {
        let canal = self.canal.as_ref().expect("sin handshake");
        let mut buf = vec![0u8; MAX_FRAME_BYTES];
        let n = canal
            .lock()
            .unwrap()
            .write_message(payload, &mut buf)
            .unwrap();
        buf[n / 2] ^= 0x01;
        self.w
            .send(Bytes::copy_from_slice(&buf[..n]))
            .await
            .unwrap();
    }

    async fn send_data(&mut self, id: &str, bytes: &[u8]) {
        let id: [u8; 16] = hex::decode(id).unwrap().try_into().unwrap();
        self.send_payload(&encode_file_data(&id, bytes)).await;
    }

    async fn recv(&mut self) -> Option<Decoded> {
        timeout(WAIT, self.rx.recv())
            .await
            .expect("el servidor no envió nada")
    }

    /// Siguiente mensaje de control, saltando los ping.
    async fn ctrl(&mut self) -> ControlMessage {
        loop {
            match self.recv().await {
                Some(Decoded::Control(ControlMessage::Ping)) => {}
                Some(Decoded::Control(m)) => return m,
                other => panic!("se esperaba control: {other:?}"),
            }
        }
    }

    /// Envía ping y devuelve lo que llegó antes del pong (sin contar los ping).
    async fn sync(&mut self) -> Vec<Decoded> {
        self.send(ControlMessage::Ping).await;
        let mut v = Vec::new();
        loop {
            match self.recv().await {
                Some(Decoded::Control(ControlMessage::Pong)) => return v,
                Some(Decoded::Control(ControlMessage::Ping)) => {}
                Some(d) => v.push(d),
                None => panic!("conexión cerrada"),
            }
        }
    }

    /// Corta la conexión desde el cliente (fin del flujo de escritura).
    async fn cut(mut self) {
        let _ = self.w.get_mut().shutdown().await;
    }

    async fn closed(&mut self) {
        loop {
            match self.recv().await {
                None => return,
                Some(Decoded::Control(ControlMessage::Ping)) => {}
                Some(d) => panic!("se esperaba el cierre: {d:?}"),
            }
        }
    }
}

static FIN: AtomicU64 = AtomicU64::new(0);

/// Barrera fiable tras `broadcast_clip`: difunde un texto nuevo (las órdenes de cada sesión van en
/// orden) y devuelve, por cliente, los clips que llegaron antes. Un ping/pong no sirve aquí: la
/// sesión puede atender el ping antes que las órdenes ya encoladas.
async fn clips_antes_de_fin<W: AsyncWrite + Unpin>(
    hub: &Hub,
    cs: &mut [&mut Client<W>],
) -> Vec<Vec<String>> {
    let fin = format!("fin-{}", FIN.fetch_add(1, AtomicOrdering::Relaxed));
    hub.broadcast_clip(&fin);
    let mut out = Vec::new();
    for c in cs.iter_mut() {
        let mut v = Vec::new();
        loop {
            match c.ctrl().await {
                ControlMessage::Clip { text, .. } if text == fin => break,
                ControlMessage::Clip { text, .. } => v.push(text),
                m => panic!("{m:?}"),
            }
        }
        out.push(v);
    }
    out
}

// --- saludo y portapapeles ---

#[tokio::test]
async fn saludo_emite_peer_connected() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&client_hello("m1", Some(false))).await,
        Some(server_hello())
    );
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    assert!(
        c.sync().await.is_empty(),
        "sin texto local no se envía clip"
    );
    s.no_events();
}

#[tokio::test]
async fn clip_entrante_emite_evento_y_no_rebota() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    c.send(clip("hola")).await;
    assert_eq!(
        s.event().await,
        json!({"type": "clipReceived", "sessionId": 1, "text": "hola"})
    );
    s.hub.broadcast_clip("hola");
    s.hub.broadcast_clip("otro");
    match c.ctrl().await {
        ControlMessage::Clip { id, text, hash } => {
            assert_eq!(text, "otro", "«hola» no debe rebotar");
            assert_eq!(hash, sha(b"otro"));
            assert!(id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()));
        }
        m => panic!("{m:?}"),
    }
    assert!(c.sync().await.is_empty());
}

#[tokio::test]
async fn clip_de_un_movil_se_reenvia_al_otro_y_no_vuelve() {
    let mut s = setup(None);
    let mut a = connect(&s.hub);
    a.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    let mut b = connect(&s.hub);
    b.hello("m2", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(2, "m2", "wifi"));

    a.send(clip("x")).await;
    assert_eq!(
        s.event().await,
        json!({"type": "clipReceived", "sessionId": 1, "text": "x"})
    );
    assert!(matches!(b.ctrl().await, ControlMessage::Clip { text, .. } if text == "x"));
    assert!(a.sync().await.is_empty(), "no vuelve al origen");

    // el PC escribe «x» en su portapapeles y el sondeo lo difunde: no sale hacia nadie
    s.hub.broadcast_clip("x");
    assert_eq!(
        clips_antes_de_fin(&s.hub, &mut [&mut a, &mut b]).await,
        vec![Vec::<String>::new(), vec![]]
    );

    b.send(clip("y")).await;
    assert_eq!(
        s.event().await,
        json!({"type": "clipReceived", "sessionId": 2, "text": "y"})
    );
    assert!(matches!(a.ctrl().await, ControlMessage::Clip { text, .. } if text == "y"));
    assert!(b.sync().await.is_empty());
}

#[tokio::test]
async fn regla_inicio_ambos_cambiaron_gana_movil() {
    let mut s = setup(Some("pc"));
    let mut c = connect(&s.hub);
    c.hello("m1", Some(true)).await;
    c.send(clip("móvil")).await;
    assert!(c.sync().await.is_empty(), "el PC cede: no envía su texto");
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    assert_eq!(
        s.event().await,
        json!({"type": "localClipSuperseded", "text": "pc"})
    );
    assert_eq!(
        s.event().await,
        json!({"type": "clipReceived", "sessionId": 1, "text": "móvil"})
    );
}

#[tokio::test]
async fn regla_inicio_al_ceder_marca_el_texto_local() {
    // Sin la marca, un broadcast del texto local justo tras conectar cruzaría con el del móvil.
    let mut s = setup(Some("pc"));
    let mut c = connect(&s.hub);
    c.hello("m1", Some(true)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    s.hub.broadcast_clip("pc");
    assert_eq!(
        clips_antes_de_fin(&s.hub, &mut [&mut c]).await,
        Vec::<Vec<String>>::from([vec![]])
    );
}

#[tokio::test]
async fn regla_inicio_solo_pc_cambio_envia_clip() {
    for will in [Some(false), None] {
        let mut s = setup(Some("pc"));
        let mut c = connect(&s.hub);
        c.hello("m1", will).await;
        match c.ctrl().await {
            ControlMessage::Clip { text, hash, .. } => {
                assert_eq!(text, "pc");
                assert_eq!(hash, sha(b"pc"));
            }
            m => panic!("{m:?}"),
        }
        assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
        s.hub.broadcast_clip("pc");
        // ya se envió al arrancar
        assert_eq!(
            clips_antes_de_fin(&s.hub, &mut [&mut c]).await,
            Vec::<Vec<String>>::from([vec![]])
        );
        s.no_events();
    }
}

#[tokio::test]
async fn regla_inicio_texto_que_no_cabe_no_se_envia_ni_cede() {
    // 1 MiB de comillas: cabe como texto pero su JSON pasa de 2 MiB → too_large
    let comillas = "\"".repeat(MIB as usize);
    let mut s = setup(Some(&comillas));
    let mut c = connect(&s.hub);
    c.hello("m1", Some(true)).await;
    assert!(c.sync().await.is_empty());
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    s.no_events();
    s.hub.broadcast_clip(&comillas);
    // too_large: no se envía ni se cierra
    assert_eq!(
        clips_antes_de_fin(&s.hub, &mut [&mut c]).await,
        Vec::<Vec<String>>::from([vec![]])
    );
}

#[tokio::test]
async fn clip_con_hash_erroneo_cierra_con_protocol_error() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    c.send(ControlMessage::Clip {
        id: "c".repeat(32),
        text: "hola".into(),
        hash: sha(b"otro"),
    })
    .await;
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "protocol_error"})
    );
    c.closed().await;
}

#[tokio::test]
async fn clip_de_mas_de_1_mib_cierra_con_protocol_error() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    c.send(clip(&"a".repeat(MIB as usize + 1))).await;
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "protocol_error"})
    );
    c.closed().await;
}

#[tokio::test]
async fn trama_que_no_es_un_mensaje_1_valido_cierra_sin_eventos() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    // un mensaje de control en claro en lugar del mensaje 1 del handshake
    c.send(clip("hola")).await;
    c.closed().await;
    // nunca llegó a estar conectado: no hay evento de conexión ni de desconexión
    s.no_events();
}

#[tokio::test]
async fn hello_tras_el_handshake_cierra_con_protocol_error() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    // el hello de la fase 1 ya no es un mensaje de control
    c.send_payload(&hello_fase_1("m1")).await;
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "protocol_error"})
    );
    c.closed().await;
}

#[tokio::test]
async fn hello_duplicado_reemplaza_la_sesion_vieja() {
    let mut s = setup(None);
    let mut a = connect(&s.hub);
    a.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    let mut b = connect(&s.hub);
    b.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(2, "m1", "wifi"));
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "replaced"})
    );
    a.closed().await;
    assert!(b.sync().await.is_empty(), "la sesión nueva sigue viva");
    // la nueva comparte el anti-rebote del dispositivo
    b.send(clip("z")).await;
    assert_eq!(
        s.event().await,
        json!({"type": "clipReceived", "sessionId": 2, "text": "z"})
    );
    s.hub.broadcast_clip("z");
    assert_eq!(
        clips_antes_de_fin(&s.hub, &mut [&mut b]).await,
        Vec::<Vec<String>>::from([vec![]])
    );
}

#[tokio::test]
async fn serve_tcp_desde_localhost_es_usb() {
    let mut s = setup(None);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hub = s.hub.clone();
    tokio::spawn(async move { hub.serve_tcp(listener).await });
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut c = over(tcp);
    c.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "usb"));
}

// --- latido ---

#[tokio::test(start_paused = true)]
async fn latido_30s_sin_trafico_desconecta() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    let t0 = Instant::now();
    s.event().await;
    let e = timeout(Duration::from_secs(60), s.events.recv())
        .await
        .unwrap()
        .unwrap();
    let dt = t0.elapsed();
    assert_eq!(
        js(&e),
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "heartbeat_timeout"})
    );
    assert!(
        dt >= Duration::from_secs(30) && dt <= Duration::from_secs(40),
        "{dt:?}"
    );
    // ping a los 10 y 20 s; a los 30 s se cierra
    let mut pings = 0;
    while let Some(d) = c.rx.recv().await {
        assert_eq!(d, Decoded::Control(ControlMessage::Ping));
        pings += 1;
    }
    assert_eq!(pings, 2);
}

#[tokio::test(start_paused = true)]
async fn latido_con_trafico_no_desconecta() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    for _ in 0..6 {
        tokio::time::sleep(Duration::from_secs(10)).await;
        c.send(ControlMessage::Pong).await;
    }
    assert!(c.sync().await.is_empty());
    s.no_events();
}

// --- archivos entrantes ---

/// Envía un archivo completo desde el cliente y devuelve los file_ack y el file_result recibidos.
async fn enviar_archivo<W: AsyncWrite + Unpin>(
    c: &mut Client<W>,
    name: &str,
    data: &[u8],
    hash: &str,
) -> Vec<ControlMessage> {
    c.send(ControlMessage::FileStart {
        transfer_id: TID.into(),
        name: name.into(),
        size: data.len() as u64,
        mime: "application/octet-stream".into(),
    })
    .await;
    for chunk in data.chunks(FILE_CHUNK_BYTES) {
        c.send_data(TID, chunk).await;
    }
    c.send(ControlMessage::FileEnd {
        transfer_id: TID.into(),
        sha256: hash.into(),
    })
    .await;
    let mut v = Vec::new();
    loop {
        let m = c.ctrl().await;
        let fin = matches!(m, ControlMessage::FileResult { .. });
        v.push(m);
        if fin {
            return v;
        }
    }
}

fn ack(received: u64) -> ControlMessage {
    ControlMessage::FileAck {
        transfer_id: TID.into(),
        received,
    }
}

#[tokio::test]
async fn archivo_entrante_se_guarda_en_download_dir() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let n = 5 * MIB + 7;
    let data = datos(n as usize);
    let msgs = enviar_archivo(&mut c, "foto.bin", &data, &sha(&data)).await;
    let marcas = [1_081_344, 2_113_536, 3 * MIB, 4_227_072, n];
    let mut esperado: Vec<ControlMessage> = marcas.iter().map(|&b| ack(b)).collect();
    esperado.push(ack(n)); // ack final en file_end
    esperado.push(ControlMessage::FileResult {
        transfer_id: TID.into(),
        ok: true,
        error: None,
    });
    assert_eq!(msgs, esperado);

    let ev = s.transfer_until_end().await;
    let destino = s.dir.path().join("foto.bin");
    let mut esp = vec![transfer(TID, "in", "foto.bin", n, 0, "active")];
    esp.extend(
        marcas
            .iter()
            .map(|&b| transfer(TID, "in", "foto.bin", n, b, "active")),
    );
    esp.push(with(
        transfer(TID, "in", "foto.bin", n, n, "done"),
        "location",
        json!(destino.to_string_lossy()),
    ));
    assert_eq!(ev, esp);
    assert_eq!(std::fs::read(&destino).unwrap(), data);
    assert_eq!(s.files(), vec!["foto.bin"]);
}

#[tokio::test]
async fn archivo_entrante_vacio_y_multiplo_exacto_de_48k() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    for (i, n) in [0usize, FILE_CHUNK_BYTES * 3].into_iter().enumerate() {
        let data = datos(n);
        let id = format!("{i:032x}");
        c.send(ControlMessage::FileStart {
            transfer_id: id.clone(),
            name: format!("f{i}.bin"),
            size: n as u64,
            mime: "x/y".into(),
        })
        .await;
        for chunk in data.chunks(FILE_CHUNK_BYTES) {
            c.send_data(&id, chunk).await;
        }
        c.send(ControlMessage::FileEnd {
            transfer_id: id.clone(),
            sha256: sha(&data),
        })
        .await;
        assert_eq!(
            c.ctrl().await,
            ControlMessage::FileAck {
                transfer_id: id.clone(),
                received: n as u64
            }
        );
        assert_eq!(
            c.ctrl().await,
            ControlMessage::FileResult {
                transfer_id: id.clone(),
                ok: true,
                error: None
            }
        );
        let ev = s.transfer_until_end().await;
        assert_eq!(ev.last().unwrap()["state"], "done");
        assert_eq!(
            std::fs::read(s.dir.path().join(format!("f{i}.bin"))).unwrap(),
            data
        );
    }
}

#[tokio::test]
async fn archivo_entrante_con_hash_erroneo_no_deja_nada() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let data = datos(1000);
    let msgs = enviar_archivo(&mut c, "a.txt", &data, &sha(b"otra cosa")).await;
    assert_eq!(
        msgs,
        vec![
            ack(1000),
            ControlMessage::FileResult {
                transfer_id: TID.into(),
                ok: false,
                error: Some("checksum_mismatch".into())
            }
        ]
    );
    let ev = s.transfer_until_end().await;
    assert_eq!(
        ev.last().unwrap(),
        &with(
            transfer(TID, "in", "a.txt", 1000, 1000, "failed"),
            "error",
            json!("checksum_mismatch")
        )
    );
    assert!(s.files().is_empty());
    assert!(c.sync().await.is_empty(), "la sesión sigue");
}

#[tokio::test]
async fn archivo_entrante_con_nombre_hostil_queda_dentro() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let data = datos(10);
    enviar_archivo(&mut c, "../../fuera.txt", &data, &sha(&data)).await;
    s.transfer_until_end().await;
    assert_eq!(s.files(), vec!["fuera.txt"]);
}

#[tokio::test]
async fn corte_a_mitad_borra_part_y_emite_failed() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let n = 2 * MIB;
    c.send(ControlMessage::FileStart {
        transfer_id: TID.into(),
        name: "x.bin".into(),
        size: n,
        mime: "x/y".into(),
    })
    .await;
    let data = datos(22 * FILE_CHUNK_BYTES);
    for chunk in data.chunks(FILE_CHUNK_BYTES) {
        c.send_data(TID, chunk).await;
    }
    assert_eq!(c.ctrl().await, ack(1_081_344));
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "x.bin", n, 0, "active")
    );
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "x.bin", n, 1_081_344, "active")
    );
    assert_eq!(s.files(), vec!["x.bin.part"]);
    c.cut().await;
    assert_eq!(
        s.event().await,
        with(
            transfer(TID, "in", "x.bin", n, 1_081_344, "failed"),
            "error",
            json!("link_closed")
        )
    );
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "link_closed"})
    );
    assert!(s.files().is_empty());
}

/// Cuenta las tramas que escribe el PC (u16 big-endian + datos) sin poder leerlas: van cifradas.
#[derive(Clone, Copy, Default)]
struct Tramas {
    /// tramas ya escritas enteras
    hechas: usize,
    cabecera: [u8; 2],
    bytes_cabecera: usize,
    quedan: usize,
}

impl Tramas {
    fn avanza(&mut self, b: u8) {
        if self.bytes_cabecera < 2 {
            self.cabecera[self.bytes_cabecera] = b;
            self.bytes_cabecera += 1;
            if self.bytes_cabecera == 2 {
                self.quedan = u16::from_be_bytes(self.cabecera) as usize;
            }
        } else {
            self.quedan -= 1;
        }
        if self.bytes_cabecera == 2 && self.quedan == 0 {
            *self = Tramas {
                hechas: self.hechas + 1,
                ..Tramas::default()
            };
        }
    }
}

/// Enlace que, al empezar a escribir la trama número `n` del PC (la 0 es el mensaje 2 del
/// handshake), falla o (con `true`) se queda bloqueado para siempre, como un TCP medio abierto
/// con el búfer lleno. Las tramas anteriores pasan enteras.
struct FallaAlEscribir {
    inner: DuplexStream,
    n: usize,
    bloquear: bool,
    tramas: Tramas,
}

impl FallaAlEscribir {
    fn new(inner: DuplexStream, n: usize, bloquear: bool) -> Self {
        FallaAlEscribir {
            inner,
            n,
            bloquear,
            tramas: Tramas::default(),
        }
    }

    /// Bytes de `buf` que caben antes de la trama `n`.
    fn permitidos(&self, buf: &[u8]) -> usize {
        let mut t = self.tramas;
        let mut k = 0;
        for &b in buf {
            if t.hechas == self.n && t.bytes_cabecera == 0 {
                break;
            }
            t.avanza(b);
            k += 1;
        }
        k
    }
}

impl AsyncRead for FallaAlEscribir {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for FallaAlEscribir {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let k = self.permitidos(buf);
        if k == 0 && !buf.is_empty() {
            if self.bloquear {
                return Poll::Pending;
            }
            return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
        }
        let res = Pin::new(&mut self.inner).poll_write(cx, &buf[..k]);
        if let Poll::Ready(Ok(escritos)) = res {
            for &b in &buf[..escritos] {
                self.tramas.avanza(b);
            }
        }
        res
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[tokio::test]
async fn si_cae_antes_de_file_result_se_borra_el_archivo_guardado() {
    let mut s = setup(None);
    let (a, b) = tokio::io::duplex(256 * 1024);
    // la sesión cae tras `finish()` y antes de confirmar: tramas 0 = mensaje 2, 1 = file_ack,
    // 2 = file_result
    s.hub
        .accept_stream(FallaAlEscribir::new(b, 2, false), Transport::Wifi);
    let mut c = over(a);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let data = datos(1000);
    c.send(ControlMessage::FileStart {
        transfer_id: TID.into(),
        name: "a.txt".into(),
        size: 1000,
        mime: "x/y".into(),
    })
    .await;
    c.send_data(TID, &data).await;
    c.send(ControlMessage::FileEnd {
        transfer_id: TID.into(),
        sha256: sha(&data),
    })
    .await;
    assert_eq!(c.ctrl().await, ack(1000));
    c.closed().await;
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "a.txt", 1000, 0, "active")
    );
    assert_eq!(
        s.event().await,
        with(
            transfer(TID, "in", "a.txt", 1000, 1000, "failed"),
            "error",
            json!("link_closed")
        )
    );
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "link_closed"})
    );
    assert!(s.files().is_empty(), "{:?}", s.files());
}

#[tokio::test]
async fn datos_rezagados_tras_cancelar_se_descartan() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    c.send(ControlMessage::FileStart {
        transfer_id: TID.into(),
        name: "a.txt".into(),
        size: 10,
        mime: "x/y".into(),
    })
    .await;
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "a.txt", 10, 0, "active")
    );
    s.hub.cancel_transfer(TID);
    assert_eq!(
        c.ctrl().await,
        ControlMessage::FileCancel {
            transfer_id: TID.into(),
            reason: "cancelled".into()
        }
    );
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "a.txt", 10, 0, "cancelled")
    );
    c.send_data(TID, &datos(10)).await;
    c.send(ControlMessage::FileEnd {
        transfer_id: TID.into(),
        sha256: sha(&datos(10)),
    })
    .await;
    assert!(
        c.sync().await.is_empty(),
        "lo rezagado se descarta sin cerrar"
    );
    assert!(s.files().is_empty());
    // un id nunca visto sí es un error de protocolo
    c.send_data(&"f".repeat(32), b"x").await;
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "protocol_error"})
    );
}

// --- archivos salientes ---

fn archivo_local(dir: &Path, name: &str, data: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, data).unwrap();
    p
}

/// Recibe exactamente `n` tramas de datos de `id` y devuelve sus bytes.
async fn recibir_datos<W: AsyncWrite + Unpin>(c: &mut Client<W>, id: &str, n: usize) -> Vec<u8> {
    let id: [u8; 16] = hex::decode(id).unwrap().try_into().unwrap();
    let mut v = Vec::new();
    for _ in 0..n {
        match c.recv().await {
            Some(Decoded::Data { transfer_id, bytes }) => {
                assert_eq!(transfer_id, id);
                assert_eq!(bytes.len(), FILE_CHUNK_BYTES);
                v.extend(bytes);
            }
            other => panic!("se esperaban datos: {other:?}"),
        }
    }
    v
}

#[tokio::test]
async fn send_file_sin_movil_devuelve_no_peer() {
    let s = setup(None);
    let src = tempfile::tempdir().unwrap();
    let p = archivo_local(src.path(), "a.txt", b"hola");
    assert_eq!(s.hub.send_file(&p), Err("no_peer".to_string()));
}

#[tokio::test]
async fn send_file_de_un_archivo_inexistente_es_read_error() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    assert_eq!(
        s.hub.send_file(Path::new("/no/existe/x.bin")),
        Err("read_error".to_string())
    );
}

#[tokio::test]
async fn archivo_saliente_respeta_ventana_de_2_mib() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let src = tempfile::tempdir().unwrap();
    let n = 5 * MIB + 7;
    let data = datos(n as usize);
    let p = archivo_local(src.path(), "grande.bin", &data);
    let id = s.hub.send_file(&p).unwrap();
    assert!(
        id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "{id}"
    );
    assert_eq!(
        s.event().await,
        transfer(&id, "out", "grande.bin", n, 0, "queued")
    );
    assert_eq!(
        s.event().await,
        transfer(&id, "out", "grande.bin", n, 0, "active")
    );
    assert_eq!(
        c.ctrl().await,
        ControlMessage::FileStart {
            transfer_id: id.clone(),
            name: "grande.bin".into(),
            size: n,
            mime: "application/octet-stream".into()
        }
    );

    // sin confirmaciones salen exactamente 42 trozos (2 064 384 bytes)
    let mut recibido = recibir_datos(&mut c, &id, 42).await;
    assert!(c.sync().await.is_empty(), "nada más sin ack");
    // con 1 MiB confirmado caben 22 más (hasta 3 MiB enviados)
    c.send(ControlMessage::FileAck {
        transfer_id: id.clone(),
        received: MIB,
    })
    .await;
    recibido.extend(recibir_datos(&mut c, &id, 22).await);
    assert_eq!(recibido.len() as u64, 3 * MIB);
    assert!(c.sync().await.is_empty(), "ventana llena otra vez");
    assert_eq!(
        s.event().await,
        transfer(&id, "out", "grande.bin", n, MIB, "active")
    );

    // a partir de aquí se confirma cada trozo hasta file_end
    loop {
        c.send(ControlMessage::FileAck {
            transfer_id: id.clone(),
            received: recibido.len() as u64,
        })
        .await;
        match c.recv().await {
            Some(Decoded::Data { bytes, .. }) => recibido.extend(bytes),
            Some(Decoded::Control(ControlMessage::FileEnd {
                transfer_id,
                sha256,
            })) => {
                assert_eq!(transfer_id, id);
                assert_eq!(sha256, sha(&data));
                break;
            }
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(recibido, data);
    c.send(ControlMessage::FileResult {
        transfer_id: id.clone(),
        ok: true,
        error: None,
    })
    .await;
    let ev = s.transfer_until_end().await;
    assert_eq!(
        ev.last().unwrap(),
        &transfer(&id, "out", "grande.bin", n, n, "done")
    );
}

#[tokio::test]
async fn archivo_saliente_vacio() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let src = tempfile::tempdir().unwrap();
    let id = s
        .hub
        .send_file(&archivo_local(src.path(), "vacio.txt", b""))
        .unwrap();
    assert!(matches!(
        c.ctrl().await,
        ControlMessage::FileStart { size: 0, .. }
    ));
    assert_eq!(
        c.ctrl().await,
        ControlMessage::FileEnd {
            transfer_id: id.clone(),
            sha256: sha(b"")
        }
    );
    c.send(ControlMessage::FileAck {
        transfer_id: id.clone(),
        received: 0,
    })
    .await;
    c.send(ControlMessage::FileResult {
        transfer_id: id.clone(),
        ok: true,
        error: None,
    })
    .await;
    let ev = s.transfer_until_end().await;
    assert_eq!(
        ev.last().unwrap(),
        &transfer(&id, "out", "vacio.txt", 0, 0, "done")
    );
}

#[tokio::test]
async fn archivos_salientes_van_en_cola_y_a_la_sesion_mas_reciente() {
    let mut s = setup(None);
    let mut a = connect(&s.hub);
    a.hello("m1", Some(false)).await;
    s.event().await;
    let mut b = connect(&s.hub);
    b.hello("m2", Some(false)).await;
    s.event().await;
    let src = tempfile::tempdir().unwrap();
    let id1 = s
        .hub
        .send_file(&archivo_local(src.path(), "uno.txt", b"1"))
        .unwrap();
    let id2 = s
        .hub
        .send_file(&archivo_local(src.path(), "dos.txt", b"22"))
        .unwrap();
    assert!(
        matches!(b.ctrl().await, ControlMessage::FileStart { transfer_id, .. } if transfer_id == id1)
    );
    assert!(matches!(b.recv().await, Some(Decoded::Data { bytes, .. }) if bytes == b"1"));
    assert!(matches!(b.ctrl().await, ControlMessage::FileEnd { .. }));
    // el segundo espera en cola hasta el resultado del primero
    assert!(b.sync().await.is_empty());
    b.send(ControlMessage::FileResult {
        transfer_id: id1.clone(),
        ok: false,
        error: None,
    })
    .await;
    assert!(
        matches!(b.ctrl().await, ControlMessage::FileStart { transfer_id, .. } if transfer_id == id2)
    );
    assert!(
        a.sync().await.is_empty(),
        "a la otra sesión no le llega nada"
    );

    let mut ev = Vec::new();
    for _ in 0..5 {
        ev.push(s.event().await);
    }
    assert_eq!(
        ev,
        vec![
            transfer(&id1, "out", "uno.txt", 1, 0, "queued"),
            transfer(&id2, "out", "dos.txt", 2, 0, "queued"),
            transfer(&id1, "out", "uno.txt", 1, 0, "active"),
            with(
                transfer(&id1, "out", "uno.txt", 1, 0, "failed"),
                "error",
                json!("remote_error")
            ),
            transfer(&id2, "out", "dos.txt", 2, 0, "active"),
        ]
    );
}

#[tokio::test]
async fn cancelar_saliente_envia_file_cancel() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let src = tempfile::tempdir().unwrap();
    let id = s
        .hub
        .send_file(&archivo_local(
            src.path(),
            "g.bin",
            &datos(3 * MIB as usize),
        ))
        .unwrap();
    assert!(matches!(c.ctrl().await, ControlMessage::FileStart { .. }));
    recibir_datos(&mut c, &id, 42).await;
    s.hub.cancel_transfer(&id);
    assert_eq!(
        c.ctrl().await,
        ControlMessage::FileCancel {
            transfer_id: id.clone(),
            reason: "cancelled".into()
        }
    );
    let ev = s.transfer_until_end().await;
    assert_eq!(
        ev.last().unwrap(),
        &transfer(&id, "out", "g.bin", 3 * MIB, 0, "cancelled")
    );
    assert!(c.sync().await.is_empty(), "la sesión sigue");
}

#[tokio::test]
async fn cierre_con_archivos_salientes_los_marca_failed() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let src = tempfile::tempdir().unwrap();
    let id1 = s
        .hub
        .send_file(&archivo_local(
            src.path(),
            "a.bin",
            &datos(3 * MIB as usize),
        ))
        .unwrap();
    let id2 = s
        .hub
        .send_file(&archivo_local(src.path(), "b.bin", b"b"))
        .unwrap();
    assert!(matches!(c.ctrl().await, ControlMessage::FileStart { .. }));
    c.cut().await;
    let mut ev = Vec::new();
    loop {
        let e = s.event().await;
        let fin = e["type"] == "peerDisconnected";
        ev.push(e);
        if fin {
            break;
        }
    }
    // queued se emite al llamar a send_file: nunca hay un failed sin queued antes
    assert_eq!(ev[0], transfer(&id1, "out", "a.bin", 3 * MIB, 0, "queued"));
    assert_eq!(ev[1], transfer(&id2, "out", "b.bin", 1, 0, "queued"));
    let n = ev.len();
    assert_eq!(
        ev[n - 3],
        with(
            transfer(&id1, "out", "a.bin", 3 * MIB, 0, "failed"),
            "error",
            json!("link_closed")
        )
    );
    assert_eq!(
        ev[n - 2],
        with(
            transfer(&id2, "out", "b.bin", 1, 0, "failed"),
            "error",
            json!("link_closed")
        )
    );
    assert_eq!(
        ev[n - 1],
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "link_closed"})
    );
}

// --- ronda de correcciones 1: clips no entregados y reconexión ---

#[tokio::test]
async fn clip_que_no_se_pudo_escribir_llega_al_reconectar() {
    let mut s = setup(None);
    let (a, b) = tokio::io::duplex(256 * 1024);
    // tramas 0 = mensaje 2, 1 = el clip
    s.hub
        .accept_stream(FallaAlEscribir::new(b, 1, false), Transport::Wifi);
    let mut c = over(a);
    c.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    s.copy("texto");
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "link_closed"})
    );
    c.closed().await;

    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    assert!(matches!(c.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));
}

#[tokio::test]
async fn reconexion_con_la_sesion_vieja_medio_abierta_reenvia_el_texto_actual() {
    let mut s = setup(None);
    let mut viejo = connect(&s.hub);
    viejo.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    // el clip "sale" por la sesión vieja, pero el móvil ya no lo recibe (TCP medio abierto)
    s.copy("texto");
    assert!(matches!(viejo.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));

    let mut nuevo = connect(&s.hub);
    nuevo.hello("m1", Some(false)).await;
    assert!(matches!(nuevo.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));
    assert_eq!(s.event().await, peer_connected(2, "m1", "wifi"));
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "replaced"})
    );
}

#[tokio::test(start_paused = true)]
async fn tras_caer_por_latido_la_reconexion_recibe_el_texto_actual() {
    let mut s = setup(None);
    let mut viejo = connect(&s.hub);
    viejo.hello("m1", Some(false)).await;
    s.event().await;
    s.copy("texto");
    assert!(matches!(viejo.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));
    let e = timeout(Duration::from_secs(60), s.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        js(&e),
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "heartbeat_timeout"})
    );

    let mut nuevo = connect(&s.hub);
    nuevo.hello("m1", Some(false)).await;
    assert!(matches!(nuevo.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));
}

#[tokio::test]
async fn device_id_de_mas_de_128_bytes_cierra_el_handshake() {
    // los dos emparejados: el rechazo es por el límite, no por la autorización
    let (a, b) = ("a".repeat(128), "b".repeat(129));
    let mut s = setup_with(None, &[&a, &b]);
    let mut ok = connect(&s.hub);
    ok.hello(&a, Some(false)).await;
    assert_eq!(s.event().await["deviceId"], json!(key_hex(&a)));

    let mut c = connect(&s.hub);
    assert_eq!(c.handshake(&client_hello(&b, Some(false))).await, None);
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn device_name_se_recorta_a_64_caracteres() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    let hello = ClientHello {
        device_name: "ñ".repeat(100),
        ..client_hello("m1", Some(false))
    };
    assert_eq!(c.handshake(&hello).await, Some(server_hello()));
    assert_eq!(s.event().await["deviceName"], json!("ñ".repeat(64)));
}

// --- ronda de correcciones 2: una sesión vieja que cae tarde no borra lo de la nueva ---

#[tokio::test(start_paused = true)]
async fn sesion_vieja_que_cae_tarde_no_borra_la_sincronia_de_la_nueva() {
    let mut s = setup(None);
    // la vieja se queda bloqueada al escribir un clip: no verá su Close("replaced")
    let (a, b) = tokio::io::duplex(256 * 1024);
    // tramas 0 = mensaje 2, 1 = el clip
    s.hub
        .accept_stream(FallaAlEscribir::new(b, 1, true), Transport::Wifi);
    let mut viejo = over(a);
    viejo.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    s.copy("pc");

    // la nueva llega con un texto más reciente del móvil: el PC cede y marca "pc"
    let mut nuevo = connect(&s.hub);
    nuevo.hello("m1", Some(true)).await;
    assert_eq!(s.event().await, peer_connected(2, "m1", "wifi"));
    assert_eq!(
        s.event().await,
        json!({"type": "localClipSuperseded", "text": "pc"})
    );
    nuevo.send(clip("móvil")).await;
    assert_eq!(
        s.event().await,
        json!({"type": "clipReceived", "sessionId": 2, "text": "móvil"})
    );

    // 30 s después la vieja cae por el plazo de escritura; la nueva sigue con tráfico
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_secs(10)).await;
        nuevo.send(ControlMessage::Pong).await;
    }
    let e = timeout(Duration::from_secs(60), s.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        js(&e),
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "heartbeat_timeout"})
    );

    // las marcas de la nueva siguen: el texto ya sincronizado no vuelve a salir hacia ella
    s.hub.broadcast_clip("móvil");
    assert_eq!(
        clips_antes_de_fin(&s.hub, &mut [&mut nuevo]).await,
        Vec::<Vec<String>>::from([vec![]])
    );
    s.no_events();
}

// --- pares hostiles en la LAN (M2) ---

#[tokio::test]
async fn como_mucho_8_sesiones_sin_saludo_y_la_novena_se_cierra() {
    let mut s = setup(None);
    let mut sin_saludo: Vec<_> = (0..8).map(|_| connect(&s.hub)).collect();
    let mut novena = connect(&s.hub);
    novena.closed().await;
    // las 8 siguen abiertas: una saluda con normalidad
    sin_saludo[0].hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    // ya saludó: deja hueco para otra conexión nueva
    let mut otra = connect(&s.hub);
    otra.hello("m2", Some(false)).await;
    assert_eq!(
        js(&timeout(WAIT, s.events.recv()).await.unwrap().unwrap())["type"],
        "peerConnected"
    );
    assert!(
        sin_saludo[1].rx.try_recv().is_err(),
        "las demás siguen esperando"
    );
}

#[tokio::test]
async fn al_cerrarse_una_sesion_sin_saludo_queda_su_hueco() {
    let mut s = setup(None);
    let mut sin_saludo: Vec<_> = (0..8).map(|_| connect(&s.hub)).collect();
    // una trama que no es un mensaje 1 válido la cierra y libera su hueco
    sin_saludo[0].send(clip("hola")).await;
    sin_saludo[0].closed().await;
    // el Hub quita la sesión al recibir su Closed: se reintenta hasta que haya hueco
    let _nueva = timeout(WAIT, async {
        loop {
            let mut c = connect(&s.hub);
            if let Some(answer) = c.handshake(&client_hello("m1", Some(false))).await {
                assert_eq!(answer, server_hello());
                return c;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("no se liberó el hueco");
    let e = s.event().await;
    assert_eq!(
        (e["type"].as_str(), e["deviceId"].as_str()),
        (Some("peerConnected"), Some(key_hex("m1").as_str()))
    );
}

#[tokio::test(start_paused = true)]
async fn sin_mensaje_1_completo_en_30_s_se_cierra_aunque_lleguen_bytes() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    // una trama anunciada de 65 535 bytes que llega byte a byte y nunca se completa
    c.w.get_mut().write_all(&[0xff, 0xff]).await.unwrap();
    for _ in 0..4 {
        let _ = c.w.get_mut().write_all(b" ").await;
        tokio::time::sleep(Duration::from_secs(9)).await;
    }
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn antes_del_handshake_un_mensaje_de_mas_de_64_kib_se_rechaza() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    // un mensaje de control de más de 64 KiB en claro: su primera trama, de tamaño máximo, no
    // es un mensaje 1 válido
    c.send(clip(&"x".repeat(70_000))).await;
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn tras_el_handshake_un_mensaje_de_mas_de_64_kib_si_vale() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let texto = "y".repeat(500_000);
    c.send(clip(&texto)).await;
    let e = s.event().await;
    assert_eq!(e["type"], "clipReceived");
    assert_eq!(e["text"].as_str().map(str::len), Some(500_000));
}

#[tokio::test]
async fn nombre_de_archivo_entrante_se_recorta_a_255_caracteres() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let data = datos(10);
    let nombre = format!("{}.txt", "é".repeat(1000));
    enviar_archivo(&mut c, &nombre, &data, &sha(&data)).await;
    let v = s.transfer_until_end().await;
    for e in &v {
        let name = e["name"].as_str().unwrap();
        assert_eq!(name.chars().count(), 255, "{e}");
        assert!(name.chars().all(|ch| ch == 'é'));
    }
    assert_eq!(v.last().unwrap()["state"], "done");
    // el archivo se guarda con el nombre saneado de siempre
    assert_eq!(s.files().len(), 1);
}

// --- canal cifrado y emparejamiento (fase 2) ---

/// Mensaje 1 con el token del QR.
fn con_token(device_id: &str, token: &str) -> ClientHello {
    ClientHello {
        pairing_token: Some(token.into()),
        ..client_hello(device_id, Some(false))
    }
}

#[tokio::test]
async fn public_key_es_la_del_pc() {
    let s = setup(None);
    assert_eq!(s.hub.public_key(), pc_keys().public);
}

#[tokio::test]
async fn peer_connected_lleva_la_clave_del_movil() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    let e = s.event().await;
    assert_eq!(e["type"], "peerConnected");
    assert_eq!(e["deviceId"], json!(hex::encode(test_keys("m1").public)));
    // no el deviceId que declara el móvil
    assert_ne!(e["deviceId"], json!("m1"));
}

#[tokio::test]
async fn no_emparejado_recibe_not_paired_y_no_hay_eventos() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&client_hello("m9", Some(false))).await,
        Some(ServerHello::reject(RejectReason::NotPaired))
    );
    c.closed().await;
    s.no_events();
    // un token que no es el del QR tampoco empareja
    s.hub.start_pairing();
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&con_token("m9", "AAAAAAAAAAAAAAAAAAAAAA"))
            .await,
        Some(ServerHello::reject(RejectReason::NotPaired))
    );
    c.closed().await;
    s.no_events();
    assert!(!s.paired_json().contains(&key_hex("m9")));
}

#[tokio::test]
async fn token_valido_empareja_guarda_y_emite_device_paired() {
    let mut s = setup(None);
    let offer = s.hub.start_pairing();
    assert_eq!(s.hub.pairing_offer(), Some(offer.clone()));
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&con_token("m3", &offer.token)).await,
        Some(server_hello())
    );
    assert_eq!(s.event().await, device_paired("m3"));
    assert_eq!(s.event().await, peer_connected(1, "m3", "wifi"));
    assert!(
        s.paired_json().contains(&key_hex("m3")),
        "{}",
        s.paired_json()
    );
    let m3 = s
        .hub
        .paired_devices()
        .into_iter()
        .find(|d| d.public_key == key_hex("m3"))
        .expect("m3 emparejado");
    assert_eq!(
        (m3.device_id.as_str(), m3.device_name.as_str()),
        ("m3", "Móvil m3")
    );
    assert_eq!(s.hub.pairing_offer(), None, "el token ya se usó");

    // reconectar sin token → aceptado
    c.cut().await;
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "link_closed"})
    );
    let mut c = connect(&s.hub);
    c.hello("m3", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(2, "m3", "wifi"));
}

#[tokio::test]
async fn token_usado_por_otro_movil_da_pairing_expired() {
    let mut s = setup(None);
    let offer = s.hub.start_pairing();
    let mut c3 = connect(&s.hub);
    assert_eq!(
        c3.handshake(&con_token("m3", &offer.token)).await,
        Some(server_hello())
    );
    assert_eq!(s.event().await, device_paired("m3"));
    assert_eq!(s.event().await, peer_connected(1, "m3", "wifi"));

    let mut c4 = connect(&s.hub);
    assert_eq!(
        c4.handshake(&con_token("m4", &offer.token)).await,
        Some(ServerHello::reject(RejectReason::PairingExpired))
    );
    c4.closed().await;
    s.no_events();
    let claves: Vec<String> = s
        .hub
        .paired_devices()
        .into_iter()
        .map(|d| d.public_key)
        .collect();
    assert!(claves.contains(&key_hex("m3")));
    assert!(!claves.contains(&key_hex("m4")));
    assert!(c3.sync().await.is_empty(), "m3 sigue conectado");
}

#[tokio::test]
async fn emparejado_con_token_vigente_lo_consume_y_cierra_la_oferta() {
    let mut s = setup(None);
    let offer = s.hub.start_pairing();
    let mut c = connect(&s.hub);
    // m1 ya estaba emparejado; vuelve a escanear el QR con otro nombre e id
    let hello = ClientHello {
        device_id: "m1-nuevo".into(),
        device_name: "Móvil m1".into(),
        pairing_token: Some(offer.token.clone()),
        will_send_clip: Some(false),
        v: 2,
    };
    assert_eq!(
        c.handshake_to(&test_keys("m1"), &pc_keys().public, &hello)
            .await,
        Some(server_hello())
    );
    assert_eq!(s.event().await, device_paired("m1"));
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    assert_eq!(s.hub.pairing_offer(), None);
    let m1 = s
        .hub
        .paired_devices()
        .into_iter()
        .find(|d| d.public_key == key_hex("m1"))
        .unwrap();
    assert_eq!(m1.device_id, "m1-nuevo");
    assert_eq!(
        m1.paired_at_ms, 1,
        "conserva la fecha del primer emparejamiento"
    );
    assert!(s.paired_json().contains("m1-nuevo"));
}

#[tokio::test]
async fn emparejado_con_token_caducado_o_ajeno_entra_sin_device_paired() {
    let mut s = setup(None);
    let offer = s.hub.start_pairing();
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&con_token("m1", "AAAAAAAAAAAAAAAAAAAAAA"))
            .await,
        Some(server_hello())
    );
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    assert_eq!(
        s.hub.pairing_offer(),
        Some(offer),
        "la oferta sigue abierta"
    );
}

#[tokio::test]
async fn cancelar_el_emparejamiento_invalida_el_token() {
    let mut s = setup(None);
    let offer = s.hub.start_pairing();
    s.hub.cancel_pairing();
    assert_eq!(s.hub.pairing_offer(), None);
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&con_token("m3", &offer.token)).await,
        Some(ServerHello::reject(RejectReason::NotPaired))
    );
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn token_valido_sin_poder_guardar_acepta_y_queda_en_memoria() {
    let mut s = setup(None);
    // paired.json pasa a ser una carpeta: guardarlo falla
    let ruta = s.data.path().join("paired.json");
    std::fs::remove_file(&ruta).unwrap();
    std::fs::create_dir(&ruta).unwrap();
    let offer = s.hub.start_pairing();
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&con_token("m3", &offer.token)).await,
        Some(server_hello())
    );
    assert_eq!(s.event().await, device_paired("m3"));
    assert_eq!(s.event().await, peer_connected(1, "m3", "wifi"));
    assert!(s
        .hub
        .paired_devices()
        .iter()
        .any(|d| d.public_key == key_hex("m3")));
    c.cut().await;
    s.event().await;
    let mut c = connect(&s.hub);
    c.hello("m3", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(2, "m3", "wifi"));
    // olvidarlo también funciona aunque no llegara a guardarse
    assert!(s.hub.forget_device(&key_hex("m3")));
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 2, "reason": "forgotten"})
    );
}

#[tokio::test]
async fn olvidar_cierra_la_sesion_y_rechaza_la_reconexion() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(1, "m1", "wifi"));
    let mut otro = connect(&s.hub);
    otro.hello("m2", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(2, "m2", "wifi"));

    assert!(s.hub.forget_device(&key_hex("m1")));
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "forgotten"})
    );
    c.closed().await;
    assert!(!s.paired_json().contains(&key_hex("m1")));
    assert!(s.paired_json().contains(&key_hex("m2")));
    assert!(!s.hub.forget_device(&key_hex("m1")), "ya no estaba");

    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&client_hello("m1", Some(false))).await,
        Some(ServerHello::reject(RejectReason::NotPaired))
    );
    c.closed().await;
    s.no_events();
    assert!(otro.sync().await.is_empty(), "m2 sigue conectado");
}

#[tokio::test]
async fn olvidar_borra_la_sincronia_del_dispositivo() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    s.copy("texto");
    assert!(matches!(c.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));
    assert!(s.hub.forget_device(&key_hex("m1")));
    s.event().await;
    // vuelve a emparejarse: el texto actual se le envía de nuevo
    let offer = s.hub.start_pairing();
    let mut c = connect(&s.hub);
    assert_eq!(
        c.handshake(&con_token("m1", &offer.token)).await,
        Some(server_hello())
    );
    assert!(matches!(c.ctrl().await, ControlMessage::Clip { text, .. } if text == "texto"));
}

#[tokio::test]
async fn clave_de_pc_equivocada_cierra_sin_eventos() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    let otra = test_keys("otro-pc");
    assert_eq!(
        c.handshake_to(
            &test_keys("m1"),
            &otra.public,
            &client_hello("m1", Some(false))
        )
        .await,
        None
    );
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn trama_alterada_a_mitad_de_archivo_cierra_y_borra_el_parcial() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    let n = 2 * MIB;
    c.send(ControlMessage::FileStart {
        transfer_id: TID.into(),
        name: "x.bin".into(),
        size: n,
        mime: "x/y".into(),
    })
    .await;
    let data = datos(22 * FILE_CHUNK_BYTES);
    for chunk in data.chunks(FILE_CHUNK_BYTES) {
        c.send_data(TID, chunk).await;
    }
    assert_eq!(c.ctrl().await, ack(1_081_344));
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "x.bin", n, 0, "active")
    );
    assert_eq!(
        s.event().await,
        transfer(TID, "in", "x.bin", n, 1_081_344, "active")
    );
    assert_eq!(s.files(), vec!["x.bin.part"]);
    let id: [u8; 16] = hex::decode(TID).unwrap().try_into().unwrap();
    c.send_corrupt(&encode_file_data(&id, &datos(FILE_CHUNK_BYTES)))
        .await;
    assert_eq!(
        s.event().await,
        with(
            transfer(TID, "in", "x.bin", n, 1_081_344, "failed"),
            "error",
            json!("protocol_error")
        )
    );
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "protocol_error"})
    );
    c.closed().await;
    assert!(s.files().is_empty(), "{:?}", s.files());
}

#[tokio::test(start_paused = true)]
async fn sin_mensaje_1_en_30s_se_cierra() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    let t0 = Instant::now();
    let r = timeout(Duration::from_secs(60), c.rx.recv())
        .await
        .expect("no se cerró");
    assert!(r.is_none());
    let dt = t0.elapsed();
    assert!(
        dt >= Duration::from_secs(30) && dt <= Duration::from_secs(31),
        "{dt:?}"
    );
    s.no_events();
    // ya no ocupa hueco: otra conexión saluda con normalidad
    let mut otra = connect(&s.hub);
    otra.hello("m1", Some(false)).await;
    assert_eq!(s.event().await, peer_connected(2, "m1", "wifi"));
}
