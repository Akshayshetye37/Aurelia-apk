package com.aurelia.pms.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keystore-authenticated local replay defense; server-side jti consumption remains authoritative. */
class RecoveryGrantReplayStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("aurelia_recovery_grant_v1", Context.MODE_PRIVATE)

    @Synchronized
    fun markUsed(jti: String): Boolean {
        require(jti.matches(Regex("^[0-9a-fA-F-]{36}$")))
        val previous = read()
        if (previous == jti) return false
        val nonce = ByteArray(12).also(java.security.SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, nonce))
        cipher.updateAAD(AAD)
        val encrypted = cipher.doFinal(jti.toByteArray(Charsets.UTF_8))
        val packed = nonce + encrypted
        try {
            check(prefs.edit().putString(BLOB, Base64.encodeToString(packed, Base64.NO_WRAP)).commit())
        } finally {
            nonce.fill(0); encrypted.fill(0); packed.fill(0)
        }
        return true
    }

    private fun read(): String? {
        val encoded = prefs.getString(BLOB, null) ?: return null
        val packed = Base64.decode(encoded, Base64.NO_WRAP)
        require(packed.size > 28)
        val nonce = packed.copyOfRange(0, 12)
        val encrypted = packed.copyOfRange(12, packed.size)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, nonce))
            cipher.updateAAD(AAD)
            return String(cipher.doFinal(encrypted), Charsets.UTF_8)
        } finally {
            nonce.fill(0); encrypted.fill(0); packed.fill(0)
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private companion object {
        const val ALIAS = "aurelia.pms.recovery-grant-replay.v1"
        const val BLOB = "last_jti"
        const val AAD = "AURELIA-RECOVERY-GRANT-REPLAY-V1"
    }
}
