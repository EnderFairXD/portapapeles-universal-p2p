import { MAX_FRAME_BYTES } from './constants';

/** Antepone la longitud u16 big-endian al payload. */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new RangeError(`Trama de ${payload.length} bytes: el máximo es ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(2 + payload.length);
  out[0] = payload.length >> 8;
  out[1] = payload.length & 0xff;
  out.set(payload, 2);
  return out;
}

/** Reensambla tramas a partir de un flujo de bytes troceado de forma arbitraria. */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buf.length === 0) {
      this.buf = chunk;
    } else {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf, 0);
      joined.set(chunk, this.buf.length);
      this.buf = joined;
    }

    const frames: Uint8Array[] = [];
    let off = 0;
    while (this.buf.length - off >= 2) {
      const len = (this.buf[off] << 8) | this.buf[off + 1];
      if (this.buf.length - off - 2 < len) break;
      frames.push(this.buf.slice(off + 2, off + 2 + len));
      off += 2 + len;
    }
    this.buf = this.buf.slice(off);
    return frames;
  }
}
