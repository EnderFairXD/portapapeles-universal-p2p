// react-native-zeroconf no publica tipos propios (ver README/npm). Solo declaramos
// la superficie que usa este proyecto (src/lib/lanTransport.ts).
declare module 'react-native-zeroconf' {
  export interface ZeroconfService {
    name: string;
    fullName: string;
    host: string;
    port: number;
    addresses: string[];
    txt?: Record<string, string>;
  }

  type ZeroconfEvent = 'start' | 'stop' | 'found' | 'resolved' | 'remove' | 'update' | 'error';

  export default class Zeroconf {
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
    on(event: 'resolved', handler: (service: ZeroconfService) => void): void;
    on(event: 'found' | 'remove', handler: (name: string) => void): void;
    on(event: 'error', handler: (error: unknown) => void): void;
    on(event: 'start' | 'stop' | 'update', handler: () => void): void;
    removeAllListeners(): void;
  }
}
