package com.aurelia.pms.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.cert.Certificate
import java.util.Base64

/** Recovery device identity is created only with a server challenge and hardware attestation. */
object RecoveryDeviceIdentity {
    private const val ALIAS = "aurelia.pms.recovery-device-binding.v2"

    data class AttestedIdentity(
        val deviceIdHash: String,
        val certificateChainBase64: List<String>
    )

    @Synchronized
    fun deviceIdHash(): String {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(ALIAS)) {
            throw SecurityException("Hardware-attested recovery device enrollment is required.")
        }
        val publicKey = store.getCertificate(ALIAS)?.publicKey as? ECPublicKey
            ?: throw SecurityException("Recovery device binding key is unavailable.")
        return hash(publicKey.encoded)
    }

    @Synchronized
    fun deviceIdHashOrNull(): String? {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(ALIAS)) return null
        val publicKey = store.getCertificate(ALIAS)?.publicKey as? ECPublicKey
            ?: throw SecurityException("Recovery device binding key is unavailable.")
        return hash(publicKey.encoded)
    }

    @Synchronized
    fun createAttestedIdentity(challenge: ByteArray): AttestedIdentity {
        require(challenge.size in 16..128) { "Server attestation challenge length is invalid." }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        // The caller reaches this method only after the authenticated server
        // returned a fresh challenge because this key has no trusted attestation record.
        // Replacing an unregistered key is therefore safe; registered keys are returned
        // by createRecoveryAttestationChallenge as verified and never reach this path.
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)

        fun generate(strongBox: Boolean) {
            val generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore")
            val builder = KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            ).setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(challenge)
            if (strongBox && Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(true)
            generator.initialize(builder.build())
            generator.generateKeyPair()
        }

        try {
            if (Build.VERSION.SDK_INT >= 28) {
                try {
                    generate(true)
                } catch (_: StrongBoxUnavailableException) {
                    runCatching { store.deleteEntry(ALIAS) }
                    generate(false) // TEE is accepted; software-backed keys are rejected server-side.
                }
            } else {
                generate(false)
            }

            val chain: Array<Certificate> = store.getCertificateChain(ALIAS)
                ?: throw SecurityException("Android hardware attestation certificate chain is unavailable.")
            if (chain.size !in 2..8) throw SecurityException("Android hardware attestation chain is incomplete.")
            val publicKey = chain.first().publicKey as? ECPublicKey
                ?: throw SecurityException("Attested device key is not P-256 EC.")
            val encodedChain = chain.map { Base64.getEncoder().encodeToString(it.encoded) }
            AttestedIdentity(hash(publicKey.encoded), encodedChain)
        } catch (failure: Exception) {
            // Do not leave a key that cannot be enrolled and later mistaken for trusted.
            runCatching { store.deleteEntry(ALIAS) }
            throw failure
        }
    }

    private fun hash(spki: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(spki)
            .joinToString("") { "%02x".format(it) }
}
