# SDD ledger — plan: docs/superpowers/plans/2026-10-22-clipsync-fase4-bluetooth.md
Modo barato (Javier): Sonnet por bloque, sin revisión por bloque, revisión final única. Base: c0a33fb. Rama main.
Block A: done 1da7fe4 (sin revisión; require_authentication=true a probar con BlueZ real)
Block B: done cbc795a (crate completo no compila para Windows por entorno; rfcomm_windows.rs verificado aislado con windows 0.62.2 para msvc — CI fase 5)
Block C: done 2f08a6b. Ruling R1: el cambio a un medio mejor cierra la sesión vieja antes del handshake nuevo (sin solapar sesiones) — más simple que dos Session a la vez — coste: un hueco de un handshake. Ruling R2: Block D hace que setTransportMode a otro modo fijo espere a que no haya transferencias (o avise) — coste: ninguno.
Block D: done eec07a3
Final review (Sonnet): With fixes. Importantes: fallos de handshake por Bluetooth desemparejan; dirección no vinculada abre el diálogo de emparejamiento del sistema. Menores elegidos para la tanda: EOF en Windows, margen del temporizador de cambio, promise.reject sin proteger.
Final review minor (deferred): sin alternativa si falla el handshake tras un cambio de medio (USB "muerto"); connectRfcomm no se cancela al cambiar de generación; log ruidoso en Windows al cerrar; Profile de bluer sin canal fijo (comprobar SDP en hardware).
Final fix wave: done b831350 (móvil 198/198, cargo 291/291 verificados por el controlador)
