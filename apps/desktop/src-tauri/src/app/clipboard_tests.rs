//! Tests del vigilante con un portapapeles y un anfitrión de mentira.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::*;
use crate::app::images::{encode_png, pixel_hash};
use crate::app::{IMAGE_TOO_LARGE_NOTICE, IMAGE_WRITE_ERROR};

#[derive(Default)]
struct FakeClipboard {
    text: Option<String>,
    image: Option<(usize, usize, Vec<u8>)>,
    /// el portapapeles altera un píxel al guardar (como si recodificara)
    recode: bool,
    fail_set_image: bool,
    /// lecturas de imagen que fallan justo después de escribir una
    fail_readbacks: u32,
    fail_readbacks_after_set: u32,
    get_image_calls: usize,
}

impl Backend for FakeClipboard {
    fn get_text(&mut self) -> Result<String, arboard::Error> {
        self.text.clone().ok_or(arboard::Error::ContentNotAvailable)
    }
    fn set_text(&mut self, text: String) -> Result<(), arboard::Error> {
        self.text = Some(text);
        self.image = None;
        Ok(())
    }
    fn get_image(&mut self) -> Result<ImageData<'static>, arboard::Error> {
        self.get_image_calls += 1;
        if self.fail_readbacks > 0 {
            self.fail_readbacks -= 1;
            return Err(arboard::Error::Unknown {
                description: "lectura fallida".into(),
            });
        }
        match &self.image {
            Some((w, h, rgba)) => Ok(ImageData {
                width: *w,
                height: *h,
                bytes: rgba.clone().into(),
            }),
            None => Err(arboard::Error::ContentNotAvailable),
        }
    }
    fn set_image(&mut self, img: ImageData<'_>) -> Result<(), arboard::Error> {
        if self.fail_set_image {
            return Err(arboard::Error::ConversionFailure);
        }
        self.fail_readbacks = self.fail_readbacks_after_set;
        let mut bytes = img.bytes.into_owned();
        if self.recode {
            bytes[0] ^= 1;
        }
        self.image = Some((img.width, img.height, bytes));
        self.text = None;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Call {
    InitialText(String),
    LocalText(String),
    TextWritten(String),
    LocalImage(Option<LocalImage>),
    Sent(LocalImage, bool),
    Received {
        session_id: u64,
        hash: String,
        png: Option<PathBuf>,
        thumbnail: bool,
        location: String,
    },
    ReceiveFailed(String),
    Notice(&'static str),
    Retry(Vec<PathBuf>),
}

#[derive(Default)]
struct FakeHost {
    calls: Mutex<Vec<Call>>,
    trash: Mutex<Vec<PathBuf>>,
    in_use: Mutex<Vec<PathBuf>>,
}

impl FakeHost {
    fn calls(&self) -> Vec<Call> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
    fn push(&self, c: Call) {
        self.calls.lock().unwrap().push(c);
    }
}

impl Host for FakeHost {
    fn set_clipboard_error(&self, _error: Option<String>) {}
    fn set_initial_local(&self, text: &str) {
        self.push(Call::InitialText(text.into()));
    }
    fn on_local_text(&self, text: String) {
        self.push(Call::LocalText(text));
    }
    fn text_written(&self, text: String) {
        self.push(Call::TextWritten(text));
    }
    fn set_local_image(&self, img: Option<LocalImage>) {
        self.push(Call::LocalImage(img));
    }
    fn on_local_image(&self, img: LocalImage, thumbnail: Option<String>) {
        self.push(Call::Sent(img, thumbnail.is_some()));
    }
    fn on_image_received(
        &self,
        session_id: u64,
        hash: String,
        png: Option<(PathBuf, u64)>,
        thumbnail: Option<String>,
        location: String,
    ) {
        self.push(Call::Received {
            session_id,
            hash,
            png: png.map(|(p, _)| p),
            thumbnail: thumbnail.is_some(),
            location,
        });
    }
    fn on_image_receive_failed(&self, location: String) {
        self.push(Call::ReceiveFailed(location));
    }
    fn show_notice(&self, text: &'static str) {
        self.push(Call::Notice(text));
    }
    fn take_trash(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.trash.lock().unwrap())
    }
    fn image_in_use(&self, png: &Path) -> bool {
        self.in_use.lock().unwrap().iter().any(|p| p == png)
    }
    fn retry_later(&self, failed: Vec<PathBuf>) {
        self.push(Call::Retry(failed));
    }
}

fn imagen(w: usize, h: usize, semilla: u8) -> (usize, usize, Vec<u8>) {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&[x as u8 ^ semilla, y as u8, semilla, 255]);
        }
    }
    (w, h, v)
}

struct Banco {
    w: Watcher<FakeClipboard, FakeHost>,
    host: Arc<FakeHost>,
    _dir: tempfile::TempDir,
    images: PathBuf,
}

fn banco(cb: FakeClipboard) -> Banco {
    let dir = tempfile::tempdir().unwrap();
    let images = dir.path().join("images");
    let host = Arc::new(FakeHost::default());
    let w = Watcher::new(cb, host.clone(), images.clone());
    Banco {
        w,
        host,
        _dir: dir,
        images,
    }
}

fn png_de(b: &Banco, hash: &str) -> PathBuf {
    b.images.join(format!("{hash}.png"))
}

#[test]
fn al_arrancar_el_texto_pasa_a_ser_local_sin_enviarse() {
    let mut b = banco(FakeClipboard {
        text: Some("hola".into()),
        ..Default::default()
    });
    b.w.start();
    assert_eq!(b.host.calls(), vec![Call::InitialText("hola".into())]);
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn al_arrancar_la_imagen_pasa_a_ser_local_sin_enviarse_y_gana_al_texto() {
    let (w, h, rgba) = imagen(8, 4, 1);
    let hash = pixel_hash(w, h, &rgba);
    let mut b = banco(FakeClipboard {
        text: Some("https://ejemplo/imagen.png".into()),
        image: Some((w, h, rgba)),
        ..Default::default()
    });
    b.w.start();
    let png = png_de(&b, &hash);
    assert_eq!(
        b.host.calls(),
        vec![Call::LocalImage(Some(LocalImage {
            hash,
            png_path: png.clone()
        }))]
    );
    assert!(png.is_file());
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn al_arrancar_se_vacia_la_cache_de_imagenes() {
    let mut b = banco(FakeClipboard::default());
    std::fs::create_dir_all(&b.images).unwrap();
    let vieja = b.images.join("vieja.png");
    std::fs::write(&vieja, b"x").unwrap();
    b.w.start();
    assert!(!vieja.exists());
    assert!(b.images.is_dir());
}

#[test]
fn texto_nuevo_se_envia() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    b.w.cb.text = Some("uno".into());
    b.w.tick(true, false);
    assert_eq!(b.host.calls(), vec![Call::LocalText("uno".into())]);
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn imagen_nueva_se_guarda_en_png_por_hash_y_se_envia() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let (w, h, rgba) = imagen(30, 20, 2);
    let hash = pixel_hash(w, h, &rgba);
    b.w.cb.image = Some((w, h, rgba.clone()));
    b.w.tick(false, true);
    let png = png_de(&b, &hash);
    assert_eq!(
        b.host.calls(),
        vec![Call::Sent(
            LocalImage {
                hash: hash.clone(),
                png_path: png.clone()
            },
            true
        )]
    );
    // el PNG guardado es esa imagen
    let (w2, h2, rgba2) = crate::app::images::decode_limited(&png).unwrap();
    assert_eq!((w2, h2, rgba2), (w, h, rgba));
    // sin cambios no se repite
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn imagen_y_texto_en_la_misma_copia_solo_envia_la_imagen() {
    // el cambio lo ve primero el sondeo de texto (500 ms)
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let (w, h, rgba) = imagen(8, 8, 3);
    b.w.cb.text = Some("https://ejemplo/foto.png".into());
    b.w.cb.image = Some((w, h, rgba));
    b.w.tick(true, false);
    let calls = b.host.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(matches!(calls[0], Call::Sent(..)));
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn imagen_y_texto_vistos_primero_por_el_sondeo_de_imagen_tampoco_envian_el_texto() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let (w, h, rgba) = imagen(8, 8, 4);
    b.w.cb.text = Some("https://ejemplo/foto.png".into());
    b.w.cb.image = Some((w, h, rgba));
    b.w.tick(false, true);
    assert!(matches!(b.host.calls()[..], [Call::Sent(..)]));
    b.w.tick(true, false);
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn en_el_mismo_tick_la_imagen_se_lee_una_sola_vez() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let antes = b.w.cb.get_image_calls;
    let (w, h, rgba) = imagen(8, 8, 5);
    b.w.cb.text = Some("url".into());
    b.w.cb.image = Some((w, h, rgba));
    b.w.tick(true, true);
    assert_eq!(b.w.cb.get_image_calls - antes, 1);
    assert!(matches!(b.host.calls()[..], [Call::Sent(..)]));
}

#[test]
fn volver_a_copiar_el_texto_anterior_tras_una_imagen_se_envia() {
    let mut b = banco(FakeClipboard {
        text: Some("T".into()),
        ..Default::default()
    });
    b.w.start();
    b.host.calls();
    b.w.cb.text = None;
    b.w.cb.image = Some(imagen(4, 4, 6));
    b.w.tick(true, true);
    assert!(matches!(b.host.calls()[..], [Call::Sent(..)]));
    b.w.cb.image = None;
    b.w.cb.text = Some("T".into());
    b.w.tick(true, true);
    assert_eq!(
        b.host.calls(),
        vec![Call::LocalImage(None), Call::LocalText("T".into())]
    );
}

#[test]
fn la_misma_imagen_copiada_otra_vez_tras_un_texto_se_vuelve_a_ofrecer() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let img = imagen(4, 4, 7);
    b.w.cb.image = Some(img.clone());
    b.w.tick(false, true);
    assert!(matches!(b.host.calls()[..], [Call::Sent(..)]));
    b.w.cb.image = None;
    b.w.cb.text = Some("t".into());
    b.w.tick(true, true);
    b.host.calls();
    b.w.cb.text = None;
    b.w.cb.image = Some(img);
    b.w.tick(false, true);
    // el Hub decide con su ImageSync si ese móvil ya la tiene
    assert!(matches!(b.host.calls()[..], [Call::Sent(..)]));
}

#[test]
fn imagen_que_desaparece_deja_de_ser_la_local() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    b.w.cb.image = Some(imagen(4, 4, 8));
    b.w.tick(false, true);
    b.host.calls();
    b.w.cb.image = None;
    b.w.tick(false, true);
    assert_eq!(b.host.calls(), vec![Call::LocalImage(None)]);
    b.w.tick(false, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn imagen_de_mas_del_maximo_no_se_envia_y_avisa() {
    let mut b = banco(FakeClipboard::default());
    b.w.max_image_bytes = 10;
    b.w.start();
    let (w, h, rgba) = imagen(16, 16, 9);
    let hash = pixel_hash(w, h, &rgba);
    b.w.cb.image = Some((w, h, rgba));
    b.w.tick(false, true);
    assert_eq!(
        b.host.calls(),
        vec![Call::LocalImage(None), Call::Notice(IMAGE_TOO_LARGE_NOTICE)]
    );
    // su PNG no se queda en la caché
    assert!(!png_de(&b, &hash).exists());
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn texto_escrito_desde_un_movil_no_vuelve_a_salir() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    assert!(b.w.write_text("del móvil".into()).is_ok());
    assert_eq!(b.host.calls(), vec![Call::TextWritten("del móvil".into())]);
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

fn guarda_recibida(b: &Banco, nombre: &str, img: &(usize, usize, Vec<u8>)) -> String {
    let dir = b._dir.path().join("Imágenes/ClipSync");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(nombre);
    std::fs::write(&path, encode_png(img.0, img.1, &img.2).unwrap()).unwrap();
    path.to_string_lossy().into_owned()
}

#[test]
fn imagen_recibida_se_pone_y_se_marca_con_el_hash_leido_de_vuelta() {
    let mut b = banco(FakeClipboard {
        recode: true,
        ..Default::default()
    });
    b.w.start();
    let img = imagen(10, 6, 10);
    let location = guarda_recibida(&b, "foto.png", &img);
    b.w.write_received_image(3, location.clone());
    // lo que el portapapeles devuelve (recodificado), no lo que llegó
    let (w, h, puesta) = b.w.cb.image.clone().unwrap();
    assert_ne!(puesta, img.2);
    let leido = pixel_hash(w, h, &puesta);
    assert_ne!(leido, pixel_hash(img.0, img.1, &img.2));
    let png = png_de(&b, &leido);
    assert_eq!(
        b.host.calls(),
        vec![Call::Received {
            session_id: 3,
            hash: leido,
            png: Some(png.clone()),
            thumbnail: true,
            location,
        }]
    );
    // el PNG de reenvío es lo leído de vuelta
    assert_eq!(crate::app::images::decode_limited(&png).unwrap().2, puesta);
    // el vigilante no la toma por una copia nueva
    b.w.tick(true, true);
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn imagen_recibida_que_no_se_decodifica_avisa_y_queda_como_archivo() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let dir = b._dir.path().join("Imágenes/ClipSync");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rota.png");
    std::fs::write(&path, b"no soy un png").unwrap();
    let location = path.to_string_lossy().into_owned();
    b.w.write_received_image(1, location.clone());
    assert_eq!(
        b.host.calls(),
        vec![
            Call::Notice(IMAGE_WRITE_ERROR),
            Call::ReceiveFailed(location)
        ]
    );
    // el archivo se conserva
    assert!(path.exists());
}

#[test]
fn imagen_recibida_que_el_portapapeles_rechaza_avisa() {
    let mut b = banco(FakeClipboard {
        fail_set_image: true,
        ..Default::default()
    });
    b.w.start();
    let location = guarda_recibida(&b, "a.png", &imagen(4, 4, 11));
    b.w.write_received_image(1, location.clone());
    assert_eq!(
        b.host.calls(),
        vec![
            Call::Notice(IMAGE_WRITE_ERROR),
            Call::ReceiveFailed(location)
        ]
    );
}

#[test]
fn copy_image_la_pone_sin_enviarla_y_no_vuelve_a_salir() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let (w, h, rgba) = imagen(6, 6, 12);
    let hash = pixel_hash(w, h, &rgba);
    std::fs::create_dir_all(&b.images).unwrap();
    let png = png_de(&b, &hash);
    std::fs::write(&png, encode_png(w, h, &rgba).unwrap()).unwrap();
    assert!(b.w.copy_image(&png).is_ok());
    assert_eq!(b.w.cb.image.as_ref().unwrap().2, rgba);
    assert_eq!(
        b.host.calls(),
        vec![Call::LocalImage(Some(LocalImage {
            hash,
            png_path: png
        }))]
    );
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn copy_image_de_un_png_que_falta_devuelve_el_error() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let r = b.w.copy_image(&b.images.join("falta.png"));
    assert_eq!(r, Err(IMAGE_WRITE_ERROR.to_string()));
}

#[test]
fn la_poda_borra_los_png_sin_uso_y_conserva_los_que_siguen_en_uso() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    let libre = b.images.join("libre.png");
    let usado = b.images.join("usado.png");
    let falla = b.images.join("falla.png");
    std::fs::write(&libre, b"x").unwrap();
    std::fs::write(&usado, b"x").unwrap();
    // una carpeta no se puede borrar con remove_file: como un PNG abierto en Windows
    std::fs::create_dir(&falla).unwrap();
    *b.host.trash.lock().unwrap() = vec![libre.clone(), usado.clone(), falla.clone()];
    b.host.in_use.lock().unwrap().push(usado.clone());
    b.w.prune();
    assert!(!libre.exists());
    assert!(usado.exists());
    assert_eq!(b.host.calls(), vec![Call::Retry(vec![falla])]);
    // sin nada en la papelera no hace nada
    b.w.prune();
    assert!(b.host.calls().is_empty());
}

#[test]
fn si_falla_la_lectura_de_vuelta_se_reintenta_una_vez() {
    let mut b = banco(FakeClipboard {
        recode: true,
        fail_readbacks_after_set: 1,
        ..Default::default()
    });
    b.w.start();
    let location = guarda_recibida(&b, "a.png", &imagen(6, 6, 13));
    b.w.write_received_image(2, location);
    let (w, h, puesta) = b.w.cb.image.clone().unwrap();
    let leido = pixel_hash(w, h, &puesta);
    let calls = b.host.calls();
    assert!(
        matches!(&calls[..], [Call::Received { hash, .. }] if *hash == leido),
        "{calls:?}"
    );
    b.w.tick(true, true);
    assert!(b.host.calls().is_empty());
}

#[test]
fn si_la_lectura_de_vuelta_falla_dos_veces_no_se_marca_con_el_hash_decodificado() {
    let mut b = banco(FakeClipboard {
        recode: true,
        fail_readbacks_after_set: 2,
        ..Default::default()
    });
    b.w.start();
    let location = guarda_recibida(&b, "a.png", &imagen(6, 6, 14));
    b.w.write_received_image(2, location.clone());
    // sin `on_image_received` (no hay `mark_image_synced`); el archivo queda en el historial
    assert_eq!(b.host.calls(), vec![Call::ReceiveFailed(location)]);
    // el siguiente sondeo la trata como lo que hay en el portapapeles
    b.w.tick(false, true);
    let (w, h, puesta) = b.w.cb.image.clone().unwrap();
    let calls = b.host.calls();
    assert!(
        matches!(&calls[..], [Call::Sent(img, true)] if img.hash == pixel_hash(w, h, &puesta)),
        "{calls:?}"
    );
}

#[test]
fn si_no_se_puede_guardar_el_png_se_reintenta_en_el_siguiente_sondeo() {
    let mut b = banco(FakeClipboard::default());
    b.w.start();
    // la caché deja de ser escribible: en su sitio hay un archivo
    std::fs::remove_dir_all(&b.images).unwrap();
    std::fs::write(&b.images, b"no soy una carpeta").unwrap();
    b.w.cb.image = Some(imagen(5, 5, 15));
    b.w.tick(false, true);
    assert_eq!(b.host.calls(), vec![Call::LocalImage(None)]);
    std::fs::remove_file(&b.images).unwrap();
    std::fs::create_dir(&b.images).unwrap();
    b.w.tick(false, true);
    assert!(matches!(b.host.calls()[..], [Call::Sent(_, true)]));
}
