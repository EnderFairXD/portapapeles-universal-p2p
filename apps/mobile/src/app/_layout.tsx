import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { connection } from '@/lib/connection';

// TextEncoder es nativo de Hermes y TextDecoder lo instala el runtime de Expo
// (expo/src/winter): no hace falta polyfill.
export default function RootLayout() {
  useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, []);

  return <Stack screenOptions={{ headerShown: false }} />;
}
