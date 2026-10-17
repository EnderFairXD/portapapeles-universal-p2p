// Cuenta los selectores del sistema abiertos (puro, sin React Native).
// Un selector manda la app a segundo plano; mientras esté abierto no se corta la conexión.

export interface PickerGuard {
  /** Registra un selector abierto y devuelve su ficha. */
  enter(): number;
  /** Cierra la ficha; una ficha anterior a un reset() ya no cuenta. */
  leave(token: number): void;
  /** Olvida los selectores abiertos (la app volvió a primer plano: ninguno sigue vivo). */
  reset(): void;
  isOpen(): boolean;
}

export function createPickerGuard(): PickerGuard {
  let open = 0;
  let epoch = 0;
  return {
    enter() {
      open += 1;
      return epoch;
    },
    leave(token) {
      // tras un reset(), el cierre tardío de un selector viejo no debe restar a uno nuevo
      if (token === epoch && open > 0) open -= 1;
    },
    reset() {
      open = 0;
      epoch += 1;
    },
    isOpen() {
      return open > 0;
    },
  };
}
