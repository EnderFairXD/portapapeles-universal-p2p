// react-native-zeroconf 0.14 no publica tipos propios. Solo se declara la superficie que
// usa este proyecto (src/lib/discovery.ts).
declare module 'react-native-zeroconf' {
  export interface ZeroconfService {
    name: string;
    fullName: string;
    host: string;
    port: number;
    addresses: string[];
    txt?: Record<string, string>;
  }

  export default class Zeroconf {
    scan(type?: string, protocol?: string, domain?: string): void;
    stop(): void;
    on(event: 'resolved', handler: (service: ZeroconfService) => void): void;
    on(event: 'remove', handler: (name: string) => void): void;
    on(event: 'error', handler: (error: unknown) => void): void;
    removeListener(event: 'resolved', handler: (service: ZeroconfService) => void): void;
  }
}
