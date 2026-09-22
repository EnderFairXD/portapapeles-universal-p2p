import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import TcpSocket from 'react-native-tcp-socket';
import Zeroconf from 'react-native-zeroconf';

import {
  buildFileMessage,
  buildTextMessage,
  MDNS_SERVICE_DOMAIN,
  MDNS_SERVICE_NAME,
  MDNS_SERVICE_PROTOCOL,
  type SyncMessage,
} from '@clipsync/protocol';

export interface DiscoveredPeer {
  name: string;
  host: string;
  port: number;
}

export interface PickedFile {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
}

export type LogLevel = 'info' | 'error';
export type LogFn = (message: string, level?: LogLevel) => void;

/**
 * Límite provisional para el envío de archivos: hoy se manda en un único SyncMessage
 * (chunkIndex 0 / chunkTotal 1), sin el loop de fragmentación real. Por encima de esto
 * el mensaje NDJSON sería una línea demasiado grande; el chunking de verdad es trabajo
 * de una fase posterior (ver docs/architecture.md).
 */
const MAX_SINGLE_MESSAGE_FILE_BYTES = 2 * 1024 * 1024;

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
 * Sigue escaneando hasta que se llame a la función de limpieza devuelta — no se detiene
 * en el primer resultado, para poder listar varios PCs si hay más de uno en la LAN.
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
 * Conecta por TCP al peer y envía un SyncMessage ya construido.
 * Framing "una línea = un mensaje" (NDJSON): JSON.stringify escapa cualquier salto de
 * línea embebido, así que un simple "\n" delimita mensajes sin ambigüedad.
 */
function sendSyncMessage(peer: DiscoveredPeer, message: SyncMessage, log: LogFn): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Conectando a ${peer.host}:${peer.port}…`);
    const client = TcpSocket.createConnection({ host: peer.host, port: peer.port }, () => {
      log(`Conectado. Enviando mensaje ${message.id} (${message.type})`);
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

export async function sendTextMessage(peer: DiscoveredPeer, content: string, log: LogFn): Promise<void> {
  const checksum = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, content);
  const message = buildTextMessage({
    id: Crypto.randomUUID(),
    deviceId: getDeviceId(),
    timestamp: Date.now(),
    checksum,
    content,
  });

  await sendSyncMessage(peer, message, log);
}

/**
 * Envía un archivo local como un único SyncMessage de tipo 'file' (sin fragmentar
 * todavía, ver MAX_SINGLE_MESSAGE_FILE_BYTES). El checksum se calcula sobre el string
 * base64 ya codificado, no sobre los bytes crudos del archivo — es una simplificación
 * consciente para esta fase: no invalida la demo (ambos extremos lo tratan igual), pero
 * no es un hash "canónico" del archivo original hasta que se implemente el chunking real.
 */
export async function sendFileMessage(peer: DiscoveredPeer, pickedFile: PickedFile, log: LogFn): Promise<void> {
  if (pickedFile.size > MAX_SINGLE_MESSAGE_FILE_BYTES) {
    const limitMb = (MAX_SINGLE_MESSAGE_FILE_BYTES / (1024 * 1024)).toFixed(0);
    log(
      `"${pickedFile.name}" pesa demasiado para esta fase (límite ${limitMb} MB sin fragmentación real)`,
      'error',
    );
    throw new Error('file_too_large_for_single_message');
  }

  log(`Leyendo "${pickedFile.name}"…`);
  const file = new File(pickedFile.uri);
  const base64Content = await file.base64();

  const checksum = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64Content);
  const message = buildFileMessage({
    id: Crypto.randomUUID(),
    deviceId: getDeviceId(),
    timestamp: Date.now(),
    checksum,
    fileName: pickedFile.name,
    mimeType: pickedFile.mimeType,
    size: pickedFile.size,
    chunkIndex: 0,
    chunkTotal: 1,
    chunkData: base64Content,
  });

  await sendSyncMessage(peer, message, log);
}
