// Saneado de nombres de archivo recibidos; replica sanitize_file_name de
// apps/desktop/src-tauri/src/core/files.rs para que ambos lados guarden lo mismo.

/** Máximo de bytes UTF-8 de un nombre de archivo. */
const MAX_NAME_BYTES = 200;

const FALLBACK = 'archivo';

/**
 * Prohibidos en Windows, de control (Cc) y de formato/bidi, que permiten disfrazar
 * la extensión (p. ej. U+202E).
 */
const FORBIDDEN = /[<>:"|?*\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const RESERVED = /^(CON|PRN|AUX|NUL|(COM|LPT)[1-9])$/;

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function trimEndDotsSpaces(s: string): string {
  return s.replace(/[. ]+$/, '');
}

function trimStartDotsSpaces(s: string): string {
  return s.replace(/^[. ]+/, '');
}

/** Separa "foto.jpg" en ["foto", ".jpg"]. Sin extensión (o solo punto inicial): [nombre, ""]. */
function splitExtension(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

function isReservedWindows(name: string): boolean {
  // decide la parte anterior al primer punto (también con extensión: "CON.txt")
  const base = name.split('.')[0].trimEnd().replace(/[a-z]/g, (c) => c.toUpperCase());
  return RESERVED.test(base);
}

/** Prefijo de `s` de como mucho `max` bytes UTF-8, sin partir caracteres. */
function takeBytes(s: string, max: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > max) break;
    used += n;
    out += ch;
  }
  return out;
}

/** Sustituye un stem sin ningún carácter útil (solo puntos/espacios, o vacío) por "archivo". */
function withValidStem(name: string): string {
  const [stem, ext] = splitExtension(name);
  return trimStartDotsSpaces(trimEndDotsSpaces(stem)) === '' ? `${FALLBACK}${ext}` : name;
}

/** Corta a MAX_NAME_BYTES conservando la extensión. */
function truncate(name: string): string {
  let [stem, ext] = splitExtension(name);
  // una extensión desmesurada no se conserva: el nombre entero hace de stem
  if (byteLength(ext) >= MAX_NAME_BYTES / 2) [stem, ext] = [name, ''];
  const short = trimEndDotsSpaces(takeBytes(stem, MAX_NAME_BYTES - byteLength(ext)));
  return trimStartDotsSpaces(short) === '' ? `${FALLBACK}${ext}` : `${short}${ext}`;
}

/**
 * Deja un nombre seguro: sin rutas, sin caracteres prohibidos, sin nombres reservados
 * y de 200 bytes como máximo. Es idempotente.
 */
export function sanitizeFileName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? '';
  let result = withValidStem(trimEndDotsSpaces(last.replace(FORBIDDEN, '')));
  if (byteLength(result) > MAX_NAME_BYTES) result = truncate(result);
  // después de recortar/truncar, que pueden dejar un nombre reservado
  if (isReservedWindows(result)) {
    result = `_${result}`;
    if (byteLength(result) > MAX_NAME_BYTES) result = truncate(result);
  }
  return result;
}
