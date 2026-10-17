// Envío de archivos desde la interfaz: abre el origen y lo encola, avisando de los fallos.
import { connection } from './connection';
import { FileTooLargeError, fileSourceFromUri, pickFileSource, UnknownFileSizeError } from './files';

const NO_CONNECTION = 'No hay conexión con el PC';
const OPEN_FAILED = 'No se pudo abrir el archivo';

/** Solo se enseñan los mensajes propios; el resto de errores no (pueden traer rutas o texto interno). */
function openErrorText(e: unknown): string {
  return e instanceof FileTooLargeError || e instanceof UnknownFileSizeError ? e.message : OPEN_FAILED;
}

/** Botón «Enviar archivo»: abre el selector y envía lo elegido. */
export async function pickAndSend(): Promise<void> {
  try {
    const src = await pickFileSource();
    if (!src) return;
    if (connection.sendFile(src) === null) connection.reportError(NO_CONNECTION);
  } catch (e) {
    connection.reportError(openErrorText(e));
  }
}

export interface SharedFile {
  path: string;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
}

/**
 * - `sent`: encolado.
 * - `no_connection`: no hay sesión lista; se puede reintentar más tarde.
 * - `failed`: el archivo no se pudo abrir; devuelve el aviso para el usuario.
 */
export type SharedSendResult = { kind: 'sent' } | { kind: 'no_connection' } | { kind: 'failed'; message: string };

/** «Compartir → ClipSync»: encola un archivo recibido por el intent de compartir. */
export function sendSharedFile(file: SharedFile): SharedSendResult {
  let src;
  try {
    src = fileSourceFromUri(file.path, file.fileName ?? '', file.mimeType ?? '', file.size ?? -1);
  } catch (e) {
    return { kind: 'failed', message: openErrorText(e) };
  }
  // sendFile cierra `src` si no hay sesión lista
  return connection.sendFile(src) === null ? { kind: 'no_connection' } : { kind: 'sent' };
}
