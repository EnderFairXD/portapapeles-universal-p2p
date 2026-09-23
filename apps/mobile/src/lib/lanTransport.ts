import * as Crypto from 'expo-crypto';
import { File, FileMode } from 'expo-file-system';
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

/** Tamaño de cada fragmento al mandar un archivo (ver sendFileMessage). */
const FILE_CHUNK_BYTES = 1024 * 1024;

/**
 * Techo de cordura, no una limitación técnica real (el chunking ya no carga el archivo
 * entero en memoria): evita transferencias absurdamente largas por error de selección.
 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Codifica un Uint8Array a base64 sin pasar por `String.fromCharCode(...bytes)`: con un
 * chunk de 1 MB, el spread de ~1 millón de argumentos puede reventar el stack de Hermes.
 * Este loop es O(n) y no tiene ese límite.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;

    out.push(BASE64_ALPHABET[(triple >> 18) & 0x3f]);
    out.push(BASE64_ALPHABET[(triple >> 12) & 0x3f]);
    out.push(i + 1 < len ? BASE64_ALPHABET[(triple >> 6) & 0x3f] : '=');
    out.push(i + 2 < len ? BASE64_ALPHABET[triple & 0x3f] : '=');
  }
  return out.join('');
}

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
 * Cuánto esperar la respuesta del peer antes de dar el envío por fallido. Sin esto, un
 * peer que no responde (apagado, IP obsoleta, firewall) dejaba la promesa colgada para
 * siempre y con ella el spinner de "enviando" en la UI — ver nota de bug en sendSyncMessage.
 */
const SEND_TIMEOUT_MS = 5000;

/**
 * El texto exacto de un error de conexión rechazada depende de la plataforma (Android
 * envuelve `ECONNREFUSED`/`errno`, iOS da su propio mensaje) — por eso se busca por
 * varias variantes en vez de una sola cadena literal.
 */
function isConnectionRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /econnrefused|connection refused/i.test(text);
}

/**
 * En modo USB, `peer.host` es siempre "127.0.0.1" (ver handleScan en index.tsx) — si esa
 * conexión se rechaza, el motivo casi seguro es que el túnel `adb reverse` todavía no
 * está levantado (app de escritorio cerrada, cable desconectado, o el watcher de
 * usb.rs todavía no detectó el dispositivo). Mostrar el volcado crudo del socket ahí no
 * ayuda a nadie; este mensaje sí dice qué hacer.
 */
function describeSocketError(peer: DiscoveredPeer, error: unknown): string {
  if (peer.host === '127.0.0.1' && isConnectionRefused(error)) {
    return '⚠️ No se pudo conectar por USB. Asegúrate de que la app de escritorio ClipSync está abierta y el cable conectado.';
  }
  return `Error de socket: ${String(error)}`;
}

/**
 * Conecta por TCP al peer y envía un SyncMessage ya construido.
 * Framing "una línea = un mensaje" (NDJSON): JSON.stringify escapa cualquier salto de
 * línea embebido, así que un simple "\n" delimita mensajes sin ambigüedad.
 *
 * Bug corregido: antes esta promesa solo se resolvía en el evento 'close' del socket, pero
 * nunca cerrábamos la conexión desde aquí — dependíamos por completo de que el servidor la
 * cerrara. El servidor (transport.rs), a su vez, volvía a esperar una línea más tras
 * responder "OK", así que nunca cerraba tampoco. Resultado: interbloqueo — ambos lados
 * esperando al otro — y la promesa (y por tanto el `isSending` de la UI) jamás se resolvía.
 * El fix es doble: (1) el servidor ahora cierra tras responder al primer mensaje, y (2) aquí
 * ya no dependemos de eso — en cuanto llega la respuesta cerramos el socket nosotros mismos
 * y resolvemos, más un timeout de seguridad por si el peer no responde en absoluto.
 */
function sendSyncMessage(peer: DiscoveredPeer, message: SyncMessage, log: LogFn): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    log(`Conectando a ${peer.host}:${peer.port}…`);
    const client = TcpSocket.createConnection({ host: peer.host, port: peer.port }, () => {
      log(`Conectado. Enviando mensaje ${message.id} (${message.type})`);
      client.write(JSON.stringify(message) + '\n');
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      log(`Tiempo de espera agotado (${SEND_TIMEOUT_MS / 1000}s) esperando respuesta de ${peer.host}:${peer.port}`, 'error');
      client.destroy();
      reject(new Error('send_timeout'));
    }, SEND_TIMEOUT_MS);

    client.on('data', (data) => {
      log(`Respuesta del peer: ${data.toString().trim()}`);
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      client.destroy();
      resolve();
    });

    client.on('error', (error: unknown) => {
      log(describeSocketError(peer, error), 'error');
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    client.on('close', () => {
      log('Conexión cerrada');
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
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

export type FileSendProgress = (sentChunks: number, totalChunks: number) => void;

/**
 * Envía un archivo local fragmentado en mensajes 'file' de FILE_CHUNK_BYTES cada uno.
 * Antes se leía el archivo entero de una vez con `file.base64()` — con archivos de pocos
 * MB eso colapsaba el puente de RN (un string base64 gigante cruzando a nativo de una
 * sola vez). Ahora se abre el archivo con `File.open('r')` y se lee con `readBytes()` en
 * fragmentos, así que nunca hay más de un chunk en memoria a la vez.
 *
 * Todos los chunks de una misma transferencia comparten el mismo `id` (actúa como id de
 * transferencia para que el receptor los agrupe — ver descripción de `id` en el schema);
 * se distinguen por `chunkIndex`/`chunkTotal`. El checksum de cada chunk es del propio
 * `chunkData` en base64, no del archivo completo — calcular eso exigiría releer el
 * archivo entero, justo el problema de memoria que el chunking evita (mismo criterio que
 * en transport.rs).
 *
 * Cada chunk se manda en su propia conexión TCP corta (reutilizando sendSyncMessage tal
 * cual, sin reabrir el debate del cierre de conexión resuelto en el bugfix anterior),
 * una tras otra en secuencia — más lento que una conexión persistente, pero mucho más
 * simple de razonar; optimizarlo es trabajo de una fase posterior si hace falta.
 */
export async function sendFileMessage(
  peer: DiscoveredPeer,
  pickedFile: PickedFile,
  log: LogFn,
  onProgress?: FileSendProgress,
): Promise<void> {
  if (pickedFile.size > MAX_FILE_BYTES) {
    const limitMb = (MAX_FILE_BYTES / (1024 * 1024)).toFixed(0);
    log(`"${pickedFile.name}" supera el límite de ${limitMb} MB`, 'error');
    throw new Error('file_too_large');
  }

  const transferId = Crypto.randomUUID();
  const deviceId = getDeviceId();
  const file = new File(pickedFile.uri);
  const handle = file.open(FileMode.ReadOnly);

  try {
    const totalSize = handle.size ?? pickedFile.size;
    const chunkTotal = Math.max(1, Math.ceil(totalSize / FILE_CHUNK_BYTES));
    log(`Enviando "${pickedFile.name}" en ${chunkTotal} fragmento(s) de ${FILE_CHUNK_BYTES / (1024 * 1024)} MB…`);

    for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex += 1) {
      const bytes = handle.readBytes(FILE_CHUNK_BYTES);
      const chunkData = bytesToBase64(bytes);
      const checksum = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, chunkData);

      const message = buildFileMessage({
        id: transferId,
        deviceId,
        timestamp: Date.now(),
        checksum,
        fileName: pickedFile.name,
        mimeType: pickedFile.mimeType,
        size: totalSize,
        chunkIndex,
        chunkTotal,
        chunkData,
      });

      await sendSyncMessage(peer, message, log);
      onProgress?.(chunkIndex + 1, chunkTotal);
    }

    log(`"${pickedFile.name}" enviado completo (${chunkTotal} fragmento(s))`);
  } finally {
    handle.close();
  }
}
