package expo.modules.clipsyncnative

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

// ChaCha20-Poly1305 (Conscrypt, Android 9+), SHA-256 y base64 nativos: en Hermes, con @noble y el
// Buffer de react-native-tcp-socket, cada trozo de 48 KiB costaba ~100 ms. El JS los compara con
// @noble antes de usarlos (setCryptoBackend) y vuelve a @noble si algo no cuadra.

private const val CHACHA = "ChaCha20/Poly1305/NoPadding"

class Sha256Hasher : SharedObject() {
  val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
}

class ClipsyncNativeModule : Module() {
  // --- Bluetooth RFCOMM (cliente, solo dispositivos ya emparejados: sin escaneo ni BLUETOOTH_SCAN) ---
  private val connections = ConcurrentHashMap<Int, RfcommConnection>()
  private val nextId = AtomicInteger(1)
  private val watchdog = Executors.newScheduledThreadPool(1) { r ->
    Thread(r, "clipsync-rfcomm-watchdog").apply { isDaemon = true }
  }

  private fun adapter(): BluetoothAdapter? {
    val context = appContext.reactContext ?: return null
    return (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
  }

  /** En Android 12+ hace falta BLUETOOTH_CONNECT en tiempo de ejecución; antes basta el manifiesto. */
  private fun hasConnectPermission(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val context = appContext.reactContext ?: return false
    return context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
  }

  // Un Cipher nuevo en cada llamada: Conscrypt rechaza reiniciar uno con la misma clave y nonce.
  private fun chacha(mode: Int, key: ByteArray, nonce: ByteArray, ad: ByteArray): Cipher =
    Cipher.getInstance(CHACHA).apply {
      init(mode, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
      if (ad.isNotEmpty()) updateAAD(ad)
    }

  override fun definition() = ModuleDefinition {
    Name("ClipsyncNative")

    // texto cifrado ‖ etiqueta de 16 bytes, como RFC 8439 y @noble
    Function("chachaSeal") { key: ByteArray, nonce: ByteArray, ad: ByteArray, plaintext: ByteArray ->
      chacha(Cipher.ENCRYPT_MODE, key, nonce, ad).doFinal(plaintext)
    }

    // lanza (AEADBadTagException) si la etiqueta no autentica
    Function("chachaOpen") { key: ByteArray, nonce: ByteArray, ad: ByteArray, ciphertext: ByteArray ->
      chacha(Cipher.DECRYPT_MODE, key, nonce, ad).doFinal(ciphertext)
    }

    Class(Sha256Hasher::class) {
      Constructor { -> Sha256Hasher() }
      Function("update") { hasher: Sha256Hasher, data: ByteArray -> hasher.digest.update(data) }
      Function("digest") { hasher: Sha256Hasher -> hasher.digest.digest() }
    }

    Events("onData", "onClosed")

    OnDestroy {
      connections.values.forEach { it.abort() }
      connections.clear()
      watchdog.shutdownNow()
    }

    // 'unavailable' (sin adaptador), 'off' o 'on'
    Function("bluetoothState") {
      val a = adapter()
      if (a == null) "unavailable" else if (a.isEnabled) "on" else "off"
    }

    // Dispositivos ya emparejados en el sistema: [{name, address}] con la dirección en mayúsculas.
    @SuppressLint("MissingPermission")
    Function("bondedDevices") {
      if (!hasConnectPermission()) throw IOException("Falta el permiso BLUETOOTH_CONNECT")
      val a = adapter() ?: throw IOException("Este móvil no tiene Bluetooth")
      a.bondedDevices.orEmpty().map { mapOf("name" to (it.name ?: ""), "address" to it.address.uppercase()) }
    }

    // Abre un socket RFCOMM al servicio `uuid` del dispositivo emparejado y devuelve su id. Si no
    // conecta en `timeoutMs`, se cierra el socket y se rechaza. La lectura espera a startReading(id).
    @SuppressLint("MissingPermission")
    AsyncFunction("connect") { address: String, uuid: String, timeoutMs: Int, promise: Promise ->
      Thread({
        var socket: BluetoothSocket? = null
        val timedOut = AtomicBoolean(false)
        try {
          if (!hasConnectPermission()) {
            promise.reject("ERR_BT_PERMISSION", "Falta el permiso BLUETOOTH_CONNECT", null)
            return@Thread
          }
          val a = adapter()
          if (a == null || !a.isEnabled) {
            promise.reject("ERR_BT_OFF", "Bluetooth apagado", null)
            return@Thread
          }
          val addr = address.uppercase()
          if (!BluetoothAdapter.checkBluetoothAddress(addr)) {
            promise.reject("ERR_BT_ADDRESS", "Dirección Bluetooth no válida", null)
            return@Thread
          }
          val s = a.getRemoteDevice(addr).createRfcommSocketToServiceRecord(UUID.fromString(uuid))
          socket = s
          // connect() no tiene plazo propio: cerrar el socket desde otro hilo lo interrumpe
          val timer = watchdog.schedule({
            timedOut.set(true)
            try { s.close() } catch (_: Throwable) {}
          }, timeoutMs.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
          try {
            s.connect()
          } finally {
            timer.cancel(false)
          }
          if (timedOut.get()) throw IOException("Tiempo de conexión agotado")
          val id = nextId.getAndIncrement()
          connections[id] = RfcommConnection(
            id, s, watchdog,
            emitData = { cid, b64 -> sendEvent("onData", mapOf("id" to cid, "base64" to b64)) },
            emitClosed = { cid, err ->
              connections.remove(cid)
              sendEvent("onClosed", if (err == null) mapOf("id" to cid) else mapOf("id" to cid, "error" to err))
            },
          )
          promise.resolve(id)
        } catch (e: Throwable) {
          try { socket?.close() } catch (_: Throwable) {}
          val message = if (timedOut.get()) "Tiempo de conexión agotado" else e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
          promise.reject("ERR_BT_CONNECT", message, e)
        }
      }, "clipsync-rfcomm-connect").apply { isDaemon = true }.start()
    }

    // JS ya tiene sus manejadores: el hilo lector puede empezar a emitir onData.
    Function("startReading") { id: Int -> connections[id]?.startReading() }

    // Encola la escritura (base64) y vuelve. Un fallo llega como onClosed {id, error}.
    Function("write") { id: Int, base64: String ->
      val c = connections[id] ?: throw IOException("enlace cerrado")
      c.write(Base64.decode(base64, Base64.NO_WRAP))
    }

    // Idempotente: vacía lo pendiente y cierra; después llega onClosed {id}.
    Function("close") { id: Int -> connections[id]?.close() }

    Function("base64Encode") { data: ByteArray -> Base64.encodeToString(data, Base64.NO_WRAP) }
    Function("base64Decode") { text: String -> Base64.decode(text, Base64.NO_WRAP) }
  }
}
