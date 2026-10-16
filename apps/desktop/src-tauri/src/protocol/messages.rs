//! Mensajes del protocolo v2: codificación (con fragmentación) y decodificación validada.
//! Debe comportarse igual que `packages/protocol/src/messages.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{FILE_CHUNK_BYTES, MAX_CONTROL_BYTES, MAX_FRAME_BYTES, PROTOCOL_VERSION};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ControlMessage {
    Hello {
        v: u32,
        device_id: String,
        device_name: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        will_send_clip: Option<bool>,
    },
    Clip { id: String, text: String, hash: String },
    FileStart { transfer_id: String, name: String, size: u64, mime: String },
    FileAck { transfer_id: String, received: u64 },
    FileEnd { transfer_id: String, sha256: String },
    FileResult {
        transfer_id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        error: Option<String>,
    },
    FileCancel { transfer_id: String, reason: String },
    Ping,
    Pong,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    Control(ControlMessage),
    Data { transfer_id: [u8; 16], bytes: Vec<u8> },
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("Mensaje inválido: {0}")]
    Invalid(String),
}

fn fail<T>(what: impl Into<String>) -> Result<T, ProtocolError> {
    Err(ProtocolError::Invalid(what.into()))
}

/// Byte de tipo de cada trama.
const TYPE_CONTROL_LAST: u8 = 0x01;
const TYPE_FILE_DATA: u8 = 0x02;
const TYPE_CONTROL_MORE: u8 = 0x03;

const TRANSFER_ID_BYTES: usize = 16;
/// Mayor entero que JS representa sin pérdida (2^53 - 1): mismo tope que en TS.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn check_transfer_id(v: &str) -> Result<(), ProtocolError> {
    if is_lower_hex(v, TRANSFER_ID_BYTES * 2) {
        Ok(())
    } else {
        fail("'transferId' debe ser 32 caracteres hex en minúscula")
    }
}

fn check_hash(v: &str, key: &str) -> Result<(), ProtocolError> {
    if is_lower_hex(v, 64) {
        Ok(())
    } else {
        fail(format!("'{key}' debe ser 64 caracteres hex en minúscula"))
    }
}

fn check_uint(v: u64, key: &str) -> Result<(), ProtocolError> {
    if v <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        fail(format!("'{key}' debe ser un entero no negativo"))
    }
}

/// Reglas que el tipo no garantiza (versión, formato de ids y hashes, rango de enteros).
fn check_message(msg: &ControlMessage) -> Result<(), ProtocolError> {
    match msg {
        ControlMessage::Hello { v, .. } if *v != PROTOCOL_VERSION => fail(format!("'v' debe ser {PROTOCOL_VERSION}")),
        ControlMessage::Clip { hash, .. } => check_hash(hash, "hash"),
        ControlMessage::FileStart { transfer_id, size, .. } => {
            check_transfer_id(transfer_id)?;
            check_uint(*size, "size")
        }
        ControlMessage::FileAck { transfer_id, received } => {
            check_transfer_id(transfer_id)?;
            check_uint(*received, "received")
        }
        ControlMessage::FileEnd { transfer_id, sha256 } => {
            check_transfer_id(transfer_id)?;
            check_hash(sha256, "sha256")
        }
        ControlMessage::FileResult { transfer_id, .. } | ControlMessage::FileCancel { transfer_id, .. } => {
            check_transfer_id(transfer_id)
        }
        _ => Ok(()),
    }
}

type Obj = serde_json::Map<String, Value>;

fn str_field(o: &Obj, key: &str) -> Result<String, ProtocolError> {
    match o.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => fail(format!("'{key}' debe ser texto")),
    }
}

fn uint_field(o: &Obj, key: &str) -> Result<u64, ProtocolError> {
    let err = || fail(format!("'{key}' debe ser un entero no negativo"));
    let Some(Value::Number(n)) = o.get(key) else { return err() };
    // JSON.parse de JS acepta `1.0` y `1e3` como enteros, así que aquí también.
    let v = match n.as_u64() {
        Some(u) => u,
        None => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f >= 0.0 && f <= MAX_SAFE_INTEGER as f64 => f as u64,
            _ => return err(),
        },
    };
    if v > MAX_SAFE_INTEGER {
        return err();
    }
    Ok(v)
}

fn transfer_id_field(o: &Obj) -> Result<String, ProtocolError> {
    let v = str_field(o, "transferId")?;
    check_transfer_id(&v)?;
    Ok(v)
}

fn hash_field(o: &Obj, key: &str) -> Result<String, ProtocolError> {
    let v = str_field(o, key)?;
    check_hash(&v, key)?;
    Ok(v)
}

/// Comprueba la forma del JSON y devuelve el mensaje; los campos desconocidos se ignoran.
fn validate_control(value: &Value) -> Result<ControlMessage, ProtocolError> {
    let Value::Object(o) = value else { return fail("se esperaba un objeto") };
    let kind = match o.get("kind") {
        Some(Value::String(k)) => k.as_str(),
        other => return fail(format!("kind desconocido ({})", other.map_or("undefined".into(), |k| k.to_string()))),
    };
    match kind {
        "hello" => {
            if o.get("v").and_then(Value::as_f64) != Some(f64::from(PROTOCOL_VERSION)) {
                return fail(format!("'v' debe ser {PROTOCOL_VERSION}"));
            }
            let will_send_clip = match o.get("willSendClip") {
                None => None,
                Some(Value::Bool(b)) => Some(*b),
                Some(_) => return fail("'willSendClip' debe ser booleano"),
            };
            Ok(ControlMessage::Hello {
                v: PROTOCOL_VERSION,
                device_id: str_field(o, "deviceId")?,
                device_name: str_field(o, "deviceName")?,
                will_send_clip,
            })
        }
        "clip" => Ok(ControlMessage::Clip {
            id: str_field(o, "id")?,
            text: str_field(o, "text")?,
            hash: hash_field(o, "hash")?,
        }),
        "file_start" => Ok(ControlMessage::FileStart {
            transfer_id: transfer_id_field(o)?,
            name: str_field(o, "name")?,
            size: uint_field(o, "size")?,
            mime: str_field(o, "mime")?,
        }),
        "file_ack" => Ok(ControlMessage::FileAck {
            transfer_id: transfer_id_field(o)?,
            received: uint_field(o, "received")?,
        }),
        "file_end" => Ok(ControlMessage::FileEnd {
            transfer_id: transfer_id_field(o)?,
            sha256: hash_field(o, "sha256")?,
        }),
        "file_result" => {
            let Some(Value::Bool(ok)) = o.get("ok") else { return fail("'ok' debe ser booleano") };
            let transfer_id = transfer_id_field(o)?;
            let error = match o.get("error") {
                None => None,
                Some(_) => Some(str_field(o, "error")?),
            };
            Ok(ControlMessage::FileResult { transfer_id, ok: *ok, error })
        }
        "file_cancel" => Ok(ControlMessage::FileCancel {
            transfer_id: transfer_id_field(o)?,
            reason: str_field(o, "reason")?,
        }),
        "ping" => Ok(ControlMessage::Ping),
        "pong" => Ok(ControlMessage::Pong),
        other => fail(format!("kind desconocido ({other})")),
    }
}

fn with_type(type_byte: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + body.len());
    out.push(type_byte);
    out.extend_from_slice(body);
    out
}

/// Codifica un mensaje de control en payloads de trama (sin la longitud u16).
/// El JSON se trocea en bytes: tramas 0x03 y una 0x01 final.
pub fn try_encode_control(msg: &ControlMessage) -> Result<Vec<Vec<u8>>, ProtocolError> {
    check_message(msg)?;
    let json = serde_json::to_vec(msg).map_err(|e| ProtocolError::Invalid(e.to_string()))?;
    if json.len() > MAX_CONTROL_BYTES {
        return fail(format!("supera {MAX_CONTROL_BYTES} bytes"));
    }

    let max_body = MAX_FRAME_BYTES - 1;
    let total = json.len().div_ceil(max_body);
    Ok(json
        .chunks(max_body)
        .enumerate()
        .map(|(i, part)| with_type(if i + 1 < total { TYPE_CONTROL_MORE } else { TYPE_CONTROL_LAST }, part))
        .collect())
}

/// Como [`try_encode_control`], pero con un mensaje inválido hace panic: pensado para
/// mensajes que construye el propio programa (los de usuario se comprueban antes).
pub fn encode_control(msg: &ControlMessage) -> Vec<Vec<u8>> {
    try_encode_control(msg).unwrap_or_else(|e| panic!("{e}"))
}

/// Payload de trama 0x02: transferId (16 bytes) + bytes de archivo (≤ 48 KiB).
/// Hace panic si `bytes` supera `FILE_CHUNK_BYTES`: el emisor trocea siempre antes.
pub fn encode_file_data(transfer_id: &[u8; 16], bytes: &[u8]) -> Vec<u8> {
    assert!(
        bytes.len() <= FILE_CHUNK_BYTES,
        "Datos de {} bytes: el máximo es {FILE_CHUNK_BYTES}",
        bytes.len()
    );
    let mut out = Vec::with_capacity(1 + TRANSFER_ID_BYTES + bytes.len());
    out.push(TYPE_FILE_DATA);
    out.extend_from_slice(transfer_id);
    out.extend_from_slice(bytes);
    out
}

/// Decodifica payloads de trama de uno en uno; devuelve `None` mientras falten fragmentos.
#[derive(Debug, Default)]
pub struct MessageDecoder {
    pending: Vec<u8>,
}

impl MessageDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, payload: &[u8]) -> Result<Option<Decoded>, ProtocolError> {
        let result = self.decode(payload);
        if result.is_err() {
            self.pending.clear(); // tras un error no se arrastran fragmentos a medias
        }
        result
    }

    fn decode(&mut self, payload: &[u8]) -> Result<Option<Decoded>, ProtocolError> {
        let Some((&type_byte, body)) = payload.split_first() else { return fail("trama vacía") };

        match type_byte {
            TYPE_FILE_DATA => {
                if !self.pending.is_empty() {
                    return fail("datos de archivo en mitad de un mensaje fragmentado");
                }
                if body.len() < TRANSFER_ID_BYTES {
                    return fail("datos de archivo sin transferId completo");
                }
                let (id, bytes) = body.split_at(TRANSFER_ID_BYTES);
                if bytes.len() > FILE_CHUNK_BYTES {
                    return fail(format!("datos de archivo de más de {FILE_CHUNK_BYTES} bytes"));
                }
                let transfer_id = id.try_into().expect("split_at devuelve exactamente 16 bytes");
                Ok(Some(Decoded::Data { transfer_id, bytes: bytes.to_vec() }))
            }
            TYPE_CONTROL_MORE | TYPE_CONTROL_LAST => {
                // un 0x03 sin contenido no hace avanzar el mensaje: el emisor nunca lo genera
                if type_byte == TYPE_CONTROL_MORE && body.is_empty() {
                    return fail("fragmento de control vacío");
                }
                if self.pending.len() + body.len() > MAX_CONTROL_BYTES {
                    return fail(format!("mensaje de control de más de {MAX_CONTROL_BYTES} bytes"));
                }
                self.pending.extend_from_slice(body);
                if type_byte == TYPE_CONTROL_MORE {
                    return Ok(None);
                }
                let json = std::mem::take(&mut self.pending);
                Ok(Some(Decoded::Control(parse_control(&json)?)))
            }
            other => fail(format!("tipo de trama desconocido (0x{other:02x})")),
        }
    }
}

fn parse_control(json: &[u8]) -> Result<ControlMessage, ProtocolError> {
    // TextDecoder de JS descarta un BOM inicial; aquí igual, para decodificar lo mismo que TS.
    let json = json.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(json);
    match serde_json::from_slice::<Value>(json) {
        Ok(value) => validate_control(&value),
        Err(_) => fail("JSON o UTF-8 inválido"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TID: &str = "00112233445566778899aabbccddeeff";
    const HASH: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn tid_bytes() -> [u8; 16] {
        hex::decode(TID).unwrap().try_into().unwrap()
    }

    /// Decodifica todas las tramas y devuelve los mensajes completos que salgan.
    fn decode_all(frames: &[Vec<u8>]) -> Result<Vec<Decoded>, ProtocolError> {
        let mut d = MessageDecoder::new();
        let mut out = Vec::new();
        for f in frames {
            if let Some(m) = d.push(f)? {
                out.push(m);
            }
        }
        Ok(out)
    }

    fn clip(text: &str) -> ControlMessage {
        ControlMessage::Clip { id: "a".into(), text: text.into(), hash: HASH.into() }
    }

    #[test]
    fn vectores_compartidos() {
        let raw = include_str!("../../../../../packages/protocol/test-vectors/messages.json");
        let vectors: Vec<Value> = serde_json::from_str(raw).unwrap();
        assert!(vectors.len() >= 30);
        let (mut controles, mut datos, mut errores) = (0, 0, 0);

        for v in &vectors {
            let name = v["name"].as_str().unwrap();
            let frames: Vec<Vec<u8>> = v["framesHex"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| hex::decode(h.as_str().unwrap()).unwrap())
                .collect();
            let expect = &v["expect"];

            let mut d = MessageDecoder::new();
            let results: Vec<Result<Option<Decoded>, ProtocolError>> =
                frames.iter().map(|f| d.push(f)).collect();

            // Se distingue por `kind` o `data` primero: `file_result` también tiene un `error`.
            if expect.get("kind").is_some() {
                controles += 1;
                let (last, pending) = results.split_last().unwrap();
                assert!(pending.iter().all(|r| matches!(r, Ok(None))), "{name}: fragmentos");
                let want: ControlMessage = serde_json::from_value(expect.clone()).unwrap();
                assert_eq!(last.clone().unwrap(), Some(Decoded::Control(want)), "{name}");
            } else if let Some(data) = expect.get("data") {
                datos += 1;
                let got = results.last().unwrap().clone().unwrap().unwrap();
                let want_tid: [u8; 16] =
                    hex::decode(data["transferId"].as_str().unwrap()).unwrap().try_into().unwrap();
                let want_bytes = hex::decode(data["bytesHex"].as_str().unwrap()).unwrap();
                assert_eq!(got, Decoded::Data { transfer_id: want_tid, bytes: want_bytes }, "{name}");
            } else {
                errores += 1;
                assert_eq!(expect, &serde_json::json!({ "error": true }), "{name}");
                assert!(results.iter().any(|r| r.is_err()), "{name}: debía fallar");
            }
        }
        assert!(controles >= 15 && datos >= 2 && errores >= 15);
    }

    #[test]
    fn ida_y_vuelta_de_cada_variante() {
        let messages = vec![
            ControlMessage::Hello { v: 2, device_id: "d1".into(), device_name: "Pixel".into(), will_send_clip: Some(false) },
            ControlMessage::Hello { v: 2, device_id: "d1".into(), device_name: "Pixel".into(), will_send_clip: None },
            clip("hola 😀"),
            ControlMessage::FileStart { transfer_id: TID.into(), name: "a.txt".into(), size: 0, mime: "text/plain".into() },
            ControlMessage::FileAck { transfer_id: TID.into(), received: 1_048_576 },
            ControlMessage::FileEnd { transfer_id: TID.into(), sha256: HASH.into() },
            ControlMessage::FileResult { transfer_id: TID.into(), ok: true, error: None },
            ControlMessage::FileResult { transfer_id: TID.into(), ok: false, error: Some("hash_mismatch".into()) },
            ControlMessage::FileCancel { transfer_id: TID.into(), reason: "user".into() },
            ControlMessage::Ping,
            ControlMessage::Pong,
        ];
        for msg in messages {
            let frames = encode_control(&msg);
            assert_eq!(frames.len(), 1, "{msg:?}");
            assert_eq!(frames[0][0], 0x01);
            assert_eq!(decode_all(&frames).unwrap(), vec![Decoded::Control(msg)]);
        }
    }

    #[test]
    fn json_usa_kind_en_snake_case_y_campos_en_camel_case() {
        let frames = encode_control(&ControlMessage::FileAck { transfer_id: TID.into(), received: 5 });
        let json: Value = serde_json::from_slice(&frames[0][1..]).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "file_ack", "transferId": TID, "received": 5 }));

        let hello = ControlMessage::Hello { v: 2, device_id: "a".into(), device_name: "b".into(), will_send_clip: None };
        let json: Value = serde_json::from_slice(&encode_control(&hello)[0][1..]).unwrap();
        assert!(json.get("willSendClip").is_none());
        assert_eq!(json["deviceName"], "b");
    }

    #[test]
    fn clip_de_1_mib_de_emojis_se_fragmenta_y_se_reensambla() {
        let text = "😀".repeat(262_144); // 1 MiB en UTF-8
        assert_eq!(text.len(), 1_048_576);
        let msg = clip(&text);
        let frames = encode_control(&msg);
        assert!(frames.len() > 16);
        assert!(frames.iter().all(|f| f.len() <= MAX_FRAME_BYTES));
        let (last, more) = frames.split_last().unwrap();
        assert!(more.iter().all(|f| f[0] == 0x03) && last[0] == 0x01);
        assert_eq!(decode_all(&frames).unwrap(), vec![Decoded::Control(msg)]);
    }

    #[test]
    fn json_de_65534_bytes_cabe_en_una_trama_y_65535_se_trocea() {
        let overhead = serde_json::to_vec(&clip("")).unwrap().len();
        let exact = encode_control(&clip(&"x".repeat(65534 - overhead)));
        assert_eq!(exact.len(), 1);
        assert_eq!(exact[0].len(), 65535);
        let over = encode_control(&clip(&"x".repeat(65535 - overhead)));
        assert_eq!(over.iter().map(|f| f[0]).collect::<Vec<_>>(), vec![0x03, 0x01]);
    }

    #[test]
    fn reensamblado_de_mas_de_2_mib_es_error() {
        let mut d = MessageDecoder::new();
        let mut frame = vec![0x61u8; 65535];
        frame[0] = 0x03; // 65534 bytes de contenido
        let mut n = 0;
        let err = loop {
            match d.push(&frame) {
                Ok(None) => n += 1,
                Ok(Some(_)) => panic!("no debía completarse"),
                Err(e) => break e,
            }
            assert!(n < 40, "no saltó el tope");
        };
        assert!(matches!(err, ProtocolError::Invalid(_)));
        assert_eq!(n, MAX_CONTROL_BYTES / 65534);
    }

    #[test]
    fn tras_un_error_el_decoder_queda_limpio() {
        let mut d = MessageDecoder::new();
        assert_eq!(d.push(&[0x03, 0x7b]), Ok(None));
        assert!(d.push(&[0x07]).is_err());
        let ping = &encode_control(&ControlMessage::Ping)[0];
        assert_eq!(d.push(ping), Ok(Some(Decoded::Control(ControlMessage::Ping))));
    }

    #[test]
    fn datos_con_fragmentos_pendientes_son_error_y_descartan_lo_pendiente() {
        let mut d = MessageDecoder::new();
        assert_eq!(d.push(&[0x03, 0x7b]), Ok(None));
        let data = encode_file_data(&tid_bytes(), &[1]);
        assert!(d.push(&data).is_err());
        // los fragmentos pendientes se descartaron: ahora el dato pasa
        assert!(matches!(d.push(&data), Ok(Some(Decoded::Data { .. }))));
    }

    #[test]
    fn fragmento_0x03_vacio_es_error() {
        assert!(MessageDecoder::new().push(&[0x03]).is_err());
    }

    #[test]
    fn campos_desconocidos_se_ignoran_y_los_opcionales_mal_tipados_fallan() {
        let mut d = MessageDecoder::new();
        let mut frame = vec![0x01];
        frame.extend_from_slice(br#"{"kind":"ping","extra":1}"#);
        assert_eq!(d.push(&frame), Ok(Some(Decoded::Control(ControlMessage::Ping))));

        let mut bad = vec![0x01];
        bad.extend_from_slice(br#"{"kind":"file_result","transferId":"00112233445566778899aabbccddeeff","ok":true,"error":null}"#);
        assert!(d.push(&bad).is_err());
    }

    #[test]
    fn enteros_validos_como_en_ts() {
        let mut d = MessageDecoder::new();
        let mk = |size: &str| {
            let mut f = vec![0x01];
            f.extend_from_slice(
                format!(r#"{{"kind":"file_start","transferId":"{TID}","name":"a","size":{size},"mime":"x"}}"#).as_bytes(),
            );
            f
        };
        // 1.0 y 1e3 son enteros para JSON.parse; 2^53 no es entero seguro
        assert!(matches!(d.push(&mk("1.0")), Ok(Some(_))));
        assert!(matches!(d.push(&mk("1e3")), Ok(Some(Decoded::Control(ControlMessage::FileStart { size: 1000, .. })))));
        assert!(matches!(d.push(&mk("9007199254740991")), Ok(Some(_))));
        assert!(d.push(&mk("9007199254740992")).is_err());
        assert!(d.push(&mk("-1")).is_err());
        assert!(d.push(&mk("1.5")).is_err());
    }

    #[test]
    fn encode_control_rechaza_mensajes_con_forma_invalida() {
        let bad_id = ControlMessage::FileAck { transfer_id: "corto".into(), received: 1 };
        assert!(matches!(try_encode_control(&bad_id), Err(ProtocolError::Invalid(_))));
        let bad_v = ControlMessage::Hello { v: 1, device_id: "a".into(), device_name: "b".into(), will_send_clip: None };
        assert!(try_encode_control(&bad_v).is_err());
        let upper = ControlMessage::FileEnd { transfer_id: TID.to_uppercase(), sha256: HASH.into() };
        assert!(try_encode_control(&upper).is_err());
        let bad_hash = ControlMessage::Clip { id: "a".into(), text: "".into(), hash: "ab".into() };
        assert!(try_encode_control(&bad_hash).is_err());
    }

    #[test]
    fn encode_control_rechaza_un_mensaje_de_mas_de_2_mib() {
        let msg = clip(&"x".repeat(MAX_CONTROL_BYTES));
        assert!(matches!(try_encode_control(&msg), Err(ProtocolError::Invalid(_))));
    }

    #[test]
    fn datos_de_archivo_ida_y_vuelta() {
        let frame = encode_file_data(&tid_bytes(), &[1, 2, 3]);
        assert_eq!(frame.len(), 1 + 16 + 3);
        assert_eq!(frame[0], 0x02);
        assert_eq!(&frame[1..17], &tid_bytes());
        assert_eq!(
            decode_all(&[frame]).unwrap(),
            vec![Decoded::Data { transfer_id: tid_bytes(), bytes: vec![1, 2, 3] }]
        );
    }

    #[test]
    fn datos_de_archivo_acepta_49152_bytes_y_el_decoder_rechaza_49153() {
        let ok = encode_file_data(&tid_bytes(), &vec![0u8; FILE_CHUNK_BYTES]);
        assert_eq!(ok.len(), 1 + 16 + FILE_CHUNK_BYTES);
        assert!(matches!(MessageDecoder::new().push(&ok), Ok(Some(_))));

        let mut big = vec![0u8; 1 + 16 + FILE_CHUNK_BYTES + 1];
        big[0] = 0x02;
        assert!(MessageDecoder::new().push(&big).is_err());
    }

    #[test]
    #[should_panic(expected = "49152")]
    fn encode_file_data_panica_con_mas_de_49152_bytes() {
        encode_file_data(&tid_bytes(), &vec![0u8; FILE_CHUNK_BYTES + 1]);
    }

    #[test]
    fn la_version_del_protocolo_es_2() {
        assert_eq!(PROTOCOL_VERSION, 2);
    }
}
