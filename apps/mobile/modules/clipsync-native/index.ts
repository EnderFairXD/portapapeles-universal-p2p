// Módulo nativo local (solo Android): ChaCha20-Poly1305, SHA-256, base64 y sockets RFCOMM (Bluetooth). Sin él (tests, iOS)
// devuelve null y se sigue con @noble y el Buffer de react-native-tcp-socket.
import { requireOptionalNativeModule, type SharedObject } from 'expo';

export declare class Sha256Hasher extends SharedObject {
  constructor();
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

/** Dispositivo Bluetooth ya emparejado en el sistema; `address` es AA:BB:CC:DD:EE:FF en mayúsculas. */
export interface BondedDevice {
  name: string;
  address: string;
}

/** Eventos del socket RFCOMM `id`: se emiten en orden y `onClosed` es siempre el último. */
export type ClipsyncNativeEvents = {
  onData(event: { id: number; base64: string }): void;
  onClosed(event: { id: number; error?: string }): void;
};

export interface ClipsyncNativeModule {
  /** Eventos de los sockets RFCOMM (EventEmitter de Expo). */
  addListener<E extends keyof ClipsyncNativeEvents>(event: E, listener: ClipsyncNativeEvents[E]): { remove(): void };
  chachaSeal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  chachaOpen(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  Sha256Hasher: typeof Sha256Hasher;
  base64Encode(data: Uint8Array): string;
  base64Decode(text: string): Uint8Array;

  // --- Bluetooth RFCOMM: solo dispositivos ya emparejados (sin escaneo) ---
  /** `unavailable` (sin adaptador), `off` u `on`. No necesita permisos. */
  bluetoothState(): 'unavailable' | 'off' | 'on';
  /** Lanza si falta BLUETOOTH_CONNECT (Android 12+). */
  bondedDevices(): BondedDevice[];
  /**
   * Abre un socket RFCOMM al servicio `uuid` y devuelve su id. Rechaza (con el motivo) si falla o si
   * no conecta en `timeoutMs`. No entrega datos hasta `startReading(id)`.
   */
  connect(address: string, uuid: string, timeoutMs: number): Promise<number>;
  /** Tras registrar los manejadores de onData/onClosed del id. */
  startReading(id: number): void;
  /** Encola la escritura y vuelve. Lanza si el enlace ya está cerrado; un fallo posterior llega por onClosed. */
  write(id: number, base64: string): void;
  /** Idempotente: escribe lo pendiente, cierra y emite onClosed {id}. */
  close(id: number): void;
}

export const clipsyncNative = requireOptionalNativeModule<ClipsyncNativeModule>('ClipsyncNative');
