package com.aurelia.pms.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Hardware-backed device identity primitives for the LAN payment protocol.
 * No WebView/JavascriptInterface methods and no network requests are exposed.
 * Device-key possession is not provider verification or accounting approval.
 */
class PaymentDeviceKeyStore {
    companion object {
        const val ALIAS = "com.aurelia.pms.payment-device.p256.v1"
        private const val STORE = "AndroidKeyStore"
        private const val DOMAIN_ACTIVATE = "AURELIA_DEVICE_ACTIVATE_V1"
        private const val DOMAIN_REQUEST = "AURELIA_DEVICE_REQUEST_V1"
        private val URL_SAFE_FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    }

    @Synchronized
    fun hasIdentity(): Boolean = keyStore().containsAlias(ALIAS)

    @Synchronized
    fun ensureIdentity(): String {
        val store = keyStore()
        if (!store.containsAlias(ALIAS)) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
            generator.initialize(
                KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build()
            )
            generator.generateKeyPair()
        }
        val publicKey = store.getCertificate(ALIAS)?.publicKey
            ?: throw SecurityException("Payment device public key is unavailable.")
        require(publicKey.algorithm.equals("EC", ignoreCase = true)) {
            "Payment device key is not elliptic-curve."
        }
        return pem(publicKey.encoded)
    }

    /** Exact transcript required by /v1/admin/devices/:id/activate. */
    @Synchronized
    fun signActivation(
        deviceId: String,
        keyVersion: Long,
        challengeId: String,
        nonce: String,
        expiresAt: Long
    ): String {
        requireOpaque(deviceId, "deviceId")
        require(challengeId.matches(Regex("[0-9a-fA-F-]{36}"))) { "Invalid challenge ID." }
        require(nonce.matches(Regex("[A-Za-z0-9_-]{40,64}"))) { "Invalid challenge nonce." }
        require(keyVersion >= 0 && expiresAt > 0) { "Invalid activation metadata." }
        val transcript = listOf(
            DOMAIN_ACTIVATE, deviceId, keyVersion.toString(), challengeId, nonce, expiresAt.toString()
        ).joinToString("\n")
        return sign(transcript.toByteArray(Charsets.UTF_8))
    }

    /** bodyHash is SHA-256 of the backend-compatible canonical JSON body. */
    @Synchronized
    fun signRequest(
        deviceId: String,
        method: String,
        originalUrl: String,
        timestampSeconds: String,
        nonce: String,
        bodyHash: String
    ): String {
        requireOpaque(deviceId, "deviceId")
        require(method.matches(Regex("GET|POST|PUT|PATCH|DELETE"))) { "Invalid HTTP method." }
        require(originalUrl.startsWith("/") && !originalUrl.contains("\n") &&
            !originalUrl.contains("\r") && originalUrl.length <= 2048) { "Invalid request path." }
        require(timestampSeconds.matches(Regex("[0-9]{10}"))) { "Invalid request timestamp." }
        require(nonce.matches(Regex("[A-Za-z0-9_-]{16,128}"))) { "Invalid request nonce." }
        require(bodyHash.matches(Regex("[a-f0-9]{64}"))) { "Invalid request body hash." }
        val transcript = listOf(
            DOMAIN_REQUEST, deviceId, method, originalUrl, timestampSeconds, nonce, bodyHash
        ).joinToString("\n")
        return sign(transcript.toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun deleteIdentity() {
        val store = keyStore()
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
    }

    private fun sign(message: ByteArray): String {
        require(message.size in 1..8192) { "Signing transcript size is invalid." }
        val privateKey = keyStore().getKey(ALIAS, null) as? java.security.PrivateKey
            ?: throw SecurityException("Payment device identity is not enrolled on this device.")
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(privateKey)
        signer.update(message)
        return Base64.encodeToString(signer.sign(), URL_SAFE_FLAGS)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    private fun pem(der: ByteArray): String =
        "-----BEGIN PUBLIC KEY-----\n" +
            Base64.encodeToString(der, Base64.NO_WRAP) +
            "\n-----END PUBLIC KEY-----"

    private fun requireOpaque(value: String, label: String) {
        require(value.isNotBlank() && value.length <= 128 &&
            value.none { it.code < 0x20 || it.code == 0x7f }) { "Invalid $label." }
    }
}
