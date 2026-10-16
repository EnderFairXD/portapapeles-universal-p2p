import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** SHA-256 en hex minúscula; un string se codifica en UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}

/** SHA-256 incremental, para archivos que se leen por trozos. */
export function createSha256(): { update(b: Uint8Array): void; digestHex(): string } {
  const h = sha256.create();
  return {
    update(b) {
      h.update(b);
    },
    digestHex() {
      return bytesToHex(h.digest());
    },
  };
}
