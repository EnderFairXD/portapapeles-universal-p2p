import * as Clipboard from 'expo-clipboard';
import TcpSocket from 'react-native-tcp-socket';

export type LogLevel = 'info' | 'error';
export type LogFn = (message: string, level?: LogLevel) => void;

export interface GuestServerHandle {
  stop: () => void;
}

export interface StartGuestServerOptions {
  port: number;
  token: string;
  log: LogFn;
}

const HTTP_VERSION = 'HTTP/1.1';
const CRLF = '\r\n';

/**
 * Sin `Content-Length` a propósito: cerramos la conexión (`Connection: close` +
 * `socket.end()`) justo después de escribir la respuesta, y HTTP/1.1 permite que el
 * cierre delimite el cuerpo cuando no hay `Content-Length` ni `Transfer-Encoding`. Evita
 * tener que calcular el tamaño en bytes UTF-8 de la respuesta sin `Buffer` (no disponible
 * por defecto en Hermes/RN) — curl y PowerShell entienden este delimitado perfectamente.
 */
function buildResponse(code: number, statusText: string, body: string, contentType = 'text/plain; charset=utf-8'): string {
  return [`${HTTP_VERSION} ${code} ${statusText}`, `Content-Type: ${contentType}`, 'Connection: close', '', body].join(
    CRLF,
  );
}

/** Parseo mínimo de la línea de petición: "MÉTODO /ruta HTTP/1.1". */
function parseRequestLine(line: string): { method: string; path: string } | null {
  const match = /^([A-Z]+)\s+(\S+)\s+HTTP\/\d\.\d$/.exec(line.trim());
  if (!match) return null;
  return { method: match[1], path: match[2] };
}

function parseContentLength(headerLines: string[]): number {
  const header = headerLines.find((h) => h.toLowerCase().startsWith('content-length:'));
  if (!header) return 0;
  const value = parseInt(header.split(':')[1]?.trim() ?? '0', 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Levanta el servidor HTTP del Modo Invitado (docs/architecture.md §6). Implementa a
 * mano lo mínimo de HTTP/1.1 necesario (una petición por conexión, sin keep-alive) sobre
 * `TcpSocket.createServer` — la misma librería que ya usa LanTransport en modo cliente,
 * sin dependencias nuevas.
 *
 * `GET  /t/<token>/clipboard` → devuelve el portapapeles del móvil como `text/plain`.
 * `POST /t/<token>/clipboard` → escribe el body recibido en el portapapeles del móvil.
 *
 * Cualquier otra ruta, o un token que no coincida con `token`, responde 404 sin
 * distinguir "ruta no existe" de "token incorrecto", para no darle pistas a quien intente
 * adivinar el token de otra persona en la misma red.
 */
export function startGuestServer({ port, token, log }: StartGuestServerOptions): GuestServerHandle {
  const expectedPath = `/t/${token}/clipboard`;

  const server = TcpSocket.createServer((socket) => {
    let buffered = '';
    let headersParsed = false;
    let responded = false;
    let contentLength = 0;
    let method = '';
    let path = '';

    const respond = (code: number, statusText: string, body: string) => {
      if (responded) return;
      responded = true;
      socket.end(buildResponse(code, statusText, body));
    };

    const handleRequest = () => {
      if (path !== expectedPath) {
        respond(404, 'Not Found', 'No encontrado\n');
        return;
      }

      if (method === 'GET') {
        Clipboard.getStringAsync()
          .then((content) => {
            respond(200, 'OK', content);
            log('[Invitado] Portapapeles servido (GET)');
          })
          .catch((error: unknown) => {
            respond(500, 'Internal Server Error', 'No se pudo leer el portapapeles\n');
            log(`[Invitado] Error leyendo el portapapeles: ${String(error)}`, 'error');
          });
        return;
      }

      if (method === 'POST') {
        const body = buffered.slice(0, contentLength);
        Clipboard.setStringAsync(body)
          .then(() => {
            respond(200, 'OK', 'OK\n');
            log('[Invitado] Portapapeles actualizado (POST)');
          })
          .catch((error: unknown) => {
            respond(500, 'Internal Server Error', 'No se pudo escribir el portapapeles\n');
            log(`[Invitado] Error escribiendo el portapapeles: ${String(error)}`, 'error');
          });
        return;
      }

      respond(405, 'Method Not Allowed', 'Método no permitido\n');
    };

    socket.on('data', (data) => {
      buffered += data.toString();

      if (!headersParsed) {
        const headerEnd = buffered.indexOf(CRLF + CRLF);
        if (headerEnd === -1) return; // esperar más datos

        const headerBlock = buffered.slice(0, headerEnd);
        buffered = buffered.slice(headerEnd + 4);
        headersParsed = true;

        const [requestLine, ...headerLines] = headerBlock.split(CRLF);
        const parsed = parseRequestLine(requestLine);
        if (!parsed) {
          respond(400, 'Bad Request', 'Petición HTTP inválida\n');
          return;
        }

        method = parsed.method;
        path = parsed.path;
        contentLength = parseContentLength(headerLines);
        log(`[Invitado] ${method} ${path} de ${socket.remoteAddress ?? '?'}`);
      }

      if (headersParsed && !responded && buffered.length >= contentLength) {
        handleRequest();
      }
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
