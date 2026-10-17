import { useSyncExternalStore } from 'react';

import { connection, type ConnState } from './connection';

/** Estado de la conexión para la interfaz; se vuelve a pintar en cada cambio. */
export function useConnection(): ConnState {
  return useSyncExternalStore(connection.subscribe, connection.getState);
}
