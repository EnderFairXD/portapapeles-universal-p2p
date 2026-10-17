// Busca el PC por mDNS (_clipsync._tcp.local.). Un único escaneo mientras la app lo pida.
import { MDNS_SERVICE_DOMAIN, MDNS_SERVICE_NAME, MDNS_SERVICE_PROTOCOL } from '@clipsync/protocol';
import Zeroconf, { type ZeroconfService } from 'react-native-zeroconf';

import { servicePcs, type PcAddress } from './pcAddress';

const zeroconf = new Zeroconf();
/** Servicios resueltos por nombre; el más reciente sustituye al anterior. */
const services = new Map<string, ZeroconfService>();
const waiters = new Set<() => void>();
let scanning = false;

zeroconf.on('resolved', (service) => {
  services.set(service.name, service);
  for (const w of [...waiters]) w();
});
zeroconf.on('remove', (name) => {
  services.delete(name);
});
zeroconf.on('error', () => {
  // el escaneo nativo cayó: se vuelve a lanzar en la siguiente búsqueda
  scanning = false;
});

/** Arranca el escaneo si no está en marcha (se mantiene entre reintentos de conexión). */
export function startDiscovery(): void {
  if (scanning) return;
  scanning = true;
  try {
    zeroconf.scan(MDNS_SERVICE_NAME, MDNS_SERVICE_PROTOCOL, MDNS_SERVICE_DOMAIN);
  } catch {
    scanning = false;
  }
}

export function stopDiscovery(): void {
  services.clear();
  if (!scanning) return;
  scanning = false;
  try {
    zeroconf.stop();
  } catch {
    // el escaneo ya estaba parado
  }
}

function resolved(fp: string): PcAddress[] {
  return [...services.values()].flatMap((s) => servicePcs(s, fp));
}

/** Direcciones del PC con esa huella; si aún no hay ninguna, espera hasta `timeoutMs`. */
export function resolvedPcs(timeoutMs: number, fp: string): Promise<PcAddress[]> {
  startDiscovery();
  const now = resolved(fp);
  if (now.length > 0 || timeoutMs <= 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      const pcs = resolved(fp);
      if (pcs.length === 0 && !expired) return; // otro servicio u otro PC
      clearTimeout(timer);
      waiters.delete(done);
      resolve(pcs);
    };
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      done();
    }, timeoutMs);
    waiters.add(done);
  });
}
