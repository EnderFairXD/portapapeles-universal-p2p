import { BleManager, type Device } from 'react-native-ble-plx';

import { BLE_SERVICE_UUID } from '@clipsync/protocol';

/**
 * Fase 4 (Bluetooth) — scaffold, sin envío/recepción real todavía. Ver
 * docs/architecture.md §5: BLE para texto/handshake, Classic (solo Android) para
 * archivos.
 *
 * Nota de arquitectura pendiente de resolver antes de implementar de verdad: esta
 * librería (react-native-ble-plx) y btleplug (apps/desktop/src-tauri/src/bluetooth.rs)
 * son ambas de rol **central** — escanean y se conectan a periféricos, ninguna anuncia
 * un servicio GATT propio como periférico. Para que un extremo encuentre al otro por
 * BLE, alguien tiene que anunciarse; lo más probable es que sea el móvil, pero con OTRA
 * librería (esta no soporta advertising). Hay que decidirlo antes de que
 * startBleDiscovery de abajo tenga algo real que encontrar.
 */

const manager = new BleManager();

export type LogLevel = 'info' | 'error';
export type LogFn = (message: string, level?: LogLevel) => void;

export interface BleDiscoveredPeer {
  id: string;
  name: string | null;
}

/**
 * Escanea periféricos que anuncien BLE_SERVICE_UUID. Devuelve una función de limpieza
 * que detiene el escaneo (mismo patrón que startLanDiscovery en lanTransport.ts).
 */
export function startBleDiscovery(onPeerFound: (peer: BleDiscoveredPeer) => void, log: LogFn): () => void {
  log(`Escaneo BLE iniciado (servicio ${BLE_SERVICE_UUID})`);

  manager.startDeviceScan([BLE_SERVICE_UUID], null, (error, device: Device | null) => {
    if (error) {
      log(`Error de escaneo BLE: ${error.message}`, 'error');
      return;
    }
    if (!device) return;
    onPeerFound({ id: device.id, name: device.name });
  });

  return () => {
    manager.stopDeviceScan();
    log('Escaneo BLE detenido');
  };
}

// TODO(Fase 4): connectAndSendText(peer, content, log) — conectar al Device, descubrir
// sus características GATT, y enviar/recibir un SyncMessage por una característica
// propia (definir su UUID junto a BLE_SERVICE_UUID en packages/protocol). Depende de
// resolver antes el rol central/periférico de la nota de arriba.
