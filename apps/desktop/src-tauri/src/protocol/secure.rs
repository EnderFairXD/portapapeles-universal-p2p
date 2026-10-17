//! Canal cifrado Noise IK (`Noise_IK_25519_ChaChaPoly_SHA256`, prólogo `clipsync/2`).
//! El móvil es el iniciador y el PC el respondedor. Tras el handshake de dos mensajes,
//! cada trama del protocolo es un mensaje Noise de transporte.

use snow::{HandshakeState, TransportState};
use x25519_dalek::{PublicKey, StaticSecret};

use super::{ProtocolError, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, NOISE_TAG_BYTES};

/// Patrón Noise exacto del protocolo; sin variantes propias.
pub const NOISE_PARAMS: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
/// Ata el handshake a esta versión del protocolo.
pub const PROLOGUE: &[u8] = b"clipsync/2";

/// Par de claves estáticas X25519.
#[derive(Clone)]
pub struct StaticKeys {
    pub private: [u8; 32],
    pub public: [u8; 32],
}

impl StaticKeys {
    /// Deriva la clave pública a partir de la privada.
    pub fn from_private(private: [u8; 32]) -> Self {
        let public = PublicKey::from(&StaticSecret::from(private)).to_bytes();
        Self { private, public }
    }

    /// Genera un par nuevo con 32 bytes aleatorios del sistema operativo.
    /// Si el sistema no puede dar aleatoriedad es un fallo irrecuperable de la plataforma.
    pub fn generate() -> Self {
        let mut private = [0u8; 32];
        getrandom::fill(&mut private).expect("el sistema no ofrece aleatoriedad");
        Self::from_private(private)
    }
}

fn params() -> Result<snow::params::NoiseParams, snow::Error> {
    NOISE_PARAMS.parse()
}

/// Handshake del lado del móvil (iniciador): conoce de antemano la clave pública del PC.
pub fn initiator(keys: &StaticKeys, server_public: &[u8; 32]) -> Result<HandshakeState, snow::Error> {
    snow::Builder::new(params()?)
        .local_private_key(&keys.private)?
        .remote_public_key(server_public)?
        .prologue(PROLOGUE)?
        .build_initiator()
}

/// Handshake del lado del PC (respondedor): descubre la clave del móvil en el mensaje 1.
pub fn responder(keys: &StaticKeys) -> Result<HandshakeState, snow::Error> {
    snow::Builder::new(params()?)
        .local_private_key(&keys.private)?
        .prologue(PROLOGUE)?
        .build_responder()
}

/// Canal de transporte tras el handshake: una trama = un mensaje Noise (AD vacío, nonce
/// por contador de 64 bits). El orden de las tramas importa: no admite pérdidas ni repeticiones.
pub struct SecureChannel {
    transport: TransportState,
}

fn invalid(what: &str) -> ProtocolError {
    ProtocolError::Invalid(what.to_string())
}

impl SecureChannel {
    /// Pasa un handshake terminado a modo transporte.
    pub fn new(hs: HandshakeState) -> Result<Self, snow::Error> {
        Ok(Self { transport: hs.into_transport_mode()? })
    }

    /// Cifra un payload (≤ 65 519 bytes); el resultado cabe en una trama (≤ 65 535).
    pub fn encrypt(&mut self, payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err(invalid("Payload demasiado grande para una trama cifrada"));
        }
        let mut out = vec![0u8; payload.len() + NOISE_TAG_BYTES];
        let n = self
            .transport
            .write_message(payload, &mut out)
            .map_err(|_| invalid("No se pudo cifrar la trama"))?;
        out.truncate(n);
        Ok(out)
    }

    /// Descifra una trama; falla si fue alterada, llega fuera de orden o no es de este canal.
    pub fn decrypt(&mut self, msg: &[u8]) -> Result<Vec<u8>, ProtocolError> {
        if msg.len() < NOISE_TAG_BYTES || msg.len() > MAX_FRAME_BYTES {
            return Err(invalid("Trama cifrada con tamaño inválido"));
        }
        let mut out = vec![0u8; msg.len()];
        let n = self
            .transport
            .read_message(msg, &mut out)
            .map_err(|_| invalid("No se pudo descifrar la trama"))?;
        out.truncate(n);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES};
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};

    /// Handshake completo con cargas vacías; devuelve (iniciador, respondedor) ya en transporte.
    fn par_de_canales() -> (SecureChannel, SecureChannel) {
        let init_keys = StaticKeys::generate();
        let resp_keys = StaticKeys::generate();
        let mut init = initiator(&init_keys, &resp_keys.public).unwrap();
        let mut resp = responder(&resp_keys).unwrap();
        let mut buf = vec![0u8; MAX_FRAME_BYTES];
        let mut out = vec![0u8; MAX_FRAME_BYTES];
        let n = init.write_message(&[], &mut buf).unwrap();
        resp.read_message(&buf[..n], &mut out).unwrap();
        let n = resp.write_message(&[], &mut buf).unwrap();
        init.read_message(&buf[..n], &mut out).unwrap();
        (SecureChannel::new(init).unwrap(), SecureChannel::new(resp).unwrap())
    }

    #[test]
    fn handshake_ik_y_transporte_ida_y_vuelta() {
        let init_keys = StaticKeys::generate();
        let resp_keys = StaticKeys::generate();
        let mut init = initiator(&init_keys, &resp_keys.public).unwrap();
        let mut resp = responder(&resp_keys).unwrap();
        let mut msg = vec![0u8; MAX_FRAME_BYTES];
        let mut out = vec![0u8; MAX_FRAME_BYTES];

        let n = init.write_message(b"hola", &mut msg).unwrap();
        let m = resp.read_message(&msg[..n], &mut out).unwrap();
        assert_eq!(&out[..m], b"hola");
        // El respondedor conoce la clave estática del iniciador gracias al mensaje 1.
        assert_eq!(resp.get_remote_static().unwrap(), &init_keys.public[..]);

        let n = resp.write_message(b"adios", &mut msg).unwrap();
        let m = init.read_message(&msg[..n], &mut out).unwrap();
        assert_eq!(&out[..m], b"adios");
        assert!(init.is_handshake_finished() && resp.is_handshake_finished());
        assert_eq!(init.get_handshake_hash(), resp.get_handshake_hash());

        let mut a = SecureChannel::new(init).unwrap();
        let mut b = SecureChannel::new(resp).unwrap();
        let c = a.encrypt(b"del movil").unwrap();
        assert_eq!(b.decrypt(&c).unwrap(), b"del movil");
        let c = b.encrypt(b"del pc").unwrap();
        assert_eq!(a.decrypt(&c).unwrap(), b"del pc");
    }

    #[test]
    fn clave_de_servidor_equivocada_falla_en_el_mensaje_1() {
        let init_keys = StaticKeys::generate();
        let resp_keys = StaticKeys::generate();
        let otra = StaticKeys::generate();
        let mut init = initiator(&init_keys, &otra.public).unwrap();
        let mut resp = responder(&resp_keys).unwrap();
        let mut msg = vec![0u8; MAX_FRAME_BYTES];
        let mut out = vec![0u8; MAX_FRAME_BYTES];
        let n = init.write_message(&[], &mut msg).unwrap();
        assert!(resp.read_message(&msg[..n], &mut out).is_err());
    }

    #[test]
    fn un_bit_cambiado_no_descifra() {
        let (mut a, mut b) = par_de_canales();
        let mut c = a.encrypt(b"secreto").unwrap();
        c[3] ^= 0x01;
        assert!(matches!(b.decrypt(&c), Err(ProtocolError::Invalid(_))));
    }

    #[test]
    fn mensaje_mas_corto_que_la_etiqueta_no_descifra() {
        let (_, mut b) = par_de_canales();
        assert!(matches!(b.decrypt(&[1, 2, 3]), Err(ProtocolError::Invalid(_))));
        assert!(matches!(b.decrypt(&[]), Err(ProtocolError::Invalid(_))));
    }

    #[test]
    fn payload_de_65519_cabe_y_65520_no() {
        let (mut a, mut b) = par_de_canales();
        let c = a.encrypt(&vec![9u8; MAX_PAYLOAD_BYTES]).unwrap();
        assert_eq!(c.len(), MAX_FRAME_BYTES);
        assert_eq!(b.decrypt(&c).unwrap(), vec![9u8; MAX_PAYLOAD_BYTES]);
        assert!(matches!(
            a.encrypt(&vec![9u8; MAX_PAYLOAD_BYTES + 1]),
            Err(ProtocolError::Invalid(_))
        ));
    }

    #[test]
    fn from_private_deriva_la_publica() {
        // Vector de RFC 7748 §6.1 (clave de Alice).
        let privada = hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a").unwrap();
        let publica = hex::decode("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a").unwrap();
        let keys = StaticKeys::from_private(privada.try_into().unwrap());
        assert_eq!(&keys.public[..], &publica[..]);
    }

    #[test]
    fn generate_da_claves_distintas_y_coherentes() {
        let a = StaticKeys::generate();
        let b = StaticKeys::generate();
        assert_ne!(a.private, b.private);
        assert_eq!(StaticKeys::from_private(a.private).public, a.public);
    }

    // ---- Vectores compartidos con la implementación TS (packages/protocol/test-vectors/noise-ik.json) ----

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorFile {
        protocol: String,
        prologue_hex: String,
        cases: Vec<VectorCase>,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorCase {
        name: String,
        init_static_hex: String,
        init_ephemeral_hex: String,
        resp_static_hex: String,
        resp_ephemeral_hex: String,
        handshake_hash_hex: String,
        messages: Vec<VectorMessage>,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct VectorMessage {
        from: String,
        payload_hex: String,
        message_hex: String,
    }

    /// `sha256("clipsync-vector/<caso>/<rol>/<s|e>")`: claves fijas y reproducibles.
    fn clave_fija(caso: &str, rol: &str, tipo: &str) -> [u8; 32] {
        Sha256::digest(format!("clipsync-vector/{caso}/{rol}/{tipo}").as_bytes()).into()
    }

    /// Ejecuta el handshake y el transporte de un caso con efímeras fijas, y comprueba que
    /// cada mensaje descifra a su carga. `transporte` = (emisor, carga) en orden.
    fn construir_caso(
        nombre: &str,
        carga_1: &[u8],
        carga_2: &[u8],
        transporte: &[(&str, Vec<u8>)],
    ) -> VectorCase {
        let init_s = clave_fija(nombre, "initiator", "s");
        let init_e = clave_fija(nombre, "initiator", "e");
        let resp_s = clave_fija(nombre, "responder", "s");
        let resp_e = clave_fija(nombre, "responder", "e");
        let resp_pub = StaticKeys::from_private(resp_s).public;

        let params: snow::params::NoiseParams = NOISE_PARAMS.parse().unwrap();
        let mut init = snow::Builder::new(params.clone())
            .local_private_key(&init_s)
            .unwrap()
            .remote_public_key(&resp_pub)
            .unwrap()
            .prologue(PROLOGUE)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&init_e)
            .build_initiator()
            .unwrap();
        let mut resp = snow::Builder::new(params)
            .local_private_key(&resp_s)
            .unwrap()
            .prologue(PROLOGUE)
            .unwrap()
            .fixed_ephemeral_key_for_testing_only(&resp_e)
            .build_responder()
            .unwrap();

        let mut buf = vec![0u8; MAX_FRAME_BYTES];
        let mut out = vec![0u8; MAX_FRAME_BYTES];
        let mut messages = Vec::new();

        let n = init.write_message(carga_1, &mut buf).unwrap();
        let m = resp.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], carga_1);
        messages.push(VectorMessage {
            from: "initiator".into(),
            payload_hex: hex::encode(carga_1),
            message_hex: hex::encode(&buf[..n]),
        });
        let n = resp.write_message(carga_2, &mut buf).unwrap();
        let m = init.read_message(&buf[..n], &mut out).unwrap();
        assert_eq!(&out[..m], carga_2);
        messages.push(VectorMessage {
            from: "responder".into(),
            payload_hex: hex::encode(carga_2),
            message_hex: hex::encode(&buf[..n]),
        });

        assert_eq!(init.get_handshake_hash(), resp.get_handshake_hash());
        let handshake_hash_hex = hex::encode(init.get_handshake_hash());
        let mut ini = SecureChannel::new(init).unwrap();
        let mut res = SecureChannel::new(resp).unwrap();

        for (from, payload) in transporte {
            let (emisor, receptor) = if *from == "initiator" { (&mut ini, &mut res) } else { (&mut res, &mut ini) };
            let cifrado = emisor.encrypt(payload).unwrap();
            assert_eq!(&receptor.decrypt(&cifrado).unwrap(), payload);
            messages.push(VectorMessage {
                from: (*from).into(),
                payload_hex: hex::encode(payload),
                message_hex: hex::encode(&cifrado),
            });
        }

        VectorCase {
            name: nombre.into(),
            init_static_hex: hex::encode(init_s),
            init_ephemeral_hex: hex::encode(init_e),
            resp_static_hex: hex::encode(resp_s),
            resp_ephemeral_hex: hex::encode(resp_e),
            handshake_hash_hex,
            messages,
        }
    }

    fn vectores_en_memoria() -> VectorFile {
        let client_hello = br#"{"v":2,"deviceId":"movil-0001","deviceName":"Pixel de Javier","willSendClip":true,"pairingToken":"AAECAwQFBgcICQoLDA0ODw"}"#;
        let server_hello = br#"{"v":2,"accepted":true,"deviceId":"pc-0001","pcName":"Portatil de Javier"}"#;
        let cases = vec![
            construir_caso(
                "vacio",
                &[],
                &[],
                &[("initiator", vec![]), ("responder", vec![]), ("initiator", vec![0x01])],
            ),
            construir_caso(
                "hello",
                client_hello,
                server_hello,
                &[
                    ("initiator", vec![0x01, b'h', b'i']),
                    ("responder", vec![0x01, b'o', b'k']),
                    ("initiator", vec![0x02; MAX_PAYLOAD_BYTES]),
                ],
            ),
            construir_caso(
                "orden",
                &[],
                &[],
                &[
                    ("initiator", vec![0x01, 1]),
                    ("initiator", vec![0x01, 2]),
                    ("initiator", vec![0x01, 3]),
                    ("initiator", vec![0x01, 4]),
                ],
            ),
        ];
        VectorFile { protocol: NOISE_PARAMS.into(), prologue_hex: hex::encode(PROLOGUE), cases }
    }

    #[test]
    fn vectores_noise_coinciden_con_snow() {
        let esperado = vectores_en_memoria();
        let mut json = serde_json::to_string_pretty(&esperado).unwrap();
        json.push('\n');

        if std::env::var("CLIPSYNC_WRITE_VECTORS").as_deref() == Ok("1") {
            let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/protocol/test-vectors/noise-ik.json");
            std::fs::write(ruta, &json).unwrap();
            return;
        }
        let raw = include_str!("../../../../../packages/protocol/test-vectors/noise-ik.json");
        assert_eq!(raw, json, "noise-ik.json desactualizado: regenerar con CLIPSYNC_WRITE_VECTORS=1");
    }
}
