//! Cargas JSON de los dos mensajes del handshake Noise IK (móvil → PC y PC → móvil).
//! Deben comportarse igual que `packages/protocol/src/hello.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::messages::ProtocolError;
use super::PROTOCOL_VERSION;

/// Primer mensaje (móvil → PC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub v: u32,
    pub device_id: String,
    pub device_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub will_send_clip: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub pairing_token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    NotPaired,
    PairingExpired,
}

impl RejectReason {
    /// Texto del motivo, el mismo que viaja en el mensaje 2 y en el cierre de la sesión.
    pub fn as_str(self) -> &'static str {
        match self {
            RejectReason::NotPaired => "not_paired",
            RejectReason::PairingExpired => "pairing_expired",
        }
    }
}

/// Segundo mensaje (PC → móvil).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerHello {
    Accepted { device_id: String, pc_name: String },
    Rejected { reason: RejectReason },
}

impl ServerHello {
    pub fn accept(device_id: impl Into<String>, pc_name: impl Into<String>) -> Self {
        Self::Accepted { device_id: device_id.into(), pc_name: pc_name.into() }
    }

    pub fn reject(reason: RejectReason) -> Self {
        Self::Rejected { reason }
    }
}

type Obj = serde_json::Map<String, Value>;

fn fail<T>(what: impl Into<String>) -> Result<T, ProtocolError> {
    Err(ProtocolError::Invalid(what.into()))
}

/// Un token del QR: 128 bits en base64url sin relleno, es decir, 22 caracteres.
fn is_pairing_token(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn parse_object(bytes: &[u8]) -> Result<Obj, ProtocolError> {
    // TextDecoder de JS descarta un BOM inicial; aquí igual, para decodificar lo mismo que TS.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => fail("se esperaba un objeto"),
        Err(_) => fail("JSON o UTF-8 inválido"),
    }
}

fn str_field(o: &Obj, key: &str) -> Result<String, ProtocolError> {
    match o.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => fail(format!("'{key}' debe ser texto")),
    }
}

fn check_version(o: &Obj) -> Result<(), ProtocolError> {
    // JSON no distingue `2` de `2.0` (JS tampoco), así que ambos valen.
    if o.get("v").and_then(Value::as_f64) == Some(f64::from(PROTOCOL_VERSION)) {
        Ok(())
    } else {
        fail(format!("'v' debe ser {PROTOCOL_VERSION}"))
    }
}

pub fn decode_client_hello(bytes: &[u8]) -> Result<ClientHello, ProtocolError> {
    let o = parse_object(bytes)?;
    check_version(&o)?;
    let device_id = str_field(&o, "deviceId")?;
    let device_name = str_field(&o, "deviceName")?;
    let will_send_clip = match o.get("willSendClip") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return fail("'willSendClip' debe ser booleano"),
    };
    let pairing_token = match o.get("pairingToken") {
        None => None,
        Some(_) => {
            let token = str_field(&o, "pairingToken")?;
            if !is_pairing_token(&token) {
                return fail("'pairingToken' debe ser 22 caracteres base64url");
            }
            Some(token)
        }
    };
    Ok(ClientHello { v: PROTOCOL_VERSION, device_id, device_name, will_send_clip, pairing_token })
}

pub fn encode_server_hello(hello: &ServerHello) -> Vec<u8> {
    let value = match hello {
        ServerHello::Accepted { device_id, pc_name } => {
            serde_json::json!({ "v": PROTOCOL_VERSION, "accepted": true, "deviceId": device_id, "pcName": pc_name })
        }
        ServerHello::Rejected { reason } => {
            serde_json::json!({ "v": PROTOCOL_VERSION, "accepted": false, "reason": reason })
        }
    };
    // Serializar un `Value` no puede fallar (claves de texto); el `unwrap_or_default` evita un panic.
    serde_json::to_vec(&value).unwrap_or_default()
}

/// Lado del móvil: el PC no lo usa, pero sí su cliente de prueba (`hub_tests`) y los vectores.
#[cfg_attr(not(test), allow(dead_code))]
pub fn decode_server_hello(bytes: &[u8]) -> Result<ServerHello, ProtocolError> {
    let o = parse_object(bytes)?;
    check_version(&o)?;
    let Some(Value::Bool(accepted)) = o.get("accepted") else { return fail("'accepted' debe ser booleano") };
    if *accepted {
        return Ok(ServerHello::Accepted { device_id: str_field(&o, "deviceId")?, pc_name: str_field(&o, "pcName")? });
    }
    let reason = match str_field(&o, "reason")?.as_str() {
        "not_paired" => RejectReason::NotPaired,
        "pairing_expired" => RejectReason::PairingExpired,
        other => return fail(format!("'reason' desconocido ({other})")),
    };
    Ok(ServerHello::Rejected { reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "AbCdEfGhIjKlMnOpQrSt_-";

    fn vectors() -> Vec<Value> {
        let raw = include_str!("../../../../../packages/protocol/test-vectors/hello.json");
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn vectores_compartidos() {
        let vectors = vectors();
        assert!(vectors.len() >= 50);
        let (mut aceptados, mut rechazados, mut errores) = (0, 0, 0);

        for v in &vectors {
            let name = v["name"].as_str().unwrap();
            let json = v["json"].as_str().unwrap().as_bytes();
            let expect = &v["expect"];
            let client = match v["side"].as_str().unwrap() {
                "client" => true,
                "server" => false,
                other => panic!("{name}: side desconocido ({other})"),
            };

            if expect.get("error").is_some() {
                errores += 1;
                let err = if client { decode_client_hello(json).err() } else { decode_server_hello(json).err() };
                assert!(matches!(err, Some(ProtocolError::Invalid(_))), "{name}: debía fallar");
            } else if client {
                let got = decode_client_hello(json).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert_eq!(&serde_json::to_value(&got).unwrap(), expect, "{name}");
            } else {
                let got = decode_server_hello(json).unwrap_or_else(|e| panic!("{name}: {e}"));
                match &got {
                    ServerHello::Accepted { .. } => aceptados += 1,
                    ServerHello::Rejected { .. } => rechazados += 1,
                }
                let again: Value = serde_json::from_slice(&encode_server_hello(&got)).unwrap();
                assert_eq!(&again, expect, "{name}");
            }
        }
        assert!(aceptados >= 2 && rechazados >= 3 && errores >= 20);
    }

    #[test]
    fn client_hello_ida_y_vuelta() {
        let hellos = [
            ClientHello { v: 2, device_id: "dev-1".into(), device_name: "Pixel 8".into(), will_send_clip: None, pairing_token: None },
            ClientHello { v: 2, device_id: "dev-1".into(), device_name: "Pixel 8".into(), will_send_clip: Some(false), pairing_token: None },
            ClientHello {
                v: 2,
                device_id: "dev-ñ".into(),
                device_name: "Móvil 😀".into(),
                will_send_clip: Some(true),
                pairing_token: Some(TOKEN.into()),
            },
        ];
        for h in hellos {
            let bytes = serde_json::to_vec(&h).unwrap();
            assert_eq!(decode_client_hello(&bytes).unwrap(), h);
        }
    }

    #[test]
    fn client_hello_sin_opcionales_no_lleva_esas_claves() {
        let h = ClientHello { v: 2, device_id: "a".into(), device_name: "b".into(), will_send_clip: None, pairing_token: None };
        let json: Value = serde_json::to_value(&h).unwrap();
        assert_eq!(json, serde_json::json!({ "v": 2, "deviceId": "a", "deviceName": "b" }));
    }

    #[test]
    fn server_hello_ida_y_vuelta() {
        let hellos = [
            ServerHello::accept("pc-1", "PC de Javier"),
            ServerHello::reject(RejectReason::NotPaired),
            ServerHello::reject(RejectReason::PairingExpired),
        ];
        for h in hellos {
            assert_eq!(decode_server_hello(&encode_server_hello(&h)).unwrap(), h);
        }
    }

    #[test]
    fn server_hello_json_exacto() {
        let acc: Value = serde_json::from_slice(&encode_server_hello(&ServerHello::accept("pc-1", "PC"))).unwrap();
        assert_eq!(acc, serde_json::json!({ "v": 2, "accepted": true, "deviceId": "pc-1", "pcName": "PC" }));
        let rej: Value =
            serde_json::from_slice(&encode_server_hello(&ServerHello::reject(RejectReason::PairingExpired))).unwrap();
        assert_eq!(rej, serde_json::json!({ "v": 2, "accepted": false, "reason": "pairing_expired" }));
    }

    #[test]
    fn as_str_coincide_con_el_json() {
        for r in [RejectReason::NotPaired, RejectReason::PairingExpired] {
            assert_eq!(serde_json::to_value(r).unwrap(), Value::String(r.as_str().into()));
        }
    }

    #[test]
    fn utf8_invalido_es_error() {
        assert!(decode_client_hello(&[0x7b, 0xff, 0x7d]).is_err());
        assert!(decode_server_hello(&[0x7b, 0xff, 0x7d]).is_err());
    }
}
