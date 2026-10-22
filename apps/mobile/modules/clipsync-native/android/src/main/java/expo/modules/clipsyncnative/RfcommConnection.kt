package expo.modules.clipsyncnative

import android.bluetooth.BluetoothSocket
import android.util.Base64
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val READ_BUFFER_BYTES = 64 * 1024

/** Tope para vaciar las escrituras pendientes al cerrar; después se corta el socket. */
private const val FLUSH_TIMEOUT_MS = 5000L

/**
 * Un socket RFCOMM abierto. Garantías:
 * - La lectura va en un hilo propio con búfer de 64 KiB y emite `onData` y `onClosed` desde ese
 *   único hilo, así que los eventos salen en orden y `onClosed` es siempre el último.
 * - Las escrituras se serializan en un hilo propio (cola FIFO); `write` no bloquea a JS.
 * - `close` es idempotente y vacía lo escrito antes de cerrar (con tope de FLUSH_TIMEOUT_MS).
 * - Ninguna excepción escapa: se convierten en `onClosed` con el error.
 * La lectura no empieza hasta `startReading()`, para que JS registre sus manejadores antes y no
 * se pierda ningún byte.
 */
class RfcommConnection(
  val id: Int,
  private val socket: BluetoothSocket,
  private val watchdog: ScheduledExecutorService,
  private val emitData: (id: Int, base64: String) -> Unit,
  private val emitClosed: (id: Int, error: String?) -> Unit,
) {
  private val started = CountDownLatch(1)
  private val closeRequested = AtomicBoolean(false)
  private val socketClosed = AtomicBoolean(false)
  private val writer: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "clipsync-rfcomm-write-$id").apply { isDaemon = true }
  }

  /** Primer error de lectura/escritura; solo se lee desde el hilo lector. */
  @Volatile private var failure: String? = null

  private val reader = Thread({ readLoop() }, "clipsync-rfcomm-read-$id").apply { isDaemon = true }

  init {
    reader.start()
  }

  fun startReading() {
    started.countDown()
  }

  private fun readLoop() {
    try {
      started.await()
    } catch (_: InterruptedException) {
      // se sigue: el socket se cierra abajo
    }
    var error: String? = null
    try {
      val input = socket.inputStream
      val buffer = ByteArray(READ_BUFFER_BYTES)
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        if (n == 0) continue
        emitData(id, Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP))
      }
    } catch (e: Throwable) {
      // un cierre pedido por nosotros hace saltar la lectura: no es un error
      if (!closeRequested.get()) error = describe(e)
    }
    error = error ?: failure
    closeSocket()
    writer.shutdownNow()
    try {
      emitClosed(id, error)
    } catch (_: Throwable) {
      // el módulo ya no existe; nadie escucha
    }
  }

  /** Encola la escritura. Un fallo cierra el socket; lo recoge el hilo lector como `onClosed`. */
  fun write(data: ByteArray) {
    if (closeRequested.get()) throw IOException("enlace cerrado")
    try {
      writer.execute {
        try {
          val out = socket.outputStream
          out.write(data)
          out.flush()
        } catch (e: Throwable) {
          if (failure == null && !closeRequested.get()) failure = describe(e)
          closeSocket()
        }
      }
    } catch (e: RejectedExecutionException) {
      throw IOException("enlace cerrado")
    }
  }

  /** Idempotente. Lo ya encolado se escribe antes de cerrar. */
  fun close() {
    if (!closeRequested.compareAndSet(false, true)) return
    started.countDown() // si nadie empezó a leer, el hilo lector termina y emite onClosed
    var timeout: ScheduledFuture<*>? = null
    try {
      writer.execute {
        try {
          socket.outputStream.flush()
        } catch (_: Throwable) {
        }
        timeout?.cancel(false)
        closeSocket()
      }
      writer.shutdown()
      timeout = watchdog.schedule({ closeSocket() }, FLUSH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (_: Throwable) {
      closeSocket()
    }
  }

  /** Corte inmediato (módulo destruido). */
  fun abort() {
    closeRequested.set(true)
    started.countDown()
    closeSocket()
    writer.shutdownNow()
  }

  private fun closeSocket() {
    if (!socketClosed.compareAndSet(false, true)) return
    try {
      socket.close()
    } catch (_: Throwable) {
    }
  }

  private fun describe(e: Throwable): String = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
}
