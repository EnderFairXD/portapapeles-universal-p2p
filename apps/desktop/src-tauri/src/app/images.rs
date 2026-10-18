//! Lógica pura de las imágenes del portapapeles del PC: huella, hash, PNG, decodificación con
//! límites y miniaturas. Sin Tauri ni arboard.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use base64::Engine;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageBuffer, ImageEncoder, ImageError, ImageReader, Limits, Rgba};
use sha2::{Digest, Sha256};

/// Límites de decodificación (bomba de descompresión).
pub const MAX_DECODE_SIDE: u32 = 16_384;
pub const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
/// Lado máximo de las miniaturas del historial.
pub const THUMBNAIL_SIDE: u32 = 160;
/// Para la huella se muestrea una fila de cada tantas.
const FINGERPRINT_ROW_STEP: usize = 64;

fn dim(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

/// Bytes RGBA que deben ocupar `w × h` píxeles; `None` si no caben en `usize`.
fn rgba_len(w: usize, h: usize) -> Option<usize> {
    w.checked_mul(h)?.checked_mul(4)
}

fn check_len(w: usize, h: usize, rgba: &[u8]) -> Result<(), String> {
    match rgba_len(w, h) {
        Some(n) if n == rgba.len() && w > 0 && h > 0 => Ok(()),
        _ => Err(format!("búfer de {} bytes para {w} × {h}", rgba.len())),
    }
}

/// Huella barata: ancho, alto y SHA-256 de una fila de cada 64.
pub fn fingerprint(w: usize, h: usize, rgba: &[u8]) -> [u8; 32] {
    let mut d = Sha256::new();
    d.update(dim(w).to_be_bytes());
    d.update(dim(h).to_be_bytes());
    let row = w.saturating_mul(4);
    if row > 0 {
        for y in (0..h).step_by(FINGERPRINT_ROW_STEP) {
            let start = y.saturating_mul(row);
            match rgba.get(start..start.saturating_add(row)) {
                Some(r) => d.update(r),
                None => break,
            }
        }
    }
    d.finalize().into()
}

/// SHA-256 de `ancho (u32 BE) ‖ alto (u32 BE) ‖ RGBA` en hex minúscula.
pub fn pixel_hash(w: usize, h: usize, rgba: &[u8]) -> String {
    let mut d = Sha256::new();
    d.update(dim(w).to_be_bytes());
    d.update(dim(h).to_be_bytes());
    d.update(rgba);
    hex::encode(d.finalize())
}

pub fn encode_png(w: usize, h: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    check_len(w, h, rgba)?;
    let mut out = Vec::new();
    // nivel 1: una captura 4K ocupa ~3 veces menos que con `Fast` y tarda lo mismo (~40 ms)
    PngEncoder::new_with_quality(&mut out, CompressionType::Level(1), FilterType::Adaptive)
        .write_image(rgba, dim(w), dim(h), ExtendedColorType::Rgba8)
        .map_err(|e| format!("no se pudo codificar el PNG: {e}"))?;
    Ok(out)
}

/// Decodifica PNG, JPEG o WebP a RGBA con los límites de lado y memoria; la cabecera se
/// comprueba antes de reservar el búfer.
pub fn decode_limited(path: &Path) -> Result<(usize, usize, Vec<u8>), String> {
    let mut reader = ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| format!("no se pudo abrir la imagen: {e}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| match e {
        ImageError::Limits(e) => format!("imagen fuera de los límites: {e}"),
        e => format!("no se pudo decodificar la imagen: {e}"),
    })?;
    let rgba = img.into_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    Ok((w, h, rgba.into_raw()))
}

/// Dimensiones de la miniatura: lado mayor de 160 px como mucho, sin agrandar.
fn thumbnail_size(w: u32, h: u32) -> (u32, u32) {
    let max = w.max(h);
    if max <= THUMBNAIL_SIDE {
        return (w, h);
    }
    let scale = |v: u32| {
        let v = (u64::from(v) * u64::from(THUMBNAIL_SIDE) + u64::from(max) / 2) / u64::from(max);
        (v as u32).max(1)
    };
    (scale(w), scale(h))
}

/// Miniatura PNG en data URL (`data:image/png;base64,…`).
pub fn thumbnail_data_url(w: usize, h: usize, rgba: &[u8]) -> Result<String, String> {
    check_len(w, h, rgba)?;
    let (w, h) = (dim(w), dim(h));
    let src = ImageBuffer::<Rgba<u8>, &[u8]>::from_raw(w, h, rgba)
        .ok_or_else(|| "búfer de la miniatura no válido".to_string())?;
    let (tw, th) = thumbnail_size(w, h);
    let thumb = image::imageops::thumbnail(&src, tw, th);
    let png = encode_png(tw as usize, th as usize, thumb.as_raw())?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// Borra los archivos; devuelve los que no se pudieron borrar (en Windows, p. ej., uno que aún
/// se está enviando) para reintentarlo en la siguiente poda. Uno que ya no existe cuenta como
/// borrado.
pub fn remove_files(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter(|p| match std::fs::remove_file(p) {
            Ok(()) => false,
            Err(e) if e.kind() == ErrorKind::NotFound => false,
            Err(e) => {
                super::log(&format!("no se pudo borrar {}: {e}", p.display()));
                true
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Imagen de prueba con un patrón que depende de la posición.
    fn imagen(w: usize, h: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&[(x % 251) as u8, (y % 241) as u8, ((x + y) % 7) as u8, 255]);
            }
        }
        v
    }

    fn fila(rgba: &mut [u8], w: usize, y: usize) -> &mut [u8] {
        &mut rgba[y * w * 4..(y + 1) * w * 4]
    }

    #[test]
    fn la_huella_cambia_si_cambia_una_fila_muestreada() {
        let (w, h) = (100, 200);
        let base = imagen(w, h);
        let f0 = fingerprint(w, h, &base);
        for y in [0, 64, 128, 192] {
            let mut otra = base.clone();
            fila(&mut otra, w, y)[5] ^= 0xff;
            assert_ne!(fingerprint(w, h, &otra), f0, "fila {y}");
        }
    }

    #[test]
    fn la_huella_no_recorre_las_filas_no_muestreadas() {
        let (w, h) = (100, 200);
        let base = imagen(w, h);
        let mut otra = base.clone();
        for y in (0..h).filter(|y| y % 64 != 0) {
            fila(&mut otra, w, y).fill(7);
        }
        assert_eq!(fingerprint(w, h, &otra), fingerprint(w, h, &base));
    }

    #[test]
    fn la_huella_depende_de_las_dimensiones() {
        let rgba = imagen(64, 64);
        assert_ne!(fingerprint(64, 64, &rgba), fingerprint(32, 128, &rgba));
    }

    #[test]
    fn la_huella_no_falla_con_un_bufer_corto() {
        // dimensiones que no casan con el búfer: no puede entrar en pánico
        let _ = fingerprint(100, 100, &[1, 2, 3]);
        let _ = pixel_hash(100, 100, &[1, 2, 3]);
    }

    #[test]
    fn pixel_hash_es_sha256_de_ancho_alto_y_rgba_en_hex() {
        use sha2::{Digest, Sha256};
        let rgba = imagen(3, 2);
        let mut d = Sha256::new();
        d.update(3u32.to_be_bytes());
        d.update(2u32.to_be_bytes());
        d.update(&rgba);
        let esperado = hex::encode(d.finalize());
        assert_eq!(pixel_hash(3, 2, &rgba), esperado);
        // estable
        assert_eq!(pixel_hash(3, 2, &rgba), esperado);
        assert_eq!(esperado.len(), 64);
        assert_eq!(esperado, esperado.to_lowercase());
        // cualquier píxel cuenta
        let mut otra = rgba.clone();
        otra[13] ^= 1;
        assert_ne!(pixel_hash(3, 2, &otra), esperado);
    }

    #[test]
    fn png_de_ida_y_vuelta_conserva_los_pixeles() {
        let (w, h) = (37, 19);
        let rgba = imagen(w, h);
        let png = encode_png(w, h, &rgba).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(&path, &png).unwrap();
        let (w2, h2, rgba2) = decode_limited(&path).unwrap();
        assert_eq!((w2, h2), (w, h));
        assert_eq!(rgba2, rgba);
    }

    #[test]
    fn encode_png_rechaza_un_bufer_que_no_casa() {
        assert!(encode_png(10, 10, &[0; 12]).is_err());
    }

    #[test]
    fn decode_limited_rechaza_lo_que_no_es_imagen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.png");
        std::fs::write(&path, b"hola, no soy un png").unwrap();
        assert!(decode_limited(&path).is_err());
        assert!(decode_limited(&dir.path().join("no-existe.png")).is_err());
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    }

    /// PNG válido de cabecera que declara `w × h` RGBA con un IDAT minúsculo.
    fn png_que_declara(w: u32, h: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(&mut out, b"IHDR", &ihdr);
        // zlib vacío
        chunk(
            &mut out,
            b"IDAT",
            &[0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01],
        );
        chunk(&mut out, b"IEND", &[]);
        out
    }

    #[test]
    fn decode_limited_rechaza_una_bomba_de_100000_x_100000() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bomba.png");
        std::fs::write(&path, png_que_declara(100_000, 100_000)).unwrap();
        let t = std::time::Instant::now();
        let r = decode_limited(&path);
        assert!(r.unwrap_err().contains("límite"));
        // se rechaza por la cabecera, sin reservar ni decodificar 40 GB
        assert!(t.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn decode_limited_rechaza_mas_de_16384_de_lado() {
        let dir = tempfile::tempdir().unwrap();
        let ancho = dir.path().join("ancho.png");
        std::fs::write(&ancho, png_que_declara(16_385, 1)).unwrap();
        let err = decode_limited(&ancho).unwrap_err();
        assert!(err.contains("límite"), "{err}");
        let alto = dir.path().join("alto.png");
        std::fs::write(&alto, png_que_declara(1, 16_385)).unwrap();
        assert!(decode_limited(&alto).unwrap_err().contains("límite"));
    }

    #[test]
    fn decode_limited_rechaza_mas_de_512_mib_de_memoria() {
        // 16384 × 16384 RGBA = 1 GiB: dentro del límite de lado, fuera del de memoria
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grande.png");
        std::fs::write(&path, png_que_declara(16_384, 16_384)).unwrap();
        let err = decode_limited(&path).unwrap_err();
        assert!(err.contains("límite"), "{err}");
    }

    fn decodifica_data_url(url: &str) -> (u32, u32) {
        let b64 = url.strip_prefix("data:image/png;base64,").unwrap();
        let png = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        let img = image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn miniatura_de_160_px_como_maximo_y_con_su_proporcion() {
        let url = thumbnail_data_url(800, 400, &imagen(800, 400)).unwrap();
        assert_eq!(decodifica_data_url(&url), (160, 80));
        let url = thumbnail_data_url(300, 900, &imagen(300, 900)).unwrap();
        assert_eq!(decodifica_data_url(&url), (53, 160));
    }

    #[test]
    fn miniatura_de_una_imagen_pequena_no_se_agranda() {
        let url = thumbnail_data_url(20, 10, &imagen(20, 10)).unwrap();
        assert_eq!(decodifica_data_url(&url), (20, 10));
    }

    #[test]
    fn miniatura_de_una_linea_no_queda_en_cero() {
        let url = thumbnail_data_url(4000, 1, &imagen(4000, 1)).unwrap();
        assert_eq!(decodifica_data_url(&url), (160, 1));
    }

    #[test]
    fn miniatura_rechaza_un_bufer_que_no_casa() {
        assert!(thumbnail_data_url(10, 10, &[0; 4]).is_err());
    }

    #[test]
    fn remove_files_borra_y_da_por_borrado_lo_que_no_existe() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png");
        std::fs::write(&a, b"x").unwrap();
        let falta = dir.path().join("falta.png");
        let fallidos = remove_files(vec![a.clone(), falta]);
        assert!(fallidos.is_empty());
        assert!(!a.exists());
    }

    #[test]
    fn remove_files_devuelve_los_que_no_se_pudieron_borrar() {
        // una carpeta no se borra con remove_file: simula un archivo aún abierto en Windows
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("sub.png");
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(remove_files(vec![sub.clone()]), vec![sub]);
    }
}
