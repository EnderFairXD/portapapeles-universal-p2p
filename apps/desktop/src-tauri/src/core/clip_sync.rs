//! Anti-rebote del portapapeles. Espejo de `packages/protocol/src/clipSync.ts`.

use crate::protocol::MAX_CLIP_BYTES;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipDecision {
    Send,
    Duplicate,
    Empty,
    TooLarge,
}

pub struct ClipboardSync {
    hash: Option<String>,
}

/// Mismo criterio de espacio que `String.prototype.trim` de JS: el `White_Space` de Unicode
/// salvo U+0085 (NEL), más U+FEFF (BOM).
fn es_espacio_js(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

impl ClipboardSync {
    pub fn new(last: Option<String>) -> Self {
        Self { hash: last }
    }

    /// Orden de comprobaciones idéntico al de TS: vacío, demasiado grande, duplicado.
    pub fn check(&self, text: &str) -> ClipDecision {
        if text.chars().all(es_espacio_js) {
            return ClipDecision::Empty;
        }
        if text.len() > MAX_CLIP_BYTES {
            return ClipDecision::TooLarge;
        }
        if self.hash.as_deref() == Some(sha256_hex(text).as_str()) {
            ClipDecision::Duplicate
        } else {
            ClipDecision::Send
        }
    }

    /// Llamar tras enviar un texto o tras recibirlo y escribirlo en el portapapeles.
    pub fn mark_synced(&mut self, text: &str) {
        self.hash = Some(sha256_hex(text));
    }

    pub fn last_synced_hash(&self) -> Option<&str> {
        self.hash.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(s: &str) -> String {
        sha256_hex(s)
    }

    #[test]
    fn nuevo_es_send_y_tras_mark_synced_es_duplicate() {
        let mut s = ClipboardSync::new(None);
        assert_eq!(s.check("hola"), ClipDecision::Send);
        s.mark_synced("hola");
        assert_eq!(s.check("hola"), ClipDecision::Duplicate);
        assert_eq!(s.check("adiós"), ClipDecision::Send);
    }

    #[test]
    fn recibido_y_escrito_no_rebota() {
        let mut s = ClipboardSync::new(None);
        s.mark_synced("del móvil");
        assert_eq!(s.check("del móvil"), ClipDecision::Duplicate);
    }

    #[test]
    fn vacio_y_solo_espacios_es_empty() {
        assert_eq!(ClipboardSync::new(None).check(""), ClipDecision::Empty);
        assert_eq!(ClipboardSync::new(None).check("  \n"), ClipDecision::Empty);
    }

    #[test]
    fn espacios_como_trim_de_js() {
        // JS trim() cuenta U+FEFF, NBSP, U+2028/2029 y U+3000, pero no U+0085 ni U+200B.
        let c = ClipboardSync::new(None);
        assert_eq!(c.check("\u{FEFF}\u{A0}\u{2028}\u{2029}\u{3000}\t\r"), ClipDecision::Empty);
        assert_eq!(c.check("\u{85}"), ClipDecision::Send);
        assert_eq!(c.check("\u{200B}"), ClipDecision::Send);
    }

    #[test]
    fn limite_de_1_mib_exacto() {
        let c = ClipboardSync::new(None);
        assert_eq!(c.check(&"a".repeat(MAX_CLIP_BYTES)), ClipDecision::Send);
        assert_eq!(c.check(&"a".repeat(MAX_CLIP_BYTES + 1)), ClipDecision::TooLarge);
    }

    #[test]
    fn el_limite_se_mide_en_bytes_utf8() {
        let c = ClipboardSync::new(None);
        assert_eq!(c.check(&"😀".repeat(262_144)), ClipDecision::Send);
        assert_eq!(c.check(&format!("{}a", "😀".repeat(262_144))), ClipDecision::TooLarge);
    }

    #[test]
    fn acepta_hash_inicial() {
        assert_eq!(
            ClipboardSync::new(Some(sha("x"))).check("x"),
            ClipDecision::Duplicate
        );
    }

    #[test]
    fn last_synced_hash_es_none_al_inicio_y_luego_sha256_hex() {
        let mut s = ClipboardSync::new(None);
        assert_eq!(s.last_synced_hash(), None);
        s.mark_synced("hola");
        assert_eq!(s.last_synced_hash(), Some(sha("hola").as_str()));
        // SHA-256 minúscula de "hola", valor fijo
        assert_eq!(
            s.last_synced_hash(),
            Some("b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79")
        );
    }

    #[test]
    fn vacio_o_grande_no_se_confunde_con_el_ultimo_duplicado() {
        let mut s = ClipboardSync::new(None);
        s.mark_synced("hola");
        assert_eq!(s.check(" "), ClipDecision::Empty);
        assert_eq!(s.check(&"a".repeat(MAX_CLIP_BYTES + 1)), ClipDecision::TooLarge);
        assert_eq!(s.check("hola"), ClipDecision::Duplicate);
    }
}
