// Plugin de configuración: permisos de Bluetooth del manifiesto de Android.
// app.json no admite `maxSdkVersion`, y los permisos antiguos solo valen hasta Android 11.
const { withAndroidManifest } = require('expo/config-plugins');

/** Solo dispositivos ya emparejados: sin escaneo, así que no se declara BLUETOOTH_SCAN. */
const PERMISSIONS = [
  // Android 12+ (se pide en tiempo de ejecución al primer uso)
  { name: 'android.permission.BLUETOOTH_CONNECT' },
  // Android 11 e inferior
  { name: 'android.permission.BLUETOOTH', maxSdkVersion: '30' },
  { name: 'android.permission.BLUETOOTH_ADMIN', maxSdkVersion: '30' },
];

module.exports = function withBluetooth(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const list = (manifest['uses-permission'] ??= []);
    for (const { name, maxSdkVersion } of PERMISSIONS) {
      const attrs = { 'android:name': name };
      if (maxSdkVersion) attrs['android:maxSdkVersion'] = maxSdkVersion;
      const existing = list.find((p) => p.$['android:name'] === name);
      if (existing) existing.$ = attrs;
      else list.push({ $: attrs });
    }
    // Bluetooth es opcional (WiFi y USB siguen valiendo): no se excluyen móviles sin él de la tienda
    const features = (manifest['uses-feature'] ??= []);
    const feature = 'android.hardware.bluetooth';
    if (!features.some((f) => f.$['android:name'] === feature)) {
      features.push({ $: { 'android:name': feature, 'android:required': 'false' } });
    }
    return cfg;
  });
};
