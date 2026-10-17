export const PROTOCOL_VERSION = 2;

export const DEFAULT_TCP_PORT = 52847;

/** Forma corta del servicio mDNS, tal como la espera react-native-zeroconf (scan(type, protocol, domain)). */
export const MDNS_SERVICE_NAME = 'clipsync';
export const MDNS_SERVICE_PROTOCOL = 'tcp';
export const MDNS_SERVICE_DOMAIN = 'local.';

/** Forma completa, tal como la espera mdns-sd en el escritorio (ServiceInfo::new). */
export const MDNS_FULL_SERVICE_TYPE = `_${MDNS_SERVICE_NAME}._${MDNS_SERVICE_PROTOCOL}.${MDNS_SERVICE_DOMAIN}`;

/** Máximo de bytes de datos por trama (u16). */
export const MAX_FRAME_BYTES = 65535;
/** Bytes de archivo por trama de datos (48 KiB). */
export const FILE_CHUNK_BYTES = 49152;
/** Se confirma (file_ack) cada vez que se reciben 1 MiB. */
export const FILE_ACK_EVERY_BYTES = 1048576;
/** Máximo de bytes sin confirmar en vuelo (2 MiB). */
export const FILE_WINDOW_BYTES = 2097152;
/** Máximo de texto de portapapeles, en bytes UTF-8 (1 MiB). */
export const MAX_CLIP_BYTES = 1048576;
/** Máximo de un mensaje de control reensamblado (2 MiB). */
export const MAX_CONTROL_BYTES = 2097152;

export const HEARTBEAT_INTERVAL_MS = 10000;
export const HEARTBEAT_TIMEOUT_MS = 30000;
export const RECONNECT_INTERVAL_MS = 5000;
export const CONNECT_TIMEOUT_MS = 2000;

/** Elementos del historial de portapapeles. */
export const MAX_HISTORY = 50;

/** Bytes de la etiqueta Poly1305 que ChaChaPoly añade a cada mensaje Noise. */
export const NOISE_TAG_BYTES = 16;
/** Máximo de texto en claro por trama cifrada (65 535 − etiqueta). */
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - NOISE_TAG_BYTES;
/** Validez del token del QR de emparejamiento (5 minutos). */
export const PAIRING_TTL_MS = 300000;
