//! Anti-rebote de imágenes de un par. Espejo de `packages/protocol/src/imageSync.ts`.
//!
//! Mismo esquema en dos fases que `ClipboardSync`, pero sobre hashes ya calculados (cada lado
//! hashea lo que le devuelve su portapapeles):
//! - `hash`: última imagen enviada o recibida; una imagen con ese hash no se envía.
//! - `confirmed`: última imagen que consta que el otro lado tiene. Una imagen recibida se
//!   confirma al momento; una enviada queda tentativa hasta `confirm_sent()`.
//!
//! En lugar del callback de TS, `confirm_sent` y `mark_synced` devuelven el nuevo hash
//! confirmado solo si ha cambiado (para que el llamador lo persista).

pub struct ImageSync {
    hash: Option<String>,
    confirmed: Option<String>,
    /// enviada y aún sin confirmar
    tentative: Option<String>,
}

impl ImageSync {
    pub fn new(last_confirmed: Option<String>) -> Self {
        Self { hash: last_confirmed.clone(), confirmed: last_confirmed, tentative: None }
    }

    pub fn last_synced_hash(&self) -> Option<&str> {
        self.hash.as_deref()
    }

    // el PC no persiste el confirmado: solo lo miran los tests
    #[cfg(test)]
    pub fn last_confirmed_hash(&self) -> Option<&str> {
        self.confirmed.as_deref()
    }

    pub fn is_duplicate(&self, hash: &str) -> bool {
        self.hash.as_deref() == Some(hash)
    }

    /// Imagen enviada: evita el rebote, pero no se confirma hasta `confirm_sent()`.
    pub fn mark_sent(&mut self, hash: &str) {
        self.hash = Some(hash.to_owned());
        self.tentative = Some(hash.to_owned());
    }

    /// El otro lado procesó lo último enviado. Si después se recibió otra imagen, no hace nada.
    /// Devuelve el hash confirmado si ha cambiado.
    pub fn confirm_sent(&mut self) -> Option<String> {
        let h = self.tentative.take()?;
        self.set_confirmed(h)
    }

    /// El envío falló: se vuelve al último confirmado. Si después se recibió otra imagen, no hace nada.
    pub fn revert_sent(&mut self) {
        if self.tentative.take().is_some() {
            self.hash = self.confirmed.clone();
        }
    }

    /// Imagen recibida y escrita (hash de la lectura de vuelta): queda confirmada al momento.
    /// Devuelve el hash confirmado si ha cambiado.
    pub fn mark_synced(&mut self, hash: &str) -> Option<String> {
        self.hash = Some(hash.to_owned());
        self.tentative = None;
        self.set_confirmed(hash.to_owned())
    }

    fn set_confirmed(&mut self, h: String) -> Option<String> {
        if self.confirmed.as_deref() == Some(h.as_str()) {
            return None;
        }
        self.confirmed = Some(h.clone());
        Some(h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "a";
    const B: &str = "b";
    const C: &str = "c";

    #[test]
    fn al_inicio_no_hay_hashes() {
        let s = ImageSync::new(None);
        assert_eq!(s.last_synced_hash(), None);
        assert_eq!(s.last_confirmed_hash(), None);
        assert!(!s.is_duplicate(A));
    }

    #[test]
    fn acepta_un_hash_confirmado_inicial() {
        let s = ImageSync::new(Some(A.into()));
        assert!(s.is_duplicate(A));
        assert_eq!(s.last_confirmed_hash(), Some(A));
        assert_eq!(s.last_synced_hash(), Some(A));
    }

    #[test]
    fn mark_sent_evita_el_rebote_pero_no_confirma() {
        let mut s = ImageSync::new(None);
        s.mark_sent(A);
        assert!(s.is_duplicate(A));
        assert!(!s.is_duplicate(B));
        assert_eq!(s.last_synced_hash(), Some(A));
        assert_eq!(s.last_confirmed_hash(), None);
    }

    #[test]
    fn confirm_sent_confirma_lo_enviado_y_avisa_una_sola_vez() {
        let mut s = ImageSync::new(None);
        s.mark_sent(A);
        assert_eq!(s.confirm_sent(), Some(A.to_string()));
        assert_eq!(s.confirm_sent(), None);
        assert_eq!(s.last_confirmed_hash(), Some(A));
    }

    #[test]
    fn revert_sent_vuelve_al_ultimo_confirmado() {
        let mut s = ImageSync::new(Some(A.into()));
        s.mark_sent(B);
        assert_eq!(s.last_synced_hash(), Some(B));
        s.revert_sent();
        assert_eq!(s.last_synced_hash(), Some(A));
        assert_eq!(s.last_confirmed_hash(), Some(A));
        assert!(!s.is_duplicate(B));
        assert_eq!(s.confirm_sent(), None); // ya no hay nada tentativo
        assert_eq!(s.last_confirmed_hash(), Some(A));
    }

    #[test]
    fn revert_sent_sin_confirmado_previo_vuelve_a_none() {
        let mut s = ImageSync::new(None);
        s.mark_sent(A);
        s.revert_sent();
        assert_eq!(s.last_synced_hash(), None);
    }

    #[test]
    fn mark_synced_confirma_al_momento_y_avisa() {
        let mut s = ImageSync::new(None);
        assert_eq!(s.mark_synced(A), Some(A.to_string()));
        assert!(s.is_duplicate(A));
        assert_eq!(s.last_confirmed_hash(), Some(A));
    }

    #[test]
    fn mark_synced_con_el_mismo_hash_ya_confirmado_no_avisa_de_nuevo() {
        let mut s = ImageSync::new(Some(A.into()));
        assert_eq!(s.mark_synced(A), None);
    }

    #[test]
    fn confirm_sent_tras_un_mark_synced_posterior_no_hace_nada() {
        let mut s = ImageSync::new(None);
        s.mark_sent(A);
        assert_eq!(s.mark_synced(B), Some(B.to_string()));
        assert_eq!(s.confirm_sent(), None);
        assert_eq!(s.last_confirmed_hash(), Some(B));
        assert_eq!(s.last_synced_hash(), Some(B));
    }

    #[test]
    fn revert_sent_tras_un_mark_synced_posterior_no_deshace_lo_recibido() {
        let mut s = ImageSync::new(None);
        s.mark_sent(A);
        s.mark_synced(B);
        s.revert_sent();
        assert_eq!(s.last_synced_hash(), Some(B));
    }

    #[test]
    fn un_mark_sent_nuevo_sustituye_al_tentativo_anterior() {
        let mut s = ImageSync::new(Some(A.into()));
        s.mark_sent(B);
        s.mark_sent(C);
        assert_eq!(s.confirm_sent(), Some(C.to_string()));
        assert_eq!(s.last_confirmed_hash(), Some(C));
    }
}
