//! Protocolo ClipSync v2. Espejo en Rust de `packages/protocol/src`: mismas constantes,
//! mismo formato de trama y misma validación que la implementación de referencia en TS.

mod messages;
pub mod hello;
pub mod secure;

pub use messages::{encode_control, encode_file_data, ControlMessage, Decoded, MessageDecoder, ProtocolError};

use tokio_util::codec::LengthDelimitedCodec;

pub const PROTOCOL_VERSION: u32 = 2;

pub const DEFAULT_TCP_PORT: u16 = 52847;

/// Forma completa del servicio mDNS, tal como la espera mdns-sd (ServiceInfo::new).
pub const MDNS_FULL_SERVICE_TYPE: &str = "_clipsync._tcp.local.";

/// Máximo de bytes de datos por trama (u16).
pub const MAX_FRAME_BYTES: usize = 65535;
/// Etiqueta de autenticación Poly1305 que Noise añade a cada mensaje cifrado.
pub const NOISE_TAG_BYTES: usize = 16;
/// Máximo de texto en claro por trama una vez cifrada: MAX_FRAME_BYTES - NOISE_TAG_BYTES.
pub const MAX_PAYLOAD_BYTES: usize = 65_519;
/// Bytes de archivo por trama de datos (48 KiB).
pub const FILE_CHUNK_BYTES: usize = 49152;
/// Se confirma (file_ack) cada vez que se reciben 1 MiB.
pub const FILE_ACK_EVERY_BYTES: u64 = 1_048_576;
/// Máximo de bytes sin confirmar en vuelo (2 MiB).
pub const FILE_WINDOW_BYTES: u64 = 2_097_152;
/// Máximo de texto de portapapeles, en bytes UTF-8 (1 MiB).
pub const MAX_CLIP_BYTES: usize = 1_048_576;
/// Máximo de un mensaje de control reensamblado (2 MiB).
pub const MAX_CONTROL_BYTES: usize = 2_097_152;

pub const HEARTBEAT_INTERVAL_MS: u64 = 10_000;
pub const HEARTBEAT_TIMEOUT_MS: u64 = 30_000;
// Solo los usa el móvil; se mantienen como espejo de las constantes de TS.
#[allow(dead_code)]
pub const RECONNECT_INTERVAL_MS: u64 = 5_000;
#[allow(dead_code)]
pub const CONNECT_TIMEOUT_MS: u64 = 2_000;

/// Elementos del historial de portapapeles.
pub const MAX_HISTORY: usize = 50;

/// Códec de tramas: longitud u16 big-endian + datos (máximo 65 535 bytes).
pub fn frame_codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder()
        .big_endian()
        .length_field_length(2)
        .max_frame_length(MAX_FRAME_BYTES)
        .new_codec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::{Bytes, BytesMut};
    use tokio_util::codec::{Decoder, Encoder};

    #[test]
    fn constantes_coinciden_con_ts() {
        assert_eq!(PROTOCOL_VERSION, 2);
        assert_eq!(DEFAULT_TCP_PORT, 52847);
        assert_eq!(MDNS_FULL_SERVICE_TYPE, "_clipsync._tcp.local.");
        assert_eq!(MAX_FRAME_BYTES, 65535);
        assert_eq!(NOISE_TAG_BYTES, 16);
        assert_eq!(MAX_PAYLOAD_BYTES, MAX_FRAME_BYTES - NOISE_TAG_BYTES);
        assert_eq!(FILE_CHUNK_BYTES, 48 * 1024);
        assert_eq!(MAX_CLIP_BYTES, 1024 * 1024);
        assert_eq!(MAX_CONTROL_BYTES, 2 * 1024 * 1024);
        assert_eq!(FILE_ACK_EVERY_BYTES, 1024 * 1024);
        assert_eq!(FILE_WINDOW_BYTES, 2 * 1024 * 1024);
    }

    #[test]
    fn codec_antepone_u16_big_endian() {
        let mut codec = frame_codec();
        let mut buf = BytesMut::new();
        codec.encode(Bytes::from_static(&[0x01, 0xaa, 0xbb]), &mut buf).unwrap();
        assert_eq!(&buf[..], &[0x00, 0x03, 0x01, 0xaa, 0xbb]);
    }

    #[test]
    fn codec_acepta_65535_bytes_y_rechaza_65536() {
        let mut codec = frame_codec();
        let mut buf = BytesMut::new();
        codec.encode(Bytes::from(vec![7u8; MAX_FRAME_BYTES]), &mut buf).unwrap();
        assert_eq!(&buf[..2], &[0xff, 0xff]);
        assert!(codec.encode(Bytes::from(vec![7u8; MAX_FRAME_BYTES + 1]), &mut BytesMut::new()).is_err());
    }

    #[test]
    fn codec_reensambla_un_flujo_troceado() {
        let mut codec = frame_codec();
        let mut buf = BytesMut::new();
        buf.extend_from_slice(&[0x00, 0x02, 0x01]);
        assert!(codec.decode(&mut buf).unwrap().is_none());
        buf.extend_from_slice(&[0x09, 0x00, 0x01, 0x02]);
        assert_eq!(&codec.decode(&mut buf).unwrap().unwrap()[..], &[0x01, 0x09]);
        assert_eq!(&codec.decode(&mut buf).unwrap().unwrap()[..], &[0x02]);
        assert!(codec.decode(&mut buf).unwrap().is_none());
    }
}
