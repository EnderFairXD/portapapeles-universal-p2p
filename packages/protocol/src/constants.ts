export const PROTOCOL_VERSION = '1.0.0';

export const DEFAULT_TCP_PORT = 52847;

/** Forma "bare" del tipo de servicio, tal como la espera react-native-zeroconf (scan(type, protocol, domain)). */
export const MDNS_SERVICE_NAME = 'p2pclip';
export const MDNS_SERVICE_PROTOCOL = 'tcp';
export const MDNS_SERVICE_DOMAIN = 'local.';

/** Forma completamente cualificada, tal como la espera mdns-sd en el escritorio (ServiceInfo::new). */
export const MDNS_FULL_SERVICE_TYPE = `_${MDNS_SERVICE_NAME}._${MDNS_SERVICE_PROTOCOL}.${MDNS_SERVICE_DOMAIN}`;
