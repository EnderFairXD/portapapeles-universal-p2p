//! Identidad del PC: la clave estática X25519 que guarda `identity.key` en `app_data_dir`.
//! Incluye los auxiliares de escritura atómica y de apartado de archivos dañados, que
//! comparte `pairing.rs` para `paired.json`.

use std::io::Write;
use std::path::Path;

use crate::protocol::secure::StaticKeys;

/// Nombre del archivo con los 32 bytes de la clave privada.
pub const IDENTITY_FILE: &str = "identity.key";

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[identidad] {msg}");
}

/// Carga la identidad de `dir`, o la crea si no existe. Con `dir = None` devuelve una clave
/// efímera (solo en memoria). Si `identity.key` está dañado se aparta como `.bad` y se crea
/// otra; si no se puede guardar, la clave sirve igualmente mientras dure el proceso.
pub fn load_or_create(dir: Option<&Path>) -> StaticKeys {
    load_or_create_status(dir).0
}

/// Como `load_or_create`, y además dice si la clave quedó guardada en disco (`true`). Con
/// `false` la identidad es efímera: los móviles tendrán que emparejarse de nuevo al reiniciar.
pub fn load_or_create_status(dir: Option<&Path>) -> (StaticKeys, bool) {
    let Some(dir) = dir else {
        static AVISO: std::sync::Once = std::sync::Once::new();
        AVISO.call_once(|| log("identidad efímera: no se guarda en disco"));
        return (StaticKeys::generate(), false);
    };
    let ruta = dir.join(IDENTITY_FILE);
    match std::fs::read(&ruta) {
        Ok(bytes) => match <[u8; 32]>::try_from(bytes.as_slice()) {
            Ok(privada) => return (StaticKeys::from_private(privada), true),
            Err(_) => {
                log(&format!("{IDENTITY_FILE} dañado ({} bytes en vez de 32)", bytes.len()));
                set_aside(&ruta);
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            // Ilegible por otra causa (permisos…): no se pisa; se usa una clave efímera.
            log(&format!("no se puede leer {IDENTITY_FILE}: {e}; identidad efímera"));
            return (StaticKeys::generate(), false);
        }
    }
    let keys = StaticKeys::generate();
    let guardada = std::fs::create_dir_all(dir).and_then(|()| write_private_atomic(&ruta, &keys.private));
    if let Err(e) = &guardada {
        log(&format!("no se puede guardar {IDENTITY_FILE}: {e}; identidad efímera"));
    }
    (keys, guardada.is_ok())
}

/// Aparta un archivo dañado como `<nombre>.bad` (sustituyendo uno anterior) y lo avisa por stderr.
pub(super) fn set_aside(ruta: &Path) {
    let mut bad = ruta.as_os_str().to_owned();
    bad.push(".bad");
    let bad = std::path::PathBuf::from(bad);
    let _ = std::fs::remove_file(&bad);
    match std::fs::rename(ruta, &bad) {
        Ok(()) => log(&format!("{} apartado como {}", ruta.display(), bad.display())),
        Err(e) => log(&format!("no se pudo apartar {}: {e}", ruta.display())),
    }
}

/// Escribe `bytes` en `<ruta>.tmp` (modo 0600 en Unix) y lo renombra sobre `ruta`.
pub(super) fn write_private_atomic(ruta: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = ruta.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    // Un .tmp de una ejecución anterior conservaría su modo: se parte siempre de cero.
    let _ = std::fs::remove_file(&tmp);
    let mut opciones = std::fs::OpenOptions::new();
    opciones.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opciones.mode(0o600);
    }
    let escrito = opciones.open(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    if let Err(e) = escrito {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, ruta).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identidad_se_crea_y_se_relee_igual() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create(Some(dir.path()));
        assert!(dir.path().join(IDENTITY_FILE).exists());
        assert_eq!(std::fs::read(dir.path().join(IDENTITY_FILE)).unwrap(), a.private);
        let b = load_or_create(Some(dir.path()));
        assert_eq!(a.private, b.private);
        assert_eq!(a.public, b.public);
        assert!(!dir.path().join("identity.key.tmp").exists());
    }

    #[test]
    fn identidad_en_directorio_inexistente_lo_crea() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a").join("b");
        let a = load_or_create(Some(&sub));
        assert_eq!(load_or_create(Some(&sub)).private, a.private);
    }

    #[cfg(unix)]
    #[test]
    fn identidad_con_permisos_600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create(Some(dir.path()));
        let modo = std::fs::metadata(dir.path().join(IDENTITY_FILE)).unwrap().permissions().mode();
        assert_eq!(modo & 0o777, 0o600);
    }

    #[test]
    fn identidad_danada_se_aparta_y_se_crea_otra() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(IDENTITY_FILE), [1u8, 2, 3, 4, 5]).unwrap();
        let keys = load_or_create(Some(dir.path()));
        assert_eq!(std::fs::read(dir.path().join("identity.key.bad")).unwrap(), vec![1u8, 2, 3, 4, 5]);
        let nueva = std::fs::read(dir.path().join(IDENTITY_FILE)).unwrap();
        assert_eq!(nueva.len(), 32);
        assert_eq!(nueva, keys.private);
        assert_eq!(StaticKeys::from_private(keys.private).public, keys.public);
    }

    #[test]
    fn identidad_sin_directorio_es_efimera_y_distinta_cada_vez() {
        let a = load_or_create(None);
        let b = load_or_create(None);
        assert_ne!(a.private, b.private);
    }

    #[test]
    fn identidad_guardada_se_marca_como_persistida() {
        let dir = tempfile::tempdir().unwrap();
        let (a, persistida) = load_or_create_status(Some(dir.path()));
        assert!(persistida);
        let (b, persistida) = load_or_create_status(Some(dir.path()));
        assert!(persistida);
        assert_eq!(a.private, b.private);
    }

    #[test]
    fn identidad_sin_directorio_no_esta_persistida() {
        assert!(!load_or_create_status(None).1);
    }

    #[test]
    fn identidad_en_ruta_que_es_un_archivo_no_esta_persistida() {
        let dir = tempfile::tempdir().unwrap();
        let archivo = dir.path().join("no-es-carpeta");
        std::fs::write(&archivo, b"x").unwrap();
        let (_, persistida) = load_or_create_status(Some(&archivo));
        assert!(!persistida);
    }

    #[cfg(unix)]
    #[test]
    fn identidad_en_directorio_de_solo_lectura_no_esta_persistida() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ro = dir.path().join("ro");
        std::fs::create_dir(&ro).unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
        let (_, persistida) = load_or_create_status(Some(&ro));
        let escribible = std::fs::write(ro.join("sonda"), b"x").is_ok();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
        if escribible {
            return; // root escribe igualmente: no se puede simular
        }
        assert!(!persistida);
        assert!(!ro.join(IDENTITY_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn identidad_ilegible_no_se_pisa_y_no_esta_persistida() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let original = load_or_create_status(Some(dir.path())).0;
        let ruta = dir.path().join(IDENTITY_FILE);
        std::fs::set_permissions(&ruta, std::fs::Permissions::from_mode(0o000)).unwrap();
        let ilegible = std::fs::read(&ruta).is_err();
        let (otra, persistida) = load_or_create_status(Some(dir.path()));
        std::fs::set_permissions(&ruta, std::fs::Permissions::from_mode(0o600)).unwrap();
        if !ilegible {
            return; // root: no se puede simular
        }
        assert!(!persistida);
        assert_ne!(otra.private, original.private);
        assert_eq!(std::fs::read(&ruta).unwrap(), original.private);
    }

    #[test]
    fn escritura_atomica_reemplaza_el_contenido() {
        let dir = tempfile::tempdir().unwrap();
        let ruta = dir.path().join("x.json");
        write_private_atomic(&ruta, b"uno").unwrap();
        write_private_atomic(&ruta, b"dos").unwrap();
        assert_eq!(std::fs::read(&ruta).unwrap(), b"dos");
        assert!(!dir.path().join("x.json.tmp").exists());
    }
}
