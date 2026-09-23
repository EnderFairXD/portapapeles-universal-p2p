export const PROTOCOL_VERSION = '1.0.0';

export const DEFAULT_TCP_PORT = 52847;

/**
 * Puerto del servidor HTTP del Modo Invitado (Fase 5, ver docs/architecture.md §6).
 * Distinto de DEFAULT_TCP_PORT para poder correr ambos servidores a la vez. El túnel USB
 * (apps/desktop/src-tauri/src/usb.rs) necesita este valor tal cual para re-exponer
 * también este puerto vía `adb reverse` — debe coincidir con GUEST_MODE_PORT en
 * protocol.rs.
 */
export const GUEST_MODE_PORT = 52848;

/** Forma "bare" del tipo de servicio, tal como la espera react-native-zeroconf (scan(type, protocol, domain)). */
export const MDNS_SERVICE_NAME = 'p2pclip';
export const MDNS_SERVICE_PROTOCOL = 'tcp';
export const MDNS_SERVICE_DOMAIN = 'local.';

/** Forma completamente cualificada, tal como la espera mdns-sd en el escritorio (ServiceInfo::new). */
export const MDNS_FULL_SERVICE_TYPE = `_${MDNS_SERVICE_NAME}._${MDNS_SERVICE_PROTOCOL}.${MDNS_SERVICE_DOMAIN}`;

/**
 * UUID v4 estático del servicio GATT BLE (Fase 4) — ambos lados escanean/anuncian este
 * mismo UUID para encontrarse. Debe coincidir con BLE_SERVICE_UUID en
 * apps/desktop/src-tauri/src/bluetooth.rs; cualquier cambio hay que replicarlo a mano
 * en los dos sitios (mismo criterio que el resto de constantes compartidas de este
 * paquete — ver README).
 */
export const BLE_SERVICE_UUID = '2c9a7e4a-4f1b-4d6e-9c3a-8b7f61d2e5a4';
