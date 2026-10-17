// Paleta de ClipSync; es la misma que usa la app de escritorio (variante oscura).
export const colors = {
  bg: '#0d0e24',
  surface: '#171935',
  surfaceAlt: '#1f2247',
  border: '#2c2f5c',
  indigo: '#6366f1',
  indigoDeep: '#4338ca',
  cyan: '#22d3ee',
  text: '#eef0fb',
  textMuted: '#8d90bd',
  danger: '#f87171',
  // cabecera con degradado, hacia el fondo
  headerTop: '#312e81',
  headerMuted: '#c3c6ee',
  // enlace PC - móvil y marcas de dirección
  linkOff: '#4a4d86',
  outFg: '#a5b4fc',
  outBg: 'rgba(99, 102, 241, 0.2)',
  inFg: '#67e8f9',
  inBg: 'rgba(34, 211, 238, 0.14)',
  dangerBg: 'rgba(248, 113, 113, 0.14)',
  infoBg: 'rgba(99, 102, 241, 0.18)',
} as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/** Escala tipográfica (fuente del sistema: Roboto en Android). */
export const type = {
  brand: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  title: { fontSize: 20, fontWeight: '700', lineHeight: 26 },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  section: { fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
} as const;

/** Tamaño mínimo recomendado para zonas táctiles. */
export const TOUCH = 44;
