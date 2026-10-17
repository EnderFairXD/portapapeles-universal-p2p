// Contrato con el backend de Tauri (Tarea 10): el estado completo que llega por "ui-state".
// En Rust `null` es "ausente"; en TS los campos opcionales aceptan ambas formas.

export type Transport = "wifi" | "usb";
export type Direction = "in" | "out";
export type HistoryDirection = Direction | "local";
export type TransferState = "queued" | "active" | "failed" | "cancelled";

export interface Peer {
  sessionId: number;
  deviceId: string;
  deviceName: string;
  transport: Transport;
}

export interface HistoryItem {
  id: number;
  kind: "text" | "file";
  direction: HistoryDirection;
  text?: string | null;
  /** Nombre tal cual lo mandó el móvil: solo para mostrar. */
  fileName?: string | null;
  /** Ruta real: archivo guardado (in) o de origen (out). */
  location?: string | null;
  atMs: number;
}

export interface Transfer {
  transferId: string;
  direction: Direction;
  /** Nombre en bruto que mandó el móvil: nunca como HTML. */
  name: string;
  size: number;
  bytes: number;
  state: TransferState;
  error?: string | null;
  location?: string | null;
}

/** Móvil emparejado; `deviceKey` es su clave pública en hex (la misma que `Peer.deviceId`). */
export interface PairedDevice {
  deviceKey: string;
  deviceName: string;
  pairedAtMs: number;
  connected: boolean;
}

/** QR de emparejamiento en curso. El SVG viene del backend y solo se usa como imagen. */
export interface PairingInfo {
  qrSvg: string;
  expiresAtMs: number;
}

export interface UiState {
  pcName: string;
  /** El último es el más reciente. */
  peers: Peer[];
  /** Más reciente primero. */
  history: HistoryItem[];
  transfers: Transfer[];
  clipboardError?: string | null;
  clipNotice?: string | null;
  /** El PC no pudo abrir su puerto TCP (p. ej. otra copia abierta). */
  serverError?: string | null;
  /** Móviles emparejados con este PC. */
  paired: PairedDevice[];
  /** `null` si no hay un QR vigente. */
  pairing: PairingInfo | null;
  pairNotice?: string | null;
}
