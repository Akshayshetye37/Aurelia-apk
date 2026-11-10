package com.aurelia.pms.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONObject
import java.nio.CharBuffer
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * PIN key derivation and authenticated DEK envelope primitives.
 *
 * Version 3 combines Argon2id output with a non-exportable Android Keystore
 * HMAC secret using HKDF. Version 2 envelopes remain readable for migration;
 * new envelopes bind method and database identity into AES-GCM AAD.
 */
class AureliaCryptoEngine(
    private val random: SecureRandom = SecureRandom()
) {
    companion object {
        const val VERSION = 3
        private const val LEGACY_VERSION = 2
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
        private const val DATABASE_ID = "aurelia-pms-encrypted.db"
        private const val PIN_KEK_ALIAS = "aurelia.pms.pin-kek.v1"
        private const val PIN_HKDF_INFO = "Aurelia PMS PIN KEK v1"
    }

    data class PinEnvelope(
        val json: String,
        val salt: ByteArray
    )

    fun validatePin(pin: CharArray) {
        require(pin.size in 4..16 && pin.all { it in '0'..'9' }) {
            "PIN must contain 4–16 digits."
        }
    }

    fun createSalt(): ByteArray = ByteArray(SALT_BYTES).also(random::nextBytes)

    /** Argon2id stage shared by current and legacy envelope readers. */
    private fun deriveArgon2Key(pin: CharArray, salt: ByteArray): ByteArray {
        validatePin(pin)
        require(salt.size == SALT_BYTES) { "Invalid KDF salt." }
        val password = Charsets.UTF_8.encode(CharBuffer.wrap(pin))
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

    /**
     * HKDF-Extract uses the device-bound Keystore HMAC key as salt; HKDF-Expand
     * binds the output to this application/PIN purpose. The Keystore key is
     * never exported, so a copied envelope cannot be brute-forced offline.
     */
    fun derivePinKey(pin: CharArray, salt: ByteArray): ByteArray {
        val argon2Key = deriveArgon2Key(pin, salt)
        try {
            val extract = Mac.getInstance("HmacSHA256")
            extract.init(pinKekSecret())
            val pseudorandomKey = extract.doFinal(argon2Key)
            try {
                val expand = Mac.getInstance("HmacSHA256")
                expand.init(SecretKeySpec(pseudorandomKey, "HmacSHA256"))
                expand.update(PIN_HKDF_INFO.toByteArray(Charsets.UTF_8))
                expand.update(1.toByte())
                return expand.doFinal().copyOf(KEY_BYTES)
            } finally {
                pseudorandomKey.fill(0)
            }
        } finally {
            argon2Key.fill(0)
        }
    }

    /** Version-2 compatibility path only. Never use this to create new envelopes. */
    private fun deriveLegacyPinKey(pin: CharArray, salt: ByteArray): ByteArray =
        deriveArgon2Key(pin, salt)

    private fun pinKekSecret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(PIN_KEK_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                PIN_KEK_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            ).setKeySize(256)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        return generator.generateKey()
    }

    /** Wraps a random 256-bit DEK under the device-bound PIN KEK. */
    fun wrapDataKey(dataKey: ByteArray, pin: CharArray): PinEnvelope {
        require(dataKey.size == KEY_BYTES) { "Data key must be 256 bits." }
        val salt = createSalt()
        val kekBytes = derivePinKey(pin, salt)
        try {
            val nonce = ByteArray(NONCE_BYTES).also(random::nextBytes)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(kekBytes, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(aad(VERSION, "PIN", DATABASE_ID, salt))
            val wrapped = cipher.doFinal(dataKey)
            try {
                val json = JSONObject()
                    .put("version", VERSION)
                    .put("method", "PIN")
                    .put("databaseId", DATABASE_ID)
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
                nonce.fill(0)
                wrapped.fill(0)
            }
        } finally {
            kekBytes.fill(0)
            salt.fill(0)
        }
    }

    /** Authenticates metadata and unwraps the DEK. Wrong PIN/tampering throws. */
    fun unwrapDataKey(envelopeJson: String, pin: CharArray): ByteArray {
        validatePin(pin)
        require(envelopeJson.toByteArray(Charsets.UTF_8).size <= 4096) { "Envelope too large." }
        val json = JSONObject(envelopeJson)
        val version = json.getInt("version")
        val legacy = version == LEGACY_VERSION
        require(legacy || version == VERSION) { "Unsupported envelope version." }
        require(json.length() == (if (legacy) 10 else 12)) { "Unexpected envelope fields." }
        if (!legacy) {
            require(json.getString("method") == "PIN" && json.getString("databaseId") == DATABASE_ID) {
                "Envelope method or database binding is invalid."
            }
        }
        require(json.getString("kdf") == KDF && json.getInt("kdfVersion") == 19) { "Unsupported KDF." }
        require(json.getInt("memoryKiB") == MEMORY_KIB &&
            json.getInt("iterations") == ITERATIONS &&
            json.getInt("parallelism") == PARALLELISM) { "Unapproved KDF parameters." }
        require(json.getString("cipher") == CIPHER) { "Unsupported cipher." }
        val salt = decode(json.getString("salt"), SALT_BYTES)
        val nonce = decode(json.getString("nonce"), NONCE_BYTES)
        val wrapped = Base64.decode(json.getString("wrappedKey"), Base64.NO_WRAP)
        require(wrapped.size == KEY_BYTES + TAG_BITS / 8) { "Invalid wrapped key length." }
        val kekBytes = if (legacy) deriveLegacyPinKey(pin, salt) else derivePinKey(pin, salt)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(kekBytes, "AES"), GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(if (legacy) legacyAad(salt) else aad(version, "PIN", DATABASE_ID, salt))
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

    private fun legacyAad(salt: ByteArray): ByteArray =
        "$APP_ID|$LEGACY_VERSION|$KDF|$CIPHER|".toByteArray(Charsets.UTF_8) + salt

    private fun aad(version: Int, method: String, databaseId: String, salt: ByteArray): ByteArray =
        "$APP_ID|$version|$method|$databaseId|$KDF|$CIPHER|".toByteArray(Charsets.UTF_8) + salt

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(value: String, expected: Int): ByteArray {
        require(value.length <= 128) { "Encoded field too large." }
        val decoded = Base64.decode(value, Base64.NO_WRAP)
        require(decoded.size == expected) { "Invalid encoded field length." }
        return decoded
    }
}
