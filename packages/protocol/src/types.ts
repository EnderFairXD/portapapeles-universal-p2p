export type SyncMessageType = 'text' | 'file' | 'token';

export interface TextPayload {
  content: string;
}

export interface TokenPayload {
  content: string;
  label?: string;
  expiresAt?: number;
}

export interface FilePayload {
  fileName: string;
  mimeType: string;
  size: number;
  chunkIndex: number;
  chunkTotal: number;
  /** Fragmento en base64. */
  chunkData: string;
}

interface SyncMessageBase {
  protocolVersion: string;
  id: string;
  deviceId: string;
  timestamp: number;
  /** SHA-256 en hex minúscula del contenido completo. */
  checksum: string;
}

export type SyncMessage =
  | (SyncMessageBase & { type: 'text'; payload: TextPayload })
  | (SyncMessageBase & { type: 'file'; payload: FilePayload })
  | (SyncMessageBase & { type: 'token'; payload: TokenPayload });
