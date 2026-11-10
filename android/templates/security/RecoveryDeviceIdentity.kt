package com.aurelia.pms.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey

/** Stable app-scoped device binding derived from a non-exportable Keystore EC key. */
object RecoveryDeviceIdentity {
    private const val ALIAS = "aurelia.pms.recovery-device-binding.v1"

    @Synchronized
    fun deviceIdHash(): String {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(ALIAS)) {
            val generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            ).setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build())
            generator.generateKeyPair()
        }
        val publicKey = store.getCertificate(ALIAS)?.publicKey as? ECPublicKey
            ?: throw SecurityException("Recovery device binding key is unavailable.")
        return MessageDigest.getInstance("SHA-256").digest(publicKey.encoded)
            .joinToString("") { "%02x".format(it) }
    }
}
