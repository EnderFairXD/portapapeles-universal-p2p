import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { connection } from '@/lib/connection';
import { sendSharedFile } from '@/lib/sendFlow';
import { useConnection } from '@/lib/useConnection';
import { colors } from '@/theme';

const ONLY_FILES = 'ClipSync solo recibe archivos al compartir';

/**
 * «Compartir → ClipSync»: encola los archivos del intent en cuanto hay conexión
 * (mientras tanto Home enseña «Esperando conexión…») y después lo descarta.
 */
function ShareSender() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const { status } = useConnection();
  // por dónde va el intent actual, para no reenviar archivos si el efecto se repite
  const progress = useRef<{ intent: unknown; next: number } | null>(null);

  useEffect(() => {
    if (!hasShareIntent) {
      progress.current = null;
      return;
    }
    const files = shareIntent.files;
    if (!files || files.length === 0) {
      connection.reportError(ONLY_FILES);
      resetShareIntent();
      return;
    }
    if (status !== 'connected') return;

    if (progress.current?.intent !== shareIntent) progress.current = { intent: shareIntent, next: 0 };
    const p = progress.current;
    let failure: string | null = null;
    while (p.next < files.length) {
      const result = sendSharedFile(files[p.next]);
      if (result.kind === 'no_connection') return; // la sesión cayó: se sigue cuando vuelva
      if (result.kind === 'failed') failure = result.message;
      p.next += 1;
    }
    // un envío correcto borra el aviso: si algún archivo falló, se vuelve a mostrar
    if (failure) connection.reportError(failure);
    resetShareIntent();
  }, [hasShareIntent, shareIntent, status, resetShareIntent]);

  return null;
}

// TextEncoder es nativo de Hermes y TextDecoder lo instala el runtime de Expo
// (expo/src/winter): no hace falta polyfill.
export default function RootLayout() {
  useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, []);

  return (
    <ShareIntentProvider>
      <StatusBar style="light" />
      <ShareSender />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </ShareIntentProvider>
  );
}
