import { File, FileMode } from 'expo-file-system';
import TcpSocket from 'react-native-tcp-socket';

export type LogLevel = 'info' | 'error';
export type LogFn = (message: string, level?: LogLevel) => void;

export interface GuestServerHandle {
  stop: () => void;
}

export type GuestPayload =
  | { kind: 'text'; content: string }
  | { kind: 'file'; uri: string; name: string; mimeType: string; size: number };

export interface StartGuestServerOptions {
  port: number;
  payload: GuestPayload;
  log: LogFn;
}

const HTTP_VERSION = 'HTTP/1.1';
const CRLF = '\r\n';
/** Mismo tamaño de fragmento que usa lanTransport.ts para no cargar el archivo entero en memoria. */
const FILE_CHUNK_BYTES = 1024 * 1024;

function buildHeader(statusLine: string, headers: Record<string, string>): string {
  return [statusLine, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', ''].join(CRLF);
}

/** Parseo mínimo de la línea de petición: "MÉTODO /ruta HTTP/1.1". */
function parseRequestLine(line: string): { method: string; path: string } | null {
  const match = /^([A-Z]+)\s+(\S+)\s+HTTP\/\d\.\d$/.exec(line.trim());
  if (!match) return null;
  return { method: match[1], path: match[2] };
}

/**
 * Servidor HTTP del Modo Invitado, rediseñado para fricción cero (sin tokens, sin rutas
 * largas): una única ruta raíz `/`, GET, que entrega lo que el usuario haya elegido
 * compartir en la app (texto o archivo) — no el portapapeles del sistema.
 *
 * El texto se manda cerrando la conexión sin `Content-Length` (delimitado por cierre,
 * válido en HTTP/1.1, evita calcular bytes UTF-8 sin `Buffer`). El archivo sí lleva
 * `Content-Length` real (el tamaño ya se conoce de antemano, no hace falta medir un
 * string) y se transmite en crudo — sin base64 — leyendo con `File.open()`/
 * `FileHandle.readBytes()` en fragmentos, igual que sendFileMessage en lanTransport.ts,
 * para no cargar archivos grandes enteros en memoria.
 */
export function startGuestServer({ port, payload, log }: StartGuestServerOptions): GuestServerHandle {
  const server = TcpSocket.createServer((socket) => {
    let buffered = '';
    let headersParsed = false;
    let responded = false;

    const respondError = (code: number, statusText: string, body: string) => {
      if (responded) return;
      responded = true;
      socket.end(buildHeader(`${HTTP_VERSION} ${code} ${statusText}`, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }) + body);
    };

    const respondText = (content: string) => {
      if (responded) return;
      responded = true;
      const header = buildHeader(`${HTTP_VERSION} 200 OK`, {
        'Content-Type': 'text/plain; charset=utf-8',
        Connection: 'close',
      });
      socket.end(header + content);
      log('[Invitado] Texto servido');
    };

    const respondFile = async (file: Extract<GuestPayload, { kind: 'file' }>) => {
      if (responded) return;
      responded = true;

      const handle = new File(file.uri).open(FileMode.ReadOnly);
      try {
        const totalSize = handle.size ?? file.size;
        const header = buildHeader(`${HTTP_VERSION} 200 OK`, {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Length': String(totalSize),
          'Content-Disposition': `attachment; filename="${file.name}"`,
          Connection: 'close',
        });
        socket.write(header);

        let sent = 0;
        while (sent < totalSize) {
          const chunk = handle.readBytes(FILE_CHUNK_BYTES);
          if (chunk.length === 0) break;
          socket.write(chunk);
          sent += chunk.length;
        }
        log(`[Invitado] Archivo "${file.name}" servido (${sent} bytes)`);
      } finally {
        handle.close();
        socket.end();
      }
    };

    const handleRequest = (method: string, path: string) => {
      if (path !== '/') {
        respondError(404, 'Not Found', 'No encontrado\n');
        return;
      }
      if (method !== 'GET') {
        respondError(405, 'Method Not Allowed', 'Método no permitido\n');
        return;
      }

      if (payload.kind === 'text') {
        respondText(payload.content);
      } else {
        respondFile(payload).catch((error: unknown) => {
          log(`[Invitado] Error sirviendo el archivo: ${String(error)}`, 'error');
        });
      }
    };

    socket.on('data', (data) => {
      if (responded || headersParsed) return;
      buffered += data.toString();

      const headerEnd = buffered.indexOf(CRLF + CRLF);
      if (headerEnd === -1) return; // esperar más datos

      headersParsed = true;
      const [requestLine] = buffered.slice(0, headerEnd).split(CRLF);
      const parsed = parseRequestLine(requestLine);
      if (!parsed) {
        respondError(400, 'Bad Request', 'Petición HTTP inválida\n');
        return;
      }

      log(`[Invitado] ${parsed.method} ${parsed.path} de ${socket.remoteAddress ?? '?'}`);
      handleRequest(parsed.method, parsed.path);
    });

    socket.on('error', (error: unknown) => {
      log(`[Invitado] Error de socket: ${String(error)}`, 'error');
    });
  });

  server.on('error', (error: unknown) => {
    log(`[Invitado] Error del servidor HTTP: ${String(error)}`, 'error');
  });

  server.listen({ port, host: '0.0.0.0' }, () => {
    log(`[Invitado] Servidor HTTP escuchando en el puerto ${port}`);
  });

  return {
    stop: () => {
      server.close(() => log('[Invitado] Servidor HTTP detenido'));
    },
  };
}
