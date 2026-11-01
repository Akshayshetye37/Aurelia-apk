package com.aurelia.pms.security

import android.util.Base64
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONObject
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * PIN key derivation and authenticated DEK envelope primitives.
 *
 * This class does not claim to protect a running process from a rooted device,
 * debugger, instrumentation framework, screenshots, or memory inspection.
 * Callers must keep PIN/key byte arrays short-lived and never cross the WebView bridge.
 */
class AureliaCryptoEngine(
    private val random: SecureRandom = SecureRandom()
) {
    companion object {
        const val VERSION = 2
        private const val KDF = "argon2id"
        private const val CIPHER = "AES-256-GCM"
        private const val MEMORY_KIB = 65_536
        private const val ITERATIONS = 3
        private const val PARALLELISM = 1
        private const val KEY_BYTES = 32
        private const val SALT_BYTES = 16
        private const val NONCE_BYTES = 12
        private const val TAG_BITS = 128
        private const val APP_ID = "com.aurelia.pms"
    }

    data class PinEnvelope(
        val json: String,
        val salt: ByteArray
    )

    fun validatePin(pin: CharArray) {
        require(pin.size in 6..12 && pin.all { it in '0'..'9' }) {
            "PIN must contain 6–12 digits."
        }
    }

    fun createSalt(): ByteArray = ByteArray(SALT_BYTES).also(random::nextBytes)

    /** Derive a KEK. The caller owns and must clear the returned key bytes. */
    fun derivePinKey(pin: CharArray, salt: ByteArray): ByteArray {
        validatePin(pin)
        require(salt.size == SALT_BYTES) { "Invalid KDF salt." }
        val password = Charsets.UTF_8.encode(java.nio.CharBuffer.wrap(pin))
        val passwordBytes = ByteArray(password.remaining()).also(password::get)
        val output = ByteArray(KEY_BYTES)
        try {
            val parameters = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                .withIterations(ITERATIONS)
                .withMemoryAsKB(MEMORY_KIB)
                .withParallelism(PARALLELISM)
                .withSalt(salt)
                .build()
            Argon2BytesGenerator().apply { init(parameters) }.generateBytes(passwordBytes, output)
            return output
        } catch (failure: Throwable) {
            output.fill(0)
            throw failure
        } finally {
            passwordBytes.fill(0)
        }
    }

    /** Wraps a random 256-bit DEK under a PIN-derived KEK. */
    fun wrapDataKey(dataKey: ByteArray, pin: CharArray): PinEnvelope {
        require(dataKey.size == KEY_BYTES) { "Data key must be 256 bits." }
        val salt = createSalt()
        val kekBytes = derivePinKey(pin, salt)
        try {
            val nonce = ByteArray(NONCE_BYTES).also(random::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(kekBytes, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(aad(salt))
            val wrapped = cipher.doFinal(dataKey)
            val json = JSONObject()
                .put("version", VERSION)
                .put("kdf", KDF)
                .put("kdfVersion", 19)
                .put("memoryKiB", MEMORY_KIB)
                .put("iterations", ITERATIONS)
                .put("parallelism", PARALLELISM)
                .put("cipher", CIPHER)
                .put("salt", b64(salt))
                .put("nonce", b64(nonce))
                .put("wrappedKey", b64(wrapped))
                .toString()
            return PinEnvelope(json, salt.copyOf())
        } finally {
            kekBytes.fill(0)
        }
    }

    /** Authenticates metadata and unwraps the DEK. Wrong PIN/tampering throws. */
    fun unwrapDataKey(envelopeJson: String, pin: CharArray): ByteArray {
        validatePin(pin)
        require(envelopeJson.toByteArray(Charsets.UTF_8).size <= 4096) { "Envelope too large." }
        val json = JSONObject(envelopeJson)
        require(json.length() == 10) { "Unexpected envelope fields." }
        require(json.getInt("version") == VERSION) { "Unsupported envelope version." }
        require(json.getString("kdf") == KDF && json.getInt("kdfVersion") == 19) { "Unsupported KDF." }
        require(json.getInt("memoryKiB") == MEMORY_KIB &&
            json.getInt("iterations") == ITERATIONS &&
            json.getInt("parallelism") == PARALLELISM) { "Unapproved KDF parameters." }
        require(json.getString("cipher") == CIPHER) { "Unsupported cipher." }
        val salt = decode(json.getString("salt"), SALT_BYTES)
        val nonce = decode(json.getString("nonce"), NONCE_BYTES)
        val wrapped = Base64.decode(json.getString("wrappedKey"), Base64.NO_WRAP)
        require(wrapped.size == KEY_BYTES + TAG_BITS / 8) { "Invalid wrapped key length." }
        val kekBytes = derivePinKey(pin, salt)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(kekBytes, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(aad(salt))
            return cipher.doFinal(wrapped)
        } catch (badTag: AEADBadTagException) {
            throw SecurityException("PIN or envelope authentication failed.", badTag)
        } finally {
            kekBytes.fill(0)
            salt.fill(0)
            nonce.fill(0)
            wrapped.fill(0)
        }
    }

    private fun aad(salt: ByteArray): ByteArray =
        "$APP_ID|$VERSION|$KDF|$CIPHER|".toByteArray(Charsets.UTF_8) + salt

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(value: String, expected: Int): ByteArray {
        require(value.length <= 128) { "Encoded field too large." }
        val decoded = Base64.decode(value, Base64.NO_WRAP)
        require(decoded.size == expected) { "Invalid encoded field length." }
        return decoded
    }
}
