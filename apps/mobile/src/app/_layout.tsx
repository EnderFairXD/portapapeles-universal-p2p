import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';

import { connection } from '@/lib/connection';
import { sendSharedFile } from '@/lib/sendFlow';
import { newShareProgress, runShareQueue, type ShareProgress } from '@/lib/shareQueue';
import { useConnection } from '@/lib/useConnection';
import { colors } from '@/theme';

const ONLY_FILES = 'Solo se pueden compartir archivos con ClipSync';
const SHARE_FAILED = 'No se pudo recibir lo compartido';

// Un archivo compartido espera a que haya conexión aunque la app pase a segundo plano
// (el usuario se va al PC a abrir ClipSync): solo se descarta al enviarlo o al cancelar.
const SHARE_OPTIONS = { resetOnBackground: false };

/**
 * «Compartir → ClipSync»: encola los archivos del intent en cuanto hay conexión
 * (mientras tanto Home enseña «Esperando conexión…») y después lo descarta.
 */
function ShareSender() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const { status } = useConnection();
  // por dónde va el intent actual, para no reenviar archivos si el efecto se repite
  const progress = useRef<ShareProgress | null>(null);

  useEffect(() => {
    if (!error) return;
    connection.reportError(SHARE_FAILED);
    resetShareIntent();
  }, [error, resetShareIntent]);

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

    if (progress.current?.intent !== shareIntent) progress.current = newShareProgress(shareIntent);
    const p = progress.current;
    // si la sesión cae a medias, se sigue por donde iba cuando vuelva
    if (runShareQueue(files, p, sendSharedFile) === 'waiting') return;
    // un envío correcto borra el aviso: si algún archivo falló, se vuelve a mostrar
    if (p.failure) connection.reportError(p.failure);
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
    <ShareIntentProvider options={SHARE_OPTIONS}>
      <StatusBar style="light" />
      <ShareSender />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </ShareIntentProvider>
  );
}
