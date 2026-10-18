//! Emparejamiento por QR: tokens de un solo uso, dispositivos emparejados (`paired.json`),
//! huella de la clave, URI del QR y su imagen SVG.

use std::io::Write;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::identity::{set_aside, write_private_atomic};

/// Vida de un token de emparejamiento: 5 minutos.
pub const PAIRING_TTL_MS: u64 = 300_000;

/// Versión del formato de `paired.json`.
const PAIRED_FILE_VERSION: u32 = 1;

/// Longitud máxima, en caracteres, del nombre del PC dentro del QR.
const MAX_NAME_CHARS: usize = 64;

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[emparejamiento] {msg}");
}

#[derive(Clone, Debug, PartialEq)]
pub struct PairingOffer {
    pub token: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, PartialEq)]
pub enum TokenCheck {
    Valid,
    Expired,
    Unknown,
}

struct Issued {
    token: String,
    expires_at_ms: u64,
    used: bool,
}

/// Token de emparejamiento vigente (como mucho uno): 128 bits aleatorios, 5 minutos, un uso.
#[derive(Default)]
pub struct PairingTokens {
    current: Option<Issued>,
}

/// Comparación en tiempo constante (OR de XOR sobre los bytes).
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl PairingTokens {
    /// Emite un token nuevo; sustituye (e invalida) al anterior.
    pub fn offer(&mut self, now_ms: u64) -> PairingOffer {
        let mut bytes = [0u8; 16];
        if let Err(e) = getrandom::fill(&mut bytes) {
            // El sistema no da aleatoriedad: no se emite ningún token usable.
            log(&format!("sin aleatoriedad para el token: {e}"));
            self.current = None;
            return PairingOffer { token: String::new(), expires_at_ms: now_ms };
        }
        let offer = PairingOffer {
            token: URL_SAFE_NO_PAD.encode(bytes),
            expires_at_ms: now_ms.saturating_add(PAIRING_TTL_MS),
        };
        self.current = Some(Issued { token: offer.token.clone(), expires_at_ms: offer.expires_at_ms, used: false });
        offer
    }

    /// Descarta el token vigente: lo que llegue después con él es `Unknown`.
    pub fn cancel(&mut self) {
        self.current = None;
    }

    /// La oferta vigente, solo si no se ha usado ni ha caducado.
    pub fn active(&self, now_ms: u64) -> Option<PairingOffer> {
        self.current
            .as_ref()
            .filter(|i| !i.used && now_ms < i.expires_at_ms)
            .map(|i| PairingOffer { token: i.token.clone(), expires_at_ms: i.expires_at_ms })
    }

    /// Comprueba un token recibido y, si es válido, lo marca como usado.
    pub fn check_and_consume(&mut self, token: &str, now_ms: u64) -> TokenCheck {
        let Some(issued) = self.current.as_mut() else {
            return TokenCheck::Unknown;
        };
        if !constant_time_eq(&issued.token, token) {
            return TokenCheck::Unknown;
        }
        if issued.used || now_ms >= issued.expires_at_ms {
            return TokenCheck::Expired;
        }
        issued.used = true;
        TokenCheck::Valid
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    /// Clave pública del móvil en hex minúscula (64 caracteres).
    pub public_key: String,
    pub device_id: String,
    pub device_name: String,
    pub paired_at_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct PairedFile {
    v: u32,
    devices: Vec<PairedDevice>,
}

/// Móviles emparejados, persistidos en `paired.json`.
pub struct PairedStore {
    path: Option<PathBuf>,
    devices: Vec<PairedDevice>,
    /// `paired.json` existe pero no se pudo leer: no se guarda nada hasta poder leerlo, para no
    /// pisar la lista real con una vacía.
    load_failed: bool,
}

impl PairedStore {
    /// Carga `paired.json`. Sin ruta solo vive en memoria (tests). Un archivo dañado se
    /// aparta como `.bad` y se empieza de cero; uno ilegible (permisos…) no se toca: se
    /// recuerda el fallo (`load_failed`) y no se guarda nada hasta poder leerlo.
    pub fn load(path: Option<PathBuf>) -> Self {
        let (devices, load_failed) = match path.as_deref() {
            Some(p) => Self::read(p),
            None => (Vec::new(), false),
        };
        Self { path, devices, load_failed }
    }

    /// Lista leída y si la lectura falló sin ser «no existe».
    fn read(path: &std::path::Path) -> (Vec<PairedDevice>, bool) {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), false),
            Err(e) => {
                log(&format!("no se puede leer {}: {e}", path.display()));
                return (Vec::new(), true);
            }
        };
        match serde_json::from_slice::<PairedFile>(&bytes) {
            Ok(f) if f.v == PAIRED_FILE_VERSION => (f.devices, false),
            _ => {
                log(&format!("{} dañado o de otra versión", path.display()));
                set_aside(path);
                (Vec::new(), false)
            }
        }
    }

    /// `true` si `paired.json` no se pudo leer y los emparejamientos nuevos no se guardan.
    pub fn load_failed(&self) -> bool {
        self.load_failed
    }

    /// Con `load_failed`, vuelve a intentar leer el archivo; si ya se puede, incorpora lo leído
    /// (sin pisar lo que haya en memoria) y borra el fallo.
    fn retry_load(&mut self) {
        let Some(path) = self.path.clone() else {
            return;
        };
        let (leidos, sigue_fallando) = Self::read(&path);
        if sigue_fallando {
            return;
        }
        for d in leidos {
            if !self.devices.iter().any(|x| x.public_key == d.public_key) {
                self.devices.push(d);
            }
        }
        self.load_failed = false;
        log("paired.json vuelve a ser legible");
    }

    fn persist(&self, devices: &[PairedDevice]) -> std::io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if self.load_failed {
            return Err(std::io::Error::other("paired.json no se pudo leer: no se guarda para no pisarlo"));
        }
        let file = PairedFile { v: PAIRED_FILE_VERSION, devices: devices.to_vec() };
        let json = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_private_atomic(path, &json)
    }

    /// Si no está y la carga había fallado, reintenta leer el archivo una vez.
    pub fn contains(&mut self, public_key_hex: &str) -> bool {
        if self.devices.iter().any(|d| d.public_key == public_key_hex) {
            return true;
        }
        if self.load_failed {
            self.retry_load();
            return self.devices.iter().any(|d| d.public_key == public_key_hex);
        }
        false
    }

    /// Añade el dispositivo; con la misma clave actualiza nombre e id y conserva la fecha de
    /// emparejamiento original. Si no se puede guardar, el estado no cambia.
    pub fn upsert(&mut self, d: PairedDevice) -> std::io::Result<()> {
        let mut nuevos = self.devices.clone();
        match nuevos.iter_mut().find(|x| x.public_key == d.public_key) {
            Some(existente) => {
                existente.device_id = d.device_id;
                existente.device_name = d.device_name;
            }
            None => nuevos.push(d),
        }
        self.persist(&nuevos)?;
        self.devices = nuevos;
        Ok(())
    }

    /// Olvida un dispositivo. `Ok(false)` si no estaba emparejado.
    pub fn remove(&mut self, public_key_hex: &str) -> std::io::Result<bool> {
        if !self.contains(public_key_hex) {
            return Ok(false);
        }
        let nuevos: Vec<PairedDevice> = self.devices.iter().filter(|d| d.public_key != public_key_hex).cloned().collect();
        self.persist(&nuevos)?;
        self.devices = nuevos;
        Ok(true)
    }

    /// Dispositivos ordenados por fecha de emparejamiento.
    pub fn list(&self) -> Vec<PairedDevice> {
        let mut lista = self.devices.clone();
        lista.sort_by_key(|d| d.paired_at_ms);
        lista
    }
}

/// Huella corta de una clave pública: 16 hex minúscula (8 primeros bytes de su SHA-256).
pub fn fingerprint(public_key: &[u8; 32]) -> String {
    hex::encode(&Sha256::digest(public_key)[..8])
}

/// Conserva `A-Z a-z 0-9 - . _ ~`; el resto va como `%XX` mayúscula sobre UTF-8.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// URI del QR: `clipsync://pair?v=2&pk=…&t=…&n=…&ip=…&port=…`. El nombre se recorta a 64
/// caracteres (Unicode, no bytes) antes de codificarlo.
pub fn pairing_uri(public_key: &[u8; 32], token: &str, pc_name: &str, ips: &[Ipv4Addr], port: u16) -> String {
    let nombre: String = pc_name.chars().take(MAX_NAME_CHARS).collect();
    let ips: Vec<String> = ips.iter().map(|ip| ip.to_string()).collect();
    format!(
        "clipsync://pair?v=2&pk={}&t={}&n={}&ip={}&port={}",
        URL_SAFE_NO_PAD.encode(public_key),
        token,
        percent_encode(&nombre),
        ips.join(","),
        port
    )
}

/// SVG del QR (corrección M, mínimo 240×240). Con el nombre recortado la URI siempre cabe;
/// si aun así no se pudiera codificar, devuelve una cadena vacía.
pub fn qr_svg(uri: &str) -> String {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};
    match QrCode::with_error_correction_level(uri.as_bytes(), EcLevel::M) {
        Ok(code) => code.render::<svg::Color>().min_dimensions(240, 240).build(),
        Err(_) => String::new(),
    }
}

/// Máximo de direcciones IPv4 que lleva el QR.
pub const MAX_QR_IPS: usize = 4;

/// Prefijos (sin mayúsculas) de interfaces virtuales que no sirven para llegar al PC desde el móvil.
const PREFIJOS_VIRTUALES: [&str; 6] = ["docker", "br-", "veth", "virbr", "vethernet", "virtualbox"];

/// Descarta las direcciones de interfaces virtuales (Docker, puentes, VMs) por el prefijo de su nombre.
pub fn filtrar_interfaces(interfaces: Vec<(String, IpAddr)>) -> Vec<IpAddr> {
    interfaces
        .into_iter()
        .filter(|(nombre, _)| {
            let nombre = nombre.to_lowercase();
            !PREFIJOS_VIRTUALES.iter().any(|p| nombre.starts_with(p))
        })
        .map(|(_, ip)| ip)
        .collect()
}

/// Direcciones del QR: sin interfaces virtuales, filtradas y ordenadas por `order_ips`, y como
/// mucho `MAX_QR_IPS`.
pub fn qr_ips(interfaces: Vec<(String, IpAddr)>) -> Vec<Ipv4Addr> {
    let mut ips = order_ips(filtrar_interfaces(interfaces));
    ips.truncate(MAX_QR_IPS);
    ips
}

/// Solo IPv4, sin loopback ni 169.254/16 ni 0.0.0.0, sin repetidas; primero las privadas
/// (10/8, 172.16/12, 192.168/16) y luego el resto, conservando el orden de entrada en cada grupo.
pub fn order_ips(ips: Vec<IpAddr>) -> Vec<Ipv4Addr> {
    let mut vistas: Vec<Ipv4Addr> = Vec::new();
    for ip in ips {
        if let IpAddr::V4(v4) = ip {
            if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified() && !vistas.contains(&v4) {
                vistas.push(v4);
            }
        }
    }
    let (privadas, otras): (Vec<_>, Vec<_>) = vistas.into_iter().partition(|ip| ip.is_private());
    privadas.into_iter().chain(otras).collect()
}

/// Direcciones IPv4 de las interfaces de red del PC, ya filtradas, ordenadas y limitadas.
pub fn lan_ipv4s() -> Vec<Ipv4Addr> {
    match if_addrs::get_if_addrs() {
        Ok(interfaces) => qr_ips(interfaces.iter().map(|i| (i.name.clone(), i.ip())).collect()),
        Err(e) => {
            log(&format!("no se pueden listar las interfaces de red: {e}"));
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dispositivo(clave: &str, id: &str, nombre: &str, t: u64) -> PairedDevice {
        PairedDevice { public_key: clave.into(), device_id: id.into(), device_name: nombre.into(), paired_at_ms: t }
    }

    #[test]
    fn token_tiene_22_caracteres_base64url_y_cambia() {
        let mut t = PairingTokens::default();
        let a = t.offer(0);
        let b = t.offer(0);
        assert_eq!(a.token.len(), 22);
        assert!(a.token.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
        assert_ne!(a.token, b.token);
        assert_eq!(a.expires_at_ms, PAIRING_TTL_MS);
    }

    #[test]
    fn token_valido_una_sola_vez() {
        let mut t = PairingTokens::default();
        let o = t.offer(0);
        assert_eq!(t.check_and_consume(&o.token, 1), TokenCheck::Valid);
        assert_eq!(t.check_and_consume(&o.token, 2), TokenCheck::Expired);
        assert_eq!(t.active(3), None);
    }

    #[test]
    fn token_caduca_a_los_5_minutos() {
        let mut t = PairingTokens::default();
        let t1 = t.offer(0);
        assert_eq!(t.check_and_consume(&t1.token, 299_999), TokenCheck::Valid);
        let t2 = t.offer(0);
        assert_eq!(t.check_and_consume(&t2.token, 300_000), TokenCheck::Expired);
    }

    #[test]
    fn oferta_nueva_invalida_la_anterior_y_cancel_tambien() {
        let mut t = PairingTokens::default();
        let viejo = t.offer(0);
        let nuevo = t.offer(10);
        assert_eq!(t.check_and_consume(&viejo.token, 20), TokenCheck::Unknown);
        assert_eq!(t.check_and_consume("otro-cualquiera-00000000", 20), TokenCheck::Unknown);
        t.cancel();
        assert_eq!(t.check_and_consume(&nuevo.token, 20), TokenCheck::Unknown);
        assert_eq!(t.active(20), None);
    }

    #[test]
    fn active_devuelve_la_oferta_solo_si_vigente() {
        let mut t = PairingTokens::default();
        assert_eq!(t.active(0), None);
        let o = t.offer(100);
        assert_eq!(t.active(100), Some(o.clone()));
        assert_eq!(t.active(100 + PAIRING_TTL_MS - 1), Some(o));
        assert_eq!(t.active(100 + PAIRING_TTL_MS), None);
    }

    #[test]
    fn paired_store_persiste_upsert_y_remove() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("paired.json");
        let mut s = PairedStore::load(Some(ruta.clone()));
        assert!(s.list().is_empty());
        s.upsert(dispositivo("bb", "id-b", "Segundo", 20)).unwrap();
        s.upsert(dispositivo("aa", "id-a", "Primero", 10)).unwrap();
        assert!(s.contains("aa") && s.contains("bb") && !s.contains("cc"));

        // misma clave: actualiza nombre e id, conserva la fecha de emparejamiento
        s.upsert(dispositivo("aa", "id-a2", "Primero renombrado", 99)).unwrap();
        let lista = s.list();
        assert_eq!(lista.len(), 2);
        assert_eq!(lista[0], dispositivo("aa", "id-a2", "Primero renombrado", 10));
        assert_eq!(lista[1].public_key, "bb");

        // se relee igual desde disco, con el formato de la spec
        let s2 = PairedStore::load(Some(ruta.clone()));
        assert_eq!(s2.list(), lista);
        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&ruta).unwrap()).unwrap();
        assert_eq!(json["v"], 1);
        // en disco van por orden de alta; `list()` es la que ordena por fecha
        assert_eq!(json["devices"][1]["publicKey"], "aa");
        assert_eq!(json["devices"][1]["pairedAtMs"], 10);

        assert!(s.remove("aa").unwrap());
        assert!(!s.remove("aa").unwrap());
        assert!(!s.contains("aa"));
        assert_eq!(PairedStore::load(Some(ruta)).list().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn paired_json_se_escribe_con_permisos_600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("paired.json");
        PairedStore::load(Some(ruta.clone())).upsert(dispositivo("aa", "i", "n", 1)).unwrap();
        assert_eq!(std::fs::metadata(&ruta).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn paired_store_en_memoria_no_toca_el_disco() {
        let mut s = PairedStore::load(None);
        s.upsert(dispositivo("aa", "i", "n", 1)).unwrap();
        assert!(s.contains("aa"));
        assert!(s.remove("aa").unwrap());
        assert!(s.list().is_empty());
    }

    #[test]
    fn paired_json_danado_se_aparta() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("paired.json");
        std::fs::write(&ruta, b"{ esto no es json").unwrap();
        let mut s = PairedStore::load(Some(ruta.clone()));
        assert!(s.list().is_empty());
        assert_eq!(std::fs::read(dir.path().join("paired.json.bad")).unwrap(), b"{ esto no es json");
        assert!(!ruta.exists());
        // y se puede seguir usando
        s.upsert(dispositivo("aa", "i", "n", 1)).unwrap();
        assert_eq!(PairedStore::load(Some(ruta)).list().len(), 1);
    }

    /// Deja `ruta` ilegible (modo 000). `false` si no sirve: se ejecuta como root.
    #[cfg(unix)]
    fn hacer_ilegible(ruta: &std::path::Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(ruta, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::read(ruta).is_err()
    }

    #[cfg(unix)]
    fn restaurar_permisos(ruta: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(ruta, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn paired_json_ilegible_no_se_pisa_y_se_recupera() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("paired.json");
        let mut previo = PairedStore::load(Some(ruta.clone()));
        previo.upsert(dispositivo("aa", "id-a", "Primero", 10)).unwrap();
        let original = std::fs::read(&ruta).unwrap();
        if !hacer_ilegible(&ruta) {
            return; // root lee igualmente: no se puede simular
        }

        let mut s = PairedStore::load(Some(ruta.clone()));
        assert!(s.load_failed());
        assert!(!s.contains("aa"));
        // mientras siga ilegible no se guarda nada ni se toca el archivo
        assert!(s.upsert(dispositivo("bb", "id-b", "Segundo", 20)).is_err());
        assert!(!s.contains("bb"));
        assert!(s.load_failed());

        restaurar_permisos(&ruta);
        assert_eq!(std::fs::read(&ruta).unwrap(), original, "el archivo no debe cambiar");
        // ya legible: contains() reintenta la lectura y recupera la lista
        assert!(s.contains("aa"));
        assert!(!s.load_failed());
        s.upsert(dispositivo("bb", "id-b", "Segundo", 20)).unwrap();
        let guardados = PairedStore::load(Some(ruta)).list();
        assert_eq!(guardados.len(), 2);
    }

    #[test]
    fn paired_store_sano_no_marca_fallo_de_carga() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!PairedStore::load(Some(dir.path().join("paired.json"))).load_failed());
        assert!(!PairedStore::load(None).load_failed());
    }

    #[test]
    fn interfaces_virtuales_se_descartan_por_prefijo_sin_mayusculas() {
        let ip = |s: &str| -> IpAddr { s.parse().unwrap() };
        let entrada = vec![
            ("wlp3s0".to_string(), ip("192.168.1.5")),
            ("docker0".to_string(), ip("172.17.0.1")),
            ("br-1a2b3c".to_string(), ip("172.18.0.1")),
            ("veth12ab".to_string(), ip("10.1.1.1")),
            ("virbr0".to_string(), ip("192.168.122.1")),
            ("vEthernet (WSL)".to_string(), ip("172.30.0.1")),
            ("VirtualBox Host-Only Network".to_string(), ip("192.168.56.1")),
            ("Ethernet".to_string(), ip("10.0.0.2")),
        ];
        assert_eq!(filtrar_interfaces(entrada), vec![ip("192.168.1.5"), ip("10.0.0.2")]);
    }

    #[test]
    fn qr_ips_filtra_ordena_y_limita_a_4() {
        let ip = |s: &str| -> IpAddr { s.parse().unwrap() };
        let entrada: Vec<(String, IpAddr)> = vec![
            ("eth0".into(), ip("8.8.8.8")),
            ("docker0".into(), ip("172.17.0.1")),
            ("eth1".into(), ip("192.168.1.5")),
            ("eth2".into(), ip("10.0.0.2")),
            ("eth3".into(), ip("10.0.1.2")),
            ("eth4".into(), ip("10.0.2.2")),
            ("eth5".into(), ip("10.0.3.2")),
        ];
        let esperado: Vec<Ipv4Addr> = ["192.168.1.5", "10.0.0.2", "10.0.1.2", "10.0.2.2"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(qr_ips(entrada), esperado);
        assert_eq!(MAX_QR_IPS, 4);
    }

    #[test]
    fn order_ips_filtra_y_ordena() {
        let entrada: Vec<IpAddr> = ["127.0.0.1", "169.254.1.2", "8.8.8.8", "192.168.1.5", "::1", "10.0.0.2"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        let esperado: Vec<Ipv4Addr> = ["192.168.1.5", "10.0.0.2", "8.8.8.8"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(order_ips(entrada), esperado);
    }

    #[test]
    fn order_ips_no_repite_y_reconoce_172_16_a_31() {
        let entrada: Vec<IpAddr> = ["172.32.0.1", "172.16.0.1", "172.16.0.1", "172.31.255.1", "1.1.1.1", "1.1.1.1"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        let esperado: Vec<Ipv4Addr> = ["172.16.0.1", "172.31.255.1", "172.32.0.1", "1.1.1.1"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(order_ips(entrada), esperado);
    }

    #[test]
    fn lan_ipv4s_no_devuelve_loopback() {
        assert!(lan_ipv4s().iter().all(|ip| !ip.is_loopback() && !ip.is_link_local()));
    }

    #[test]
    fn fingerprint_son_16_hex_minuscula_de_sha256() {
        // SHA-256 de 32 bytes a cero = 66687aadf862bd77…
        assert_eq!(fingerprint(&[0u8; 32]), "66687aadf862bd77");
    }

    #[test]
    fn nombre_se_recorta_a_64_caracteres_y_se_codifica() {
        let largo = "ñ".repeat(70);
        let uri = pairing_uri(&[0u8; 32], "tok", &largo, &[], 52847);
        let n = uri.split("&n=").nth(1).unwrap().split('&').next().unwrap();
        assert_eq!(n, "%C3%B1".repeat(64));
        assert!(uri.ends_with("&ip=&port=52847"));
    }

    #[test]
    fn pairing_json_build_y_huellas() {
        let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/protocol/test-vectors/pairing.json");
        let escribir = std::env::var("CLIPSYNC_WRITE_VECTORS").as_deref() == Ok("1");
        let raw = if escribir {
            std::fs::read_to_string(&ruta).unwrap()
        } else {
            include_str!("../../../../../packages/protocol/test-vectors/pairing.json").to_string()
        };
        let mut doc: serde_json::Value = serde_json::from_str(&raw).unwrap();

        fn clave(hex_str: &str) -> [u8; 32] {
            hex::decode(hex_str).unwrap().try_into().unwrap()
        }

        for caso in doc["build"].as_array_mut().unwrap() {
            let ips: Vec<Ipv4Addr> = caso["ips"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().parse().unwrap()).collect();
            let uri = pairing_uri(
                &clave(caso["publicKeyHex"].as_str().unwrap()),
                caso["token"].as_str().unwrap(),
                caso["pcName"].as_str().unwrap(),
                &ips,
                caso["port"].as_u64().unwrap() as u16,
            );
            if escribir {
                caso["uri"] = serde_json::Value::String(uri);
            } else {
                assert_eq!(caso["uri"].as_str().unwrap(), uri, "pairing.json: uri de build desactualizada");
            }
        }
        for caso in doc["fingerprints"].as_array_mut().unwrap() {
            let fp = fingerprint(&clave(caso["publicKeyHex"].as_str().unwrap()));
            if escribir {
                caso["fp"] = serde_json::Value::String(fp);
            } else {
                assert_eq!(caso["fp"].as_str().unwrap(), fp, "pairing.json: fp desactualizada");
            }
        }
        // la primera entrada de `parse` es la URI de la primera de `build`
        assert_eq!(doc["parse"][0]["uri"], doc["build"][0]["uri"]);

        let mut json = serde_json::to_string_pretty(&doc).unwrap();
        json.push('\n');
        if escribir {
            std::fs::write(&ruta, &json).unwrap();
            return;
        }
        assert_eq!(raw, json, "pairing.json mal formateado: regenerar con CLIPSYNC_WRITE_VECTORS=1");
    }

    #[test]
    fn qr_svg_es_un_svg() {
        let svg = qr_svg("clipsync://pair?v=2&pk=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8&t=AAECAwQFBgcICQoLDA0ODw&n=PC&ip=192.168.1.5&port=52847");
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"), "{}", &svg[..svg.len().min(40)]);
        assert!(svg.contains("</svg>"));
    }
}
