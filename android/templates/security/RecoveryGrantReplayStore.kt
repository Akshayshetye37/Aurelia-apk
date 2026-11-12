package com.aurelia.pms.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keystore-encrypted, bounded local replay cache; server jti consumption remains authoritative. */
class RecoveryGrantReplayStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("aurelia_recovery_grant_v1", Context.MODE_PRIVATE)

    @Synchronized
    fun isUsed(jti: String, nowEpochSec: Long = System.currentTimeMillis() / 1000): Boolean {
        require(validJti(jti))
        return readEntries(nowEpochSec).any { it.first == jti }
    }

    @Synchronized
    fun markUsed(jti: String, expiresAtEpochSec: Long, nowEpochSec: Long = System.currentTimeMillis() / 1000): Boolean {
        require(validJti(jti))
        require(expiresAtEpochSec > nowEpochSec && expiresAtEpochSec - nowEpochSec <= 300)
        val entries = readEntries(nowEpochSec)
        if (entries.any { it.first == jti }) return false
        val array = JSONArray()
        (entries + (jti to expiresAtEpochSec)).takeLast(MAX_ENTRIES).forEach { (id, expiry) ->
            array.put(JSONObject().put("jti", id).put("exp", expiry))
        }
        write(array.toString())
        return true
    }

    private fun readEntries(now: Long): List<Pair<String, Long>> {
        val encoded = prefs.getString(BLOB, null) ?: return emptyList()
        val plain = decrypt(encoded)
        val entries = mutableListOf<Pair<String, Long>>()
        try {
            val array = JSONArray(plain)
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val id = item.optString("jti")
                val exp = item.optLong("exp", 0)
                if (validJti(id) && exp > now && exp - now <= 300) entries += id to exp
            }
        } finally { /* decrypted JSON contains only random grant identifiers and expiries */ }
        return entries
    }

    private fun write(value: String) {
        val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, nonce))
        cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
        val plain = value.toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        val packed = nonce + encrypted
        try {
            check(prefs.edit().putString(BLOB, Base64.encodeToString(packed, Base64.NO_WRAP)).commit())
        } finally { nonce.fill(0); encrypted.fill(0); packed.fill(0) }
    }

    private fun decrypt(encoded: String): String {
        val packed = Base64.decode(encoded, Base64.NO_WRAP)
        require(packed.size > 28)
        val nonce = packed.copyOfRange(0, 12)
        val encrypted = packed.copyOfRange(12, packed.size)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, nonce))
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(encrypted)
            try { return String(plain, Charsets.UTF_8) } finally { plain.fill(0) }
        } finally { nonce.fill(0); encrypted.fill(0); packed.fill(0) }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (prefs.contains(BLOB)) {
            throw SecurityException("Persisted recovery state exists but its Keystore key is missing; refusing key regeneration.")
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun validJti(value: String) = value.matches(Regex("^[0-9a-fA-F-]{36}$"))

    private companion object {
        const val ALIAS = "aurelia.pms.recovery-grant-replay.v1"
        const val BLOB = "used_jtis_v2"
        const val AAD = "AURELIA-RECOVERY-GRANT-REPLAY-V2"
        const val MAX_ENTRIES = 20
    }
}
