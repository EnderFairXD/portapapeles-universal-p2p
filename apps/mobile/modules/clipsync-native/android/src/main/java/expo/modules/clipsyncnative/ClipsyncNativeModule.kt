package expo.modules.clipsyncnative

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import java.security.MessageDigest
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

    Function("base64Encode") { data: ByteArray -> Base64.encodeToString(data, Base64.NO_WRAP) }
    Function("base64Decode") { text: String -> Base64.decode(text, Base64.NO_WRAP) }
  }
}
