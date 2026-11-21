package com.aurelia.pms.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-local Keystore-encrypted binding between this local PMS profile and its cloud owner. */
class LocalOwnerBindingStore(context: Context) {
    enum class Result { UNBOUND, MATCH, MISMATCH }
    private val prefs = context.getSharedPreferences("aurelia_local_owner_binding", Context.MODE_PRIVATE)
    private val alias = "aurelia_local_owner_binding_v1"
    private val lock = Any()

    fun check(uid: String, ownerId: String): Result = synchronized(lock) {
        val ciphertext = prefs.getString("ciphertext", null) ?: return Result.UNBOUND
        val nonceText = prefs.getString("nonce", null) ?: throw SecurityException("Local owner binding is incomplete.")
        val plaintext = decrypt(Base64.decode(nonceText, Base64.NO_WRAP), Base64.decode(ciphertext, Base64.NO_WRAP))
        try {
            val value = JSONObject(String(plaintext, Charsets.UTF_8))
            if (value.optString("uid") == uid && value.optString("ownerId") == ownerId) Result.MATCH else Result.MISMATCH
        } finally { plaintext.fill(0) }
    }

    fun bindIfAbsent(uid: String, ownerId: String): Result = synchronized(lock) {
        when (check(uid, ownerId)) {
            Result.MATCH -> Result.MATCH
            Result.MISMATCH -> Result.MISMATCH
            Result.UNBOUND -> {
                val plaintext = JSONObject().put("uid", uid).put("ownerId", ownerId).toString().toByteArray(Charsets.UTF_8)
                try {
                    val (nonce, ciphertext) = encrypt(plaintext)
                    val committed = prefs.edit()
                        .putString("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP))
                        .putString("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                        .commit()
                    nonce.fill(0)
                    ciphertext.fill(0)
                    if (!committed) throw SecurityException("Local owner binding could not be persisted.")
                    Result.MATCH
                } finally { plaintext.fill(0) }
            }
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    private fun encrypt(value: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv to cipher.doFinal(value)
    }

    private fun decrypt(nonce: ByteArray, ciphertext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ciphertext)
    }
}
