package com.aurelia.pms.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.cert.X509Certificate

/** Native Keystore identity. No WebView interface or network transport is exposed.\n * Device-key possession is not provider verification or accounting approval.\n */
class PaymentDeviceKeyStore {
    data class AttestedIdentity(
        val keyAlias: String,
        val publicKeyPem: String,
        val certificateChainBase64: List<String>,
        val securityLevel: String
    )

    companion object {
        const val ALIAS = "com.aurelia.pms.payment-device.p256.v1"
        const val ATTESTED_ALIAS = "com.aurelia.pms.payment-device.attested.p256.v1"
        private const val STORE = "AndroidKeyStore"
        private const val DOMAIN_REQUEST = "AURELIA_DEVICE_REQUEST_V1"
        private val URL_SAFE_FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    }

    @Synchronized
    fun hasIdentity(): Boolean = keyStore().let {
        it.containsAlias(ATTESTED_ALIAS) || it.containsAlias(ALIAS)
    }

    /** Payment-device network access requires the challenge-attested alias. */
    @Synchronized
    fun hasAttestedIdentity(): Boolean = keyStore().containsAlias(ATTESTED_ALIAS)

    /**
     * Creates a fresh challenge-bound key. StrongBox is preferred; TEE is the
     * only fallback. The appliance MUST independently verify the returned chain.
     * The legacy active key is retained until enrollment/activation succeeds.
     */
    @Synchronized
    fun createAttestedIdentity(serverChallenge: ByteArray): AttestedIdentity {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw SecurityException("Android Key Attestation requires Android 9 or later.")
        }
        require(serverChallenge.size in 16..128) { "Attestation challenge must be 16–128 bytes." }
        val store = keyStore()
        // Never destroy an existing enrolled key while attempting rotation. Android
        // Keystore does not support renaming private-key aliases, so replacing the
        // active alias here would create an avoidable identity-loss window. Rotation
        // requires an explicit owner-controlled revoke/reset workflow.
        if (store.containsAlias(ATTESTED_ALIAS)) {
            throw SecurityException("An attested identity already exists; revoke it explicitly before reenrollment.")
        }

        // The alias was absent above, so any alias present after an exception belongs
        // to this failed enrollment attempt and is safe to remove. Without this outer
        // cleanup, a provider/TEE or certificate-read failure can leave a poisoned
        // alias that permanently blocks a later enrollment attempt.
        try {
            fun generate(preferStrongBox: Boolean) {
                val builder = KeyGenParameterSpec.Builder(
                    ATTESTED_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .setAttestationChallenge(serverChallenge.clone())
                if (preferStrongBox) builder.setIsStrongBoxBacked(true)
                KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply {
                    initialize(builder.build())
                    generateKeyPair()
                }
                store.load(null)
            }

            try {
                generate(true)
            } catch (_: StrongBoxUnavailableException) {
                if (store.containsAlias(ATTESTED_ALIAS)) store.deleteEntry(ATTESTED_ALIAS)
                generate(false)
            }

            val privateKey = store.getKey(ATTESTED_ALIAS, null) as? PrivateKey
                ?: throw SecurityException("Attested private key is unavailable.")
            val publicKey = store.getCertificate(ATTESTED_ALIAS)?.publicKey
                ?: throw SecurityException("Attested public key is unavailable.")
            val info = KeyFactory.getInstance(privateKey.algorithm, STORE)
                .getKeySpec(privateKey, KeyInfo::class.java)
            val level = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                when (info.securityLevel) {
                    KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
                    KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TRUSTED_ENVIRONMENT"
                    else -> throw SecurityException("Software-backed payment device keys are rejected.")
                }
            } else {
                if (!info.isInsideSecureHardware) {
                    throw SecurityException("Software-backed payment device keys are rejected.")
                }
                "HARDWARE_BACKED_UNCLASSIFIED"
            }

            val chain = store.getCertificateChain(ATTESTED_ALIAS)
                ?.map { it as? X509Certificate
                    ?: throw SecurityException("Attestation chain contains a non-X.509 certificate.") }
                ?: emptyList()
            if (chain.isEmpty() || !chain.first().publicKey.encoded.contentEquals(publicKey.encoded)) {
                throw SecurityException("Attestation chain is missing or does not bind the generated key.")
            }
            return AttestedIdentity(
                ATTESTED_ALIAS,
                pem(publicKey.encoded),
                chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) },
                level
            )
        } catch (error: Exception) {
            try {
                if (store.containsAlias(ATTESTED_ALIAS)) store.deleteEntry(ATTESTED_ALIAS)
            } catch (_: Exception) {
                // Preserve the original enrollment failure. The caller must still
                // fail closed and require an owner-controlled reset if cleanup fails.
            }
            throw error
        }
    }

    @Synchronized
    fun ensureIdentity(): String {
        val store = keyStore()
        if (!store.containsAlias(ATTESTED_ALIAS) && !store.containsAlias(ALIAS)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply {
                initialize(
                    KeyGenParameterSpec.Builder(
                        ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                    )
                        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setUserAuthenticationRequired(false)
                        .build()
                )
                generateKeyPair()
            }
            store.load(null)
        }
        val alias = if (store.containsAlias(ATTESTED_ALIAS)) ATTESTED_ALIAS else ALIAS
        val publicKey = store.getCertificate(alias)?.publicKey
            ?: throw SecurityException("Payment device public key is unavailable.")
        require(publicKey.algorithm.equals("EC", ignoreCase = true)) {
            "Payment device key is not elliptic-curve."
        }
        return pem(publicKey.encoded)
    }

    /** bodyHash is SHA-256 of the backend-compatible canonical JSON body. */
    @Synchronized
    fun signRequest(
        deviceId: String, method: String, originalUrl: String, timestampSeconds: String,
        nonce: String, bodyHash: String
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
        if (store.containsAlias(ATTESTED_ALIAS)) store.deleteEntry(ATTESTED_ALIAS)
    }

    private fun sign(message: ByteArray): String {
        require(message.size in 1..8192) { "Signing transcript size is invalid." }
        val store = keyStore()
        val alias = if (store.containsAlias(ATTESTED_ALIAS)) ATTESTED_ALIAS else ALIAS
        val privateKey = store.getKey(alias, null) as? PrivateKey
            ?: throw SecurityException("Payment device identity is not enrolled on this device.")
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(message)
            return Base64.encodeToString(sign(), URL_SAFE_FLAGS)
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    private fun pem(der: ByteArray): String =
        "-----BEGIN PUBLIC KEY-----\n" + Base64.encodeToString(der, Base64.NO_WRAP) +
            "\n-----END PUBLIC KEY-----"

    private fun requireOpaque(value: String, label: String) {
        require(value.isNotBlank() && value.length <= 128 &&
            value.none { it.code < 0x20 || it.code == 0x7f }) { "Invalid $label." }
    }
}
