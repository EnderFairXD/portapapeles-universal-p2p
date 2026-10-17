// Busca el PC por mDNS (_clipsync._tcp.local.).
import { MDNS_SERVICE_DOMAIN, MDNS_SERVICE_NAME, MDNS_SERVICE_PROTOCOL, PROTOCOL_VERSION } from '@clipsync/protocol';
import Zeroconf, { type ZeroconfService } from 'react-native-zeroconf';

export interface DiscoveredPc {
  host: string;
  port: number;
  name: string;
}

const zeroconf = new Zeroconf();
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Búsqueda en curso: el escaneo nativo es único, así que las llamadas simultáneas la comparten. */
let current: Promise<DiscoveredPc | null> | null = null;

function toPc(service: ZeroconfService): DiscoveredPc | null {
  // un PC con otra versión del protocolo no sirve
  const v = service.txt?.v;
  if (v !== undefined && v !== String(PROTOCOL_VERSION)) return null;
  const addresses = service.addresses ?? [];
  const host = addresses.find((a) => IPV4.test(a)) ?? addresses[0];
  if (!host || !service.port) return null;
  return { host, port: service.port, name: service.name };
}

/** Resuelve el primer servicio _clipsync._tcp, o null si no aparece en `timeoutMs`. */
export function discoverPc(timeoutMs: number): Promise<DiscoveredPc | null> {
  if (current) return current;
  const search = new Promise<DiscoveredPc | null>((resolve) => {
    let done = false;
    const finish = (pc: DiscoveredPc | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      zeroconf.removeListener('resolved', onResolved);
      try {
        zeroconf.stop();
      } catch {
        // el escaneo ya estaba parado
      }
      resolve(pc);
    };
    const onResolved = (service: ZeroconfService) => {
      const pc = toPc(service);
      if (pc) finish(pc);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    zeroconf.on('resolved', onResolved);
    try {
      zeroconf.scan(MDNS_SERVICE_NAME, MDNS_SERVICE_PROTOCOL, MDNS_SERVICE_DOMAIN);
    } catch {
      finish(null);
    }
  });
  current = search;
  void search.then(() => {
    current = null;
  });
  return search;
}
