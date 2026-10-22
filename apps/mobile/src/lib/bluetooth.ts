// Estado, permiso y dispositivos emparejados de Bluetooth (Android). Solo se usan dispositivos
// ya emparejados en el sistema: no hay escaneo, así que no se pide BLUETOOTH_SCAN.
import { PermissionsAndroid, Platform } from 'react-native';

import { clipsyncNative, type BondedDevice } from '../../modules/clipsync-native';
import { withPicker } from './files';
import type { PolicyCtx } from './transportPolicy';

const CONNECT = 'android.permission.BLUETOOTH_CONNECT' as const;

/** BLUETOOTH_CONNECT se pide en tiempo de ejecución desde Android 12 (API 31). */
const needsRuntimePermission = Platform.OS === 'android' && Number(Platform.Version) >= 31;

export function bluetoothState(): PolicyCtx['btState'] {
  try {
    return clipsyncNative?.bluetoothState() ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** ¿Ya está concedido? Antes de Android 12 no hay permiso en tiempo de ejecución. */
export async function hasBluetoothPermission(): Promise<boolean> {
  if (!needsRuntimePermission) return true;
  try {
    return await PermissionsAndroid.check(CONNECT);
  } catch {
    return false;
  }
}

/** Pide BLUETOOTH_CONNECT. El diálogo manda la app a segundo plano: `withPicker` evita que se pause. */
export async function requestBluetoothPermission(): Promise<boolean> {
  if (await hasBluetoothPermission()) return true;
  try {
    const result = await withPicker(() => PermissionsAndroid.request(CONNECT));
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

/** Dispositivos emparejados en el sistema (vacío sin permiso, sin Bluetooth o ante un error). */
export function listBondedDevices(): BondedDevice[] {
  try {
    return clipsyncNative?.bondedDevices() ?? [];
  } catch {
    return [];
  }
}
