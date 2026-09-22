export * from './types';
export * from './constants';

import { PROTOCOL_VERSION } from './constants';
import type { FilePayload, SyncMessage, TextPayload } from './types';

export interface BuildTextMessageInput {
  id: string;
  deviceId: string;
  timestamp: number;
  /** SHA-256 en hex minúscula de `content`, calculado por el caller (ver README). */
  checksum: string;
  content: string;
}

export function buildTextMessage(input: BuildTextMessageInput): SyncMessage {
  const payload: TextPayload = { content: input.content };
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: input.id,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    checksum: input.checksum,
    type: 'text',
    payload,
  };
}

export interface BuildFileMessageInput {
  id: string;
  deviceId: string;
  timestamp: number;
  /** Checksum calculado por el caller (ver README) — hoy sobre el string base64, no sobre los bytes crudos (ver nota en sendFileMessage). */
  checksum: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkIndex: number;
  chunkTotal: number;
  chunkData: string;
}

export function buildFileMessage(input: BuildFileMessageInput): SyncMessage {
  const payload: FilePayload = {
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    chunkIndex: input.chunkIndex,
    chunkTotal: input.chunkTotal,
    chunkData: input.chunkData,
  };
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: input.id,
    deviceId: input.deviceId,
    timestamp: input.timestamp,
    checksum: input.checksum,
    type: 'file',
    payload,
  };
}

/** Validación de forma en runtime (no sustituye al JSON Schema, pero evita castear `any` a ciegas al recibir datos de la red). */
export function isSyncMessage(value: unknown): value is SyncMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  if (
    typeof v.protocolVersion !== 'string' ||
    typeof v.id !== 'string' ||
    typeof v.deviceId !== 'string' ||
    typeof v.timestamp !== 'number' ||
    typeof v.checksum !== 'string' ||
    typeof v.type !== 'string'
  ) {
    return false;
  }

  const payload = v.payload as Record<string, unknown> | undefined;
  if (!payload) return false;

  switch (v.type) {
    case 'text':
    case 'token':
      return typeof payload.content === 'string';
    case 'file':
      return (
        typeof payload.fileName === 'string' &&
        typeof payload.mimeType === 'string' &&
        typeof payload.size === 'number' &&
        typeof payload.chunkIndex === 'number' &&
        typeof payload.chunkTotal === 'number' &&
        typeof payload.chunkData === 'string'
      );
    default:
      return false;
  }
}
