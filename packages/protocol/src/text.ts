/**
 * Cambia cada sustituto UTF-16 suelto por U+FFFD. Un sustituto suelto viaja en JSON como
 * `\udXXX` y el PC (serde_json) lo rechaza. Hermes puede no tener String.prototype.toWellFormed.
 */
export function toWellFormed(text: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // par válido
        continue;
      }
    }
    out += text.slice(last, i) + '�';
    last = i + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}
