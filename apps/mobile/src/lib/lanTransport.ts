import * as Crypto from 'expo-crypto';
import TcpSocket from 'react-native-tcp-socket';
import Zeroconf from 'react-native-zeroconf';

import {
  buildTextMessage,
  MDNS_SERVICE_DOMAIN,
  MDNS_SERVICE_NAME,
  MDNS_SERVICE_PROTOCOL,
} from '@portapapeles/protocol';

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
}

export type LogLevel = 'info' | 'error';
export type LogFn = (message: string, level?: LogLevel) => void;

const zeroconf = new Zeroconf();

let cachedDeviceId: string | null = null;

/** Id estable del dispositivo para esta sesión de la app (en memoria; persistirlo es trabajo de una fase posterior). */
function getDeviceId(): string {
  if (!cachedDeviceId) {
    cachedDeviceId = Crypto.randomUUID();
  }
  return cachedDeviceId;
}

/**
 * Arranca el escaneo mDNS del servicio anunciado por el cliente de escritorio.
 * Devuelve una función de limpieza que detiene el escaneo y quita los listeners.
 */
export function startLanDiscovery(onPeerFound: (peer: DiscoveredPeer) => void, log: LogFn): () => void {
  const handleStart = () => log('Escaneo mDNS iniciado');
  const handleError = (error: unknown) => log(`Error de escaneo mDNS: ${String(error)}`, 'error');
  const handleResolved = (service: {
    name: string;
    host: string;
    port: number;
    addresses?: string[];
  }) => {
    const address = service.addresses?.[0];
    if (!address) {
      log(`Servicio "${service.name}" resuelto sin dirección IP, ignorado`, 'error');
      return;
    }
    log(`Peer encontrado: ${service.name} @ ${address}:${service.port}`);
    onPeerFound({ name: service.name, host: address, port: service.port });
  };

  zeroconf.on('start', handleStart);
  zeroconf.on('error', handleError);
  zeroconf.on('resolved', handleResolved);

  log(`Buscando servicio "${MDNS_SERVICE_NAME}.${MDNS_SERVICE_PROTOCOL}.${MDNS_SERVICE_DOMAIN}"…`);
  zeroconf.scan(MDNS_SERVICE_NAME, MDNS_SERVICE_PROTOCOL, MDNS_SERVICE_DOMAIN);

  return () => {
    zeroconf.stop();
    zeroconf.removeAllListeners();
  };
}

/**
 * Se conecta por TCP al peer y envía un SyncMessage de tipo 'text'.
 * El framing es "una línea = un mensaje" (NDJSON): el propio JSON.stringify escapa
 * cualquier salto de línea del contenido, así que un simple "\n" delimita mensajes sin ambigüedad.
 */
export async function sendTextMessage(peer: DiscoveredPeer, content: string, log: LogFn): Promise<void> {
  const checksum = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content);
  const message = buildTextMessage({
    id: Crypto.randomUUID(),
    deviceId: getDeviceId(),
    timestamp: Date.now(),
    checksum,
    content,
  });

  return new Promise((resolve, reject) => {
    log(`Conectando a ${peer.host}:${peer.port}…`);
    const client = TcpSocket.createConnection({ host: peer.host, port: peer.port }, () => {
      log(`Conectado. Enviando mensaje ${message.id}`);
      client.write(JSON.stringify(message) + '\n');
    });

    client.on('data', (data) => {
      log(`Respuesta del peer: ${data.toString()}`);
    });

    client.on('error', (error: unknown) => {
      log(`Error de socket: ${String(error)}`, 'error');
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    client.on('close', () => {
      log('Conexión cerrada');
      resolve();
    });
  });
}
