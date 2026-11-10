package com.aurelia.pms.identity

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypted, installation-scoped namespace for local-only recovery records. */
object RecoveryTenantIdentity {
    private const val PREFS = "aurelia_recovery_tenant_v1"
    private const val BLOB = "encrypted_record"
    private const val ALIAS = "aurelia.pms.recovery-tenant.v1"
    private const val AAD = "AURELIA-RECOVERY-TENANT-V1"

    @Synchronized
    fun getOrCreate(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val blob = prefs.getString(BLOB, null)
        if (blob != null) return decrypt(blob)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        check(!store.containsAlias(ALIAS)) {
            "Recovery tenant record is missing; refusing to create a replacement namespace."
        }
        val tenant = "local_" + UUID.randomUUID().toString().replace("-", "")
        val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, nonce))
        cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
        val plain = tenant.toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        val packed = nonce + encrypted
        try {
            check(prefs.edit().putString(BLOB, Base64.encodeToString(packed, Base64.NO_WRAP)).commit())
        } finally {
            nonce.fill(0); encrypted.fill(0); packed.fill(0)
        }
        return tenant
    }

    private fun decrypt(blob: String): String {
        val packed = Base64.decode(blob, Base64.NO_WRAP)
        require(packed.size > 28)
        val nonce = packed.copyOfRange(0, 12)
        val encrypted = packed.copyOfRange(12, packed.size)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, nonce))
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(encrypted)
            try {
                val tenant = String(plain, Charsets.UTF_8)
                require(tenant.matches(Regex("^local_[a-f0-9]{32}$")))
                return tenant
            } finally { plain.fill(0) }
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
}
