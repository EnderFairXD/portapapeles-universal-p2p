//! Tests del Hub con un cliente de prueba que habla el protocolo a mano sobre `tokio::io::duplex`.

use super::*;
use crate::protocol::{
    encode_control, encode_file_data, frame_codec, ControlMessage, Decoded, MessageDecoder,
    FILE_CHUNK_BYTES,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncWriteExt, DuplexStream, ReadBuf, WriteHalf};
use tokio::sync::mpsc::UnboundedReceiver;
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

struct Setup {
    hub: Hub,
    events: UnboundedReceiver<HubEvent>,
    dir: tempfile::TempDir,
    /// lo que devuelve `local_clip` (el último texto del portapapeles del PC)
    local: Arc<Mutex<Option<String>>>,
}

fn setup(local: Option<&str>) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let local = Arc::new(Mutex::new(local.map(String::from)));
    let l = local.clone();
    let (hub, events) = Hub::new(HubConfig {
        device_id: "pc-1".into(),
        pc_name: "PC de prueba".into(),
        download_dir: dir.path().to_path_buf(),
        local_clip: Arc::new(move || l.lock().unwrap().clone()),
    });
    Setup {
        hub,
        events,
        dir,
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
}

fn hello(device_id: &str, will_send_clip: Option<bool>) -> ControlMessage {
    ControlMessage::Hello {
        v: 2,
        device_id: device_id.into(),
        device_name: format!("Móvil {device_id}"),
        will_send_clip,
    }
}

fn clip(text: &str) -> ControlMessage {
    ControlMessage::Clip {
        id: "c".repeat(32),
        text: text.into(),
        hash: sha(text.as_bytes()),
    }
}

fn server_hello() -> ControlMessage {
    ControlMessage::Hello {
        v: 2,
        device_id: "pc-1".into(),
        device_name: "PC de prueba".into(),
        will_send_clip: None,
    }
}

fn peer_connected(session_id: u64, device_id: &str, transport: &str) -> Value {
    json!({"type": "peerConnected", "sessionId": session_id, "deviceId": device_id,
           "deviceName": format!("Móvil {device_id}"), "transport": transport})
}

fn transfer(id: &str, dir: &str, name: &str, size: u64, bytes: u64, state: &str) -> Value {
    json!({"type": "transfer", "transferId": id, "direction": dir, "name": name, "size": size,
           "bytes": bytes, "state": state, "error": null, "location": null})
}

fn with(mut v: Value, key: &str, val: Value) -> Value {
    v[key] = val;
    v
}

/// Cliente de prueba: escribe a mano y un hilo lector decodifica todo lo que llega.
struct Client<W> {
    w: FramedWrite<W, LengthDelimitedCodec>,
    rx: UnboundedReceiver<Decoded>,
}

fn connect(hub: &Hub) -> Client<WriteHalf<DuplexStream>> {
    let (a, b) = tokio::io::duplex(256 * 1024);
    hub.accept_stream(b, Transport::Wifi);
    over(a)
}

fn over<S: AsyncRead + AsyncWrite + Send + 'static>(s: S) -> Client<WriteHalf<S>> {
    let (r, w) = tokio::io::split(s);
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut frames = FramedRead::new(r, frame_codec());
        let mut dec = MessageDecoder::default();
        while let Some(Ok(f)) = frames.next().await {
            match dec.push(&f) {
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
    }
}

impl<W: AsyncWrite + Unpin> Client<W> {
    async fn send(&mut self, msg: ControlMessage) {
        for f in encode_control(&msg).unwrap() {
            self.w.send(Bytes::from(f)).await.unwrap();
        }
    }

    async fn send_data(&mut self, id: &str, bytes: &[u8]) {
        let id: [u8; 16] = hex::decode(id).unwrap().try_into().unwrap();
        self.w
            .send(Bytes::from(encode_file_data(&id, bytes)))
            .await
            .unwrap();
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

    async fn hello(&mut self, device_id: &str, will_send_clip: Option<bool>) {
        self.send(hello(device_id, will_send_clip)).await;
        assert_eq!(self.ctrl().await, server_hello());
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
    c.send(hello("m1", Some(false))).await;
    assert_eq!(c.ctrl().await, server_hello());
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
async fn mensaje_antes_del_hello_cierra_sin_peer_connected() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.send(clip("hola")).await;
    c.closed().await;
    // nunca llegó a estar conectado: no hay evento de conexión ni de desconexión
    s.no_events();
}

#[tokio::test]
async fn hello_repetido_es_protocol_error() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.hello("m1", Some(false)).await;
    s.event().await;
    c.send(hello("m1", Some(false))).await;
    assert_eq!(
        s.event().await,
        json!({"type": "peerDisconnected", "sessionId": 1, "reason": "protocol_error"})
    );
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

/// Enlace que, al escribir un mensaje de control con ese `kind`, falla o (con `true`) se
/// queda bloqueado para siempre, como un TCP medio abierto con el búfer lleno.
struct FallaAlEscribir(DuplexStream, &'static str, bool);

impl AsyncRead for FallaAlEscribir {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for FallaAlEscribir {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let marca = format!("\"kind\":\"{}\"", self.1);
        if buf.windows(marca.len()).any(|w| w == marca.as_bytes()) {
            if self.2 {
                return Poll::Pending;
            }
            return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
        }
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

#[tokio::test]
async fn si_cae_antes_de_file_result_se_borra_el_archivo_guardado() {
    let mut s = setup(None);
    let (a, b) = tokio::io::duplex(256 * 1024);
    // la sesión cae tras `finish()` y antes de confirmar
    s.hub
        .accept_stream(FallaAlEscribir(b, "file_result", false), Transport::Wifi);
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
    s.hub
        .accept_stream(FallaAlEscribir(b, "clip", false), Transport::Wifi);
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
async fn device_id_de_mas_de_128_bytes_es_protocol_error() {
    let mut s = setup(None);
    let mut ok = connect(&s.hub);
    ok.hello(&"a".repeat(128), Some(false)).await;
    assert_eq!(s.event().await["deviceId"], json!("a".repeat(128)));

    let mut c = connect(&s.hub);
    c.send(hello(&"b".repeat(129), Some(false))).await;
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn device_name_se_recorta_a_64_caracteres() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    c.send(ControlMessage::Hello {
        v: 2,
        device_id: "m1".into(),
        device_name: "ñ".repeat(100),
        will_send_clip: Some(false),
    })
    .await;
    assert_eq!(c.ctrl().await, server_hello());
    assert_eq!(s.event().await["deviceName"], json!("ñ".repeat(64)));
}

// --- ronda de correcciones 2: una sesión vieja que cae tarde no borra lo de la nueva ---

#[tokio::test(start_paused = true)]
async fn sesion_vieja_que_cae_tarde_no_borra_la_sincronia_de_la_nueva() {
    let mut s = setup(None);
    // la vieja se queda bloqueada al escribir un clip: no verá su Close("replaced")
    let (a, b) = tokio::io::duplex(256 * 1024);
    s.hub
        .accept_stream(FallaAlEscribir(b, "clip", true), Transport::Wifi);
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
    // un mensaje antes del hello la cierra y libera su hueco
    sin_saludo[0].send(clip("hola")).await;
    sin_saludo[0].closed().await;
    // el Hub quita la sesión al recibir su Closed: se reintenta hasta que haya hueco
    let _nueva = timeout(WAIT, async {
        loop {
            let mut c = connect(&s.hub);
            c.send(hello("m1", Some(false))).await;
            if let Some(Decoded::Control(m)) = c.recv().await {
                assert_eq!(m, server_hello());
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
        (Some("peerConnected"), Some("m1"))
    );
}

#[tokio::test(start_paused = true)]
async fn sin_hello_en_30_s_se_cierra_aunque_haya_trafico() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    // fragmentos 0x03 de un byte: mantienen vivo el latido pero nunca completan el hello
    for _ in 0..4 {
        c.w.send(Bytes::from_static(&[0x03, b' '])).await.unwrap();
        tokio::time::sleep(Duration::from_secs(9)).await;
    }
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn antes_del_hello_un_mensaje_de_mas_de_64_kib_se_rechaza() {
    let mut s = setup(None);
    let mut c = connect(&s.hub);
    // un hello válido, pero de más de 64 KiB reensamblados
    let mut grande = hello("m1", Some(false));
    if let ControlMessage::Hello { device_name, .. } = &mut grande {
        *device_name = "x".repeat(70_000);
    }
    c.send(grande).await;
    c.closed().await;
    s.no_events();
}

#[tokio::test]
async fn tras_el_hello_un_mensaje_de_mas_de_64_kib_si_vale() {
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
