// Direcciones del PC a probar al conectar por WiFi (puro, sin React Native).
import { PROTOCOL_VERSION } from '@clipsync/protocol';

export interface PcAddress {
  host: string;
  port: number;
}

/** Lo que usa este módulo de un servicio resuelto por mDNS. */
export interface ResolvedService {
  name: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, string>;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Todas las direcciones de un servicio, primero las IPv4. Ninguna si es de otra versión o si
 * su huella (`fp` en la TXT) no es la de nuestro PC: dos PCs en la misma red no se confunden.
 */
export function servicePcs(service: ResolvedService, fp: string): PcAddress[] {
  if (service.txt?.fp !== fp) return [];
  const v = service.txt?.v;
  if (v !== undefined && v !== String(PROTOCOL_VERSION)) return [];
  if (!service.port) return [];
  const addresses = service.addresses ?? [];
  const sorted = [...addresses.filter((a) => IPV4.test(a)), ...addresses.filter((a) => !IPV4.test(a))];
  return sorted.map((host) => ({ host, port: service.port }));
}

/** Orden de prueba: la última dirección que funcionó, las de mDNS y las del QR, sin repetir. */
export function connectCandidates(last: PcAddress | null, resolved: PcAddress[], qr: PcAddress[]): PcAddress[] {
  const out: PcAddress[] = [];
  for (const a of [...(last ? [last] : []), ...resolved, ...qr]) {
    if (!out.some((o) => o.host === a.host && o.port === a.port)) out.push(a);
  }
  return out;
}

/** Valida la dirección guardada en settings.json. */
export function parseLastPc(raw: unknown): PcAddress | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { host, port } = raw as Record<string, unknown>;
  if (typeof host !== 'string' || host === '') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}
