//! Recepción segura de archivos en disco: nombres saneados, sin sobrescrituras y sin restos.

use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// Máximo de bytes UTF-8 de un nombre de archivo.
const MAX_NAME_BYTES: usize = 200;
/// Máximo de nombres candidatos que se prueban al publicar antes de rendirse.
const MAX_INTENTOS_NOMBRE: u32 = 10_000;

fn es_reservado_windows(nombre: &str) -> bool {
    // La parte anterior al primer punto decide (también con extensión: "CON.txt").
    let base = nombre.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    match base.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => {
            let b = base.as_bytes();
            b.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && (b'1'..=b'9').contains(&b[3])
        }
    }
}

fn recortar_final(s: &str) -> &str {
    s.trim_end_matches(['.', ' '])
}

/// Caracteres que no se admiten: prohibidos en Windows, de control y de formato/bidi
/// (permiten disfrazar la extensión, p. ej. U+202E).
fn es_caracter_prohibido(c: char) -> bool {
    matches!(
        c,
        '<' | '>' | ':' | '"' | '|' | '?' | '*'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}' | '\u{2029}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    ) || c.is_control()
}

/// Deja un nombre seguro para guardar en cualquier sistema: sin rutas, sin caracteres
/// prohibidos en Windows, sin nombres reservados y de 200 bytes como máximo.
/// Es idempotente: `sanitize(sanitize(x)) == sanitize(x)`.
pub fn sanitize_file_name(name: &str) -> String {
    let ultimo = name.rsplit(['/', '\\']).next().unwrap_or("");
    let limpio: String = ultimo.chars().filter(|c| !es_caracter_prohibido(*c)).collect();
    let recortado = recortar_final(&limpio);
    // Un nombre formado solo por puntos y espacios antes de la extensión pasa a "archivo".
    let mut nombre = con_stem_valido(recortado);
    if nombre.len() > MAX_NAME_BYTES {
        nombre = truncar(&nombre);
    }
    // El chequeo de reservados va después de recortar/truncar: esas operaciones pueden
    // dejar un nombre reservado ("CON" + espacios + "x.txt" -> "CON.txt").
    if es_reservado_windows(&nombre) {
        nombre.insert(0, '_');
        if nombre.len() > MAX_NAME_BYTES {
            nombre = truncar(&nombre);
        }
    }
    nombre
}

/// Sustituye un stem sin ningún carácter útil (solo puntos/espacios, o vacío) por "archivo".
fn con_stem_valido(nombre: &str) -> String {
    let (stem, ext) = separar_extension(nombre);
    if recortar_final(stem).trim_start_matches(['.', ' ']).is_empty() {
        format!("archivo{ext}")
    } else {
        nombre.to_string()
    }
}

/// Corta a `MAX_NAME_BYTES` respetando límites de carácter y conservando la extensión.
fn truncar(nombre: &str) -> String {
    let (stem, ext) = separar_extension(nombre);
    // Una extensión desmesurada no se conserva: se trata el nombre entero como stem.
    let (stem, ext) = if ext.len() < MAX_NAME_BYTES / 2 { (stem, ext) } else { (nombre, "") };
    let mut limite = MAX_NAME_BYTES - ext.len();
    while !stem.is_char_boundary(limite) {
        limite -= 1;
    }
    let corto = recortar_final(&stem[..limite]);
    if corto.trim_start_matches(['.', ' ']).is_empty() {
        format!("archivo{ext}")
    } else {
        format!("{corto}{ext}")
    }
}

/// Separa "foto.jpg" en ("foto", ".jpg"). Sin extensión (o solo punto inicial): (nombre, "").
fn separar_extension(nombre: &str) -> (&str, &str) {
    match nombre.rfind('.') {
        Some(i) if i > 0 => nombre.split_at(i),
        _ => (nombre, ""),
    }
}

fn existe(ruta: &Path) -> bool {
    // symlink_metadata también detecta enlaces rotos
    ruta.symlink_metadata().is_ok()
}

/// Candidato número `n` para `nombre` (ya saneado): `nombre.ext`, `nombre (1).ext`, …
fn candidato(dir: &Path, nombre: &str, n: u32) -> PathBuf {
    if n == 0 {
        return dir.join(nombre);
    }
    let (stem, ext) = separar_extension(nombre);
    dir.join(format!("{stem} ({n}){ext}"))
}

/// Ruta libre dentro de `dir`: `nombre.ext`, o `nombre (1).ext`, `nombre (2).ext`, …
/// Solo es una consulta: no reserva nada (`FileReceiver` reserva de forma atómica).
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let nombre = sanitize_file_name(file_name);
    (0u32..)
        .map(|n| candidato(dir, &nombre, n))
        .find(|p| !existe(p))
        .expect("u32 agotado")
}

/// Recibe un archivo en `<nombre>.part` y calcula su SHA-256 sobre la marcha.
/// El nombre final se decide en `finish`. Si se descarta sin `finish`/`abort`, el `.part` se borra.
pub struct FileReceiver {
    dir: PathBuf,
    nombre: String,
    part: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    received: u64,
    /// Ya se renombró o se borró el `.part`: `Drop` no tiene nada que limpiar.
    cerrado: bool,
}

impl FileReceiver {
    pub fn create(dir: &Path, name: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let nombre = sanitize_file_name(name);
        // create_new evita pisar el .part de otra transferencia con el mismo nombre
        for n in 0u32.. {
            let candidato = if n == 0 {
                format!("{nombre}.part")
            } else {
                format!("{nombre} ({n}).part")
            };
            let part = dir.join(candidato);
            match OpenOptions::new().write(true).create_new(true).open(&part) {
                Ok(file) => {
                    return Ok(Self {
                        dir: dir.to_path_buf(),
                        nombre,
                        part,
                        file: Some(file),
                        hasher: Sha256::new(),
                        received: 0,
                        cerrado: false,
                    })
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        unreachable!()
    }

    pub fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("receptor cerrado"))?;
        file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.received += bytes.len() as u64;
        Ok(())
    }

    pub fn received(&self) -> u64 {
        self.received
    }

    /// Si el hash coincide, renombra el `.part` a un nombre libre y devuelve la ruta final.
    /// Si no, borra el `.part` y devuelve `Err("checksum_mismatch")`.
    pub fn finish(mut self, expected_sha256: &str) -> Result<PathBuf, String> {
        let calculado = hex::encode(self.hasher.finalize_reset());
        let res = if calculado.eq_ignore_ascii_case(expected_sha256) {
            self.publicar()
        } else {
            Err("checksum_mismatch".to_string())
        };
        // Si falló, el .part se borra aquí; tras publicar con éxito `cerrado` evita tocarlo
        self.limpiar();
        res
    }

    pub fn abort(mut self) {
        self.limpiar();
    }

    /// Sincroniza y mueve el `.part` a un nombre final libre, sin sobrescribir nunca:
    /// el destino se reserva con `create_new` (atómico) y solo entonces se renombra encima
    /// del propio marcador.
    fn publicar(&mut self) -> Result<PathBuf, String> {
        let file = self.file.take().ok_or("receptor cerrado")?;
        file.sync_all().map_err(|e| format!("io_error: {e}"))?;
        drop(file); // cerrar antes de renombrar (Windows)
        for n in 0..MAX_INTENTOS_NOMBRE {
            let destino = candidato(&self.dir, &self.nombre, n);
            match OpenOptions::new().write(true).create_new(true).open(&destino) {
                Ok(marcador) => {
                    drop(marcador);
                    return match std::fs::rename(&self.part, &destino) {
                        Ok(()) => {
                            self.cerrado = true; // el .part ya no existe
                            Ok(destino)
                        }
                        Err(e) => {
                            let _ = std::fs::remove_file(&destino);
                            Err(format!("io_error: {e}"))
                        }
                    };
                }
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("io_error: {e}")),
            }
        }
        Err("io_error: demasiados nombres ocupados".to_string())
    }

    fn limpiar(&mut self) {
        self.file = None;
        if !self.cerrado {
            self.cerrado = true;
            let _ = std::fs::remove_file(&self.part);
        }
    }
}

impl Drop for FileReceiver {
    fn drop(&mut self) {
        self.limpiar();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sha(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    fn nombres_en(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn sanea_rutas_y_nombres_reservados() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\x\\a.txt"), "a.txt");
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name(""), "archivo");
        assert_eq!(sanitize_file_name("a?b*.txt"), "ab.txt");
        assert!(sanitize_file_name(&format!("{}.pdf", "x".repeat(300))).ends_with(".pdf"));
    }

    #[test]
    fn sanea_casos_limite() {
        assert_eq!(sanitize_file_name("a/"), "archivo");
        assert_eq!(sanitize_file_name(".."), "archivo");
        assert_eq!(sanitize_file_name("."), "archivo");
        assert_eq!(sanitize_file_name("nombre. . "), "nombre");
        assert_eq!(sanitize_file_name("a\u{0}b\nc\u{7f}.txt"), "abc.txt");
        assert_eq!(sanitize_file_name("<>:\"|?*"), "archivo");
        assert_eq!(sanitize_file_name("con"), "_con");
        assert_eq!(sanitize_file_name("Lpt9.tar.gz"), "_Lpt9.tar.gz");
        assert_eq!(sanitize_file_name("COM1"), "_COM1");
        assert_eq!(sanitize_file_name("COM0.txt"), "COM0.txt");
        assert_eq!(sanitize_file_name("CONSOLA.txt"), "CONSOLA.txt");
        assert_eq!(sanitize_file_name("informe final.pdf"), "informe final.pdf");
    }

    #[test]
    fn limita_a_200_bytes_conservando_extension() {
        let n = sanitize_file_name(&format!("{}.pdf", "x".repeat(300)));
        assert_eq!(n.len(), 200);
        assert!(n.ends_with(".pdf"));
        // multibyte: no corta a mitad de carácter
        let n = sanitize_file_name(&format!("{}.txt", "ñ".repeat(150)));
        assert!(n.len() <= 200);
        assert!(n.ends_with(".txt"));
        // sin extensión
        assert_eq!(sanitize_file_name(&"y".repeat(500)).len(), 200);
        // extensión absurdamente larga: igualmente <= 200
        let n = sanitize_file_name(&format!("a.{}", "z".repeat(400)));
        assert!(n.len() <= 200 && !n.is_empty());
    }

    #[test]
    fn unique_path_no_sobrescribe() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        assert_eq!(unique_path(dir, "foto.jpg"), dir.join("foto.jpg"));
        fs::write(dir.join("foto.jpg"), b"1").unwrap();
        assert_eq!(unique_path(dir, "foto.jpg"), dir.join("foto (1).jpg"));
        fs::write(dir.join("foto (1).jpg"), b"2").unwrap();
        assert_eq!(unique_path(dir, "foto.jpg"), dir.join("foto (2).jpg"));
        fs::write(dir.join("notas"), b"3").unwrap();
        assert_eq!(unique_path(dir, "notas"), dir.join("notas (1)"));
    }

    #[test]
    fn receptor_ok_renombra_y_no_deja_part() {
        let d = tempfile::tempdir().unwrap();
        let datos = b"contenido del archivo";
        let mut r = FileReceiver::create(d.path(), "doc.txt").unwrap();
        // mientras recibe, solo existe el .part
        assert_eq!(nombres_en(d.path()), vec!["doc.txt.part"]);
        r.write(&datos[..5]).unwrap();
        r.write(&datos[5..]).unwrap();
        assert_eq!(r.received(), datos.len() as u64);
        let ruta = r.finish(&sha(datos)).unwrap();
        assert_eq!(ruta, d.path().join("doc.txt"));
        assert_eq!(fs::read(&ruta).unwrap(), datos);
        assert_eq!(nombres_en(d.path()), vec!["doc.txt"]);
    }

    #[test]
    fn receptor_acepta_hash_en_mayusculas_y_archivo_vacio() {
        let d = tempfile::tempdir().unwrap();
        let r = FileReceiver::create(d.path(), "vacio.bin").unwrap();
        let ruta = r.finish(&sha(b"").to_uppercase()).unwrap();
        assert_eq!(fs::read(ruta).unwrap(), b"");
    }

    #[test]
    fn receptor_no_sobrescribe_existente() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a.txt"), b"viejo").unwrap();
        let mut r = FileReceiver::create(d.path(), "a.txt").unwrap();
        r.write(b"nuevo").unwrap();
        let ruta = r.finish(&sha(b"nuevo")).unwrap();
        assert_eq!(ruta, d.path().join("a (1).txt"));
        assert_eq!(fs::read(d.path().join("a.txt")).unwrap(), b"viejo");
        assert_eq!(fs::read(ruta).unwrap(), b"nuevo");
    }

    #[test]
    fn dos_receptores_con_el_mismo_nombre_no_se_pisan() {
        let d = tempfile::tempdir().unwrap();
        let mut a = FileReceiver::create(d.path(), "x.txt").unwrap();
        let mut b = FileReceiver::create(d.path(), "x.txt").unwrap();
        a.write(b"A").unwrap();
        b.write(b"B").unwrap();
        let pa = a.finish(&sha(b"A")).unwrap();
        let pb = b.finish(&sha(b"B")).unwrap();
        assert_ne!(pa, pb);
        assert_eq!(fs::read(pa).unwrap(), b"A");
        assert_eq!(fs::read(pb).unwrap(), b"B");
    }

    #[test]
    fn receptor_hash_malo_borra_todo() {
        let d = tempfile::tempdir().unwrap();
        let mut r = FileReceiver::create(d.path(), "doc.txt").unwrap();
        r.write(b"abc").unwrap();
        let err = r.finish(&sha(b"otra cosa")).unwrap_err();
        assert_eq!(err, "checksum_mismatch");
        assert!(nombres_en(d.path()).is_empty());
    }

    #[test]
    fn receptor_abort_borra_part() {
        let d = tempfile::tempdir().unwrap();
        let mut r = FileReceiver::create(d.path(), "doc.txt").unwrap();
        r.write(b"abc").unwrap();
        r.abort();
        assert!(nombres_en(d.path()).is_empty());
    }

    #[test]
    fn drop_sin_finish_borra_part() {
        let d = tempfile::tempdir().unwrap();
        {
            let mut r = FileReceiver::create(d.path(), "doc.txt").unwrap();
            r.write(b"abc").unwrap();
        }
        assert!(nombres_en(d.path()).is_empty());
    }

    #[test]
    fn tras_finish_queda_solo_el_archivo_final_con_su_contenido() {
        let d = tempfile::tempdir().unwrap();
        let mut r = FileReceiver::create(d.path(), "doc.txt").unwrap();
        r.write(b"abc").unwrap();
        let ruta = r.finish(&sha(b"abc")).unwrap();
        // finish consume el receptor y su Drop ya se ejecutó: no debe haber tocado nada
        assert_eq!(nombres_en(d.path()), vec!["doc.txt"]);
        assert_eq!(fs::read(ruta).unwrap(), b"abc");
    }

    #[test]
    fn destino_creado_justo_antes_de_finish_no_se_sobrescribe() {
        let d = tempfile::tempdir().unwrap();
        let mut r = FileReceiver::create(d.path(), "a.txt").unwrap();
        r.write(b"nuevo").unwrap();
        // otro escritor crea el destino (y el siguiente candidato) después de create
        fs::write(d.path().join("a.txt"), b"otro").unwrap();
        fs::write(d.path().join("a (1).txt"), b"otro1").unwrap();
        let ruta = r.finish(&sha(b"nuevo")).unwrap();
        assert_eq!(ruta, d.path().join("a (2).txt"));
        assert_eq!(fs::read(d.path().join("a.txt")).unwrap(), b"otro");
        assert_eq!(fs::read(d.path().join("a (1).txt")).unwrap(), b"otro1");
        assert_eq!(fs::read(ruta).unwrap(), b"nuevo");
        assert_eq!(nombres_en(d.path()), vec!["a (1).txt", "a (2).txt", "a.txt"]);
    }

    #[test]
    fn sin_nombres_libres_devuelve_error_y_no_deja_restos() {
        let d = tempfile::tempdir().unwrap();
        let mut r = FileReceiver::create(d.path(), "a.txt").unwrap();
        r.write(b"x").unwrap();
        fs::write(d.path().join("a.txt"), b"0").unwrap();
        for n in 1..MAX_INTENTOS_NOMBRE {
            fs::write(d.path().join(format!("a ({n}).txt")), b"0").unwrap();
        }
        let err = r.finish(&sha(b"x")).unwrap_err();
        assert!(err.starts_with("io_error"), "{err}");
        // solo los 10 000 existentes: ni .part ni marcador
        let nombres = nombres_en(d.path());
        assert_eq!(nombres.len(), MAX_INTENTOS_NOMBRE as usize);
        assert!(nombres.iter().all(|n| !n.ends_with(".part")));
        assert!(nombres.iter().all(|n| fs::read(d.path().join(n)).unwrap() == b"0"));
    }

    #[cfg(unix)]
    #[test]
    fn fallo_al_renombrar_no_deja_part_ni_marcador() {
        let d = tempfile::tempdir().unwrap();
        let mut r = FileReceiver::create(d.path(), "doc.txt").unwrap();
        r.write(b"abc").unwrap();
        // el .part desaparece por fuera: el rename fallará con el marcador ya reservado
        fs::remove_file(d.path().join("doc.txt.part")).unwrap();
        let err = r.finish(&sha(b"abc")).unwrap_err();
        assert!(err.starts_with("io_error"), "{err}");
        assert!(nombres_en(d.path()).is_empty());
    }

    #[test]
    fn nombre_reservado_no_reaparece_tras_truncar() {
        let entrada = format!("CON{}x.txt", " ".repeat(300));
        assert_eq!(sanitize_file_name(&entrada), "_CON.txt");
        assert_eq!(sanitize_file_name("CON. . .txt"), "_CON. . .txt");
        let largo = format!("{}{}", "COM1", " ".repeat(300));
        assert_eq!(sanitize_file_name(&largo), "_COM1");
    }

    #[test]
    fn sanea_es_idempotente() {
        let largo = "x".repeat(300);
        let muchos_espacios = format!("CON{}x.txt", " ".repeat(300));
        let ext_larga = format!("a.{}", "z".repeat(400));
        let acentos = format!("{}.txt", "ñ".repeat(150));
        let espacios_pdf = format!("{}.pdf", " ".repeat(300));
        let entradas = [
            "../../x", "a/b.txt", "C:\\x", "/etc/passwd", "CON", "con.txt", "", "..", ".", "a/",
            "nombre. . ", "a?b*.txt", "COM1", "\u{202E}gpj.exe", "..pdf", ". .pdf", ".bashrc",
            largo.as_str(), muchos_espacios.as_str(), ext_larga.as_str(), acentos.as_str(),
            espacios_pdf.as_str(),
        ];
        for e in entradas {
            let una = sanitize_file_name(e);
            assert_eq!(sanitize_file_name(&una), una, "entrada: {e:?}");
            assert!(una.len() <= MAX_NAME_BYTES && !una.is_empty());
        }
    }

    #[test]
    fn quita_caracteres_bidi_y_de_formato() {
        // sin esto, "invoice\u{202E}txt.exe" se mostraría como "invoiceexe.txt"
        assert_eq!(sanitize_file_name("invoice\u{202E}txt.exe"), "invoicetxt.exe");
        assert_eq!(sanitize_file_name("a\u{200B}b\u{200F}c\u{2066}d\u{2069}e\u{FEFF}f"), "abcdef");
        assert_eq!(sanitize_file_name("x\u{202A}\u{202B}\u{202C}\u{202D}.txt"), "x.txt");
        assert_eq!(sanitize_file_name("l\u{2028}m\u{2029}n"), "lmn");
    }

    #[test]
    fn stem_solo_de_puntos_o_espacios_pasa_a_archivo() {
        assert_eq!(sanitize_file_name(&format!("{}.pdf", " ".repeat(300))), "archivo.pdf");
        assert_eq!(sanitize_file_name("   .pdf"), "archivo.pdf");
        assert_eq!(sanitize_file_name("..pdf"), "archivo.pdf");
        assert_eq!(sanitize_file_name(".pdf"), ".pdf"); // fichero oculto, no es un stem vacío
        // el espacio queda tras el corte por longitud
        let n = sanitize_file_name(&format!("{}x.pdf", " ".repeat(300)));
        assert_eq!(n, "archivo.pdf");
    }

    #[test]
    fn ruta_final_siempre_dentro_del_directorio() {
        let d = tempfile::tempdir().unwrap();
        let largo = "x".repeat(300);
        let hostiles = [
            "../../x",
            "a/b.txt",
            "C:\\x",
            "..\\..\\y.txt",
            "/etc/passwd",
            "CON",
            "",
            "..",
            ".",
            "a/",
            largo.as_str(),
        ];
        for nombre in hostiles {
            let mut r = FileReceiver::create(d.path(), nombre).unwrap();
            r.write(b"datos").unwrap();
            let ruta = r.finish(&sha(b"datos")).unwrap();
            assert_eq!(ruta.parent().unwrap(), d.path(), "nombre: {nombre:?}");
            assert!(ruta.is_file());
        }
        // un archivo por nombre hostil, todos directamente en el directorio y sin restos
        let nombres = nombres_en(d.path());
        assert_eq!(nombres.len(), hostiles.len());
        assert!(nombres.iter().all(|n| !n.ends_with(".part")));
        assert!(nombres.iter().all(|n| d.path().join(n).is_file()));
    }
}
