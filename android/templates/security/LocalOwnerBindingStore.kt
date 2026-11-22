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

/** Keystore-authenticated, immutable binding for the local encrypted PMS profile. */
class LocalOwnerBindingStore(context: Context) {
    enum class Result { UNBOUND, MATCH, MISMATCH, CORRUPT }
    data class Binding(val uid: String, val ownerId: String)
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val alias = ALIAS
    private val lock = Any()

    /** Read the complete binding. Missing both fields is UNBOUND; partial or invalid state is CORRUPT. */
    fun read(): Binding? = synchronized(lock) {
        val nonceText = prefs.getString("nonce", null)
        val ciphertext = prefs.getString("ciphertext", null)
        if (nonceText == null && ciphertext == null) return null
        if (nonceText.isNullOrBlank() || ciphertext.isNullOrBlank()) throw SecurityException("Local owner binding is corrupt.")
        val nonce = try { Base64.decode(nonceText, Base64.NO_WRAP) } catch (e: Exception) { throw SecurityException("Local owner binding is corrupt.", e) }
        val sealed = try { Base64.decode(ciphertext, Base64.NO_WRAP) } catch (e: Exception) { nonce.fill(0); throw SecurityException("Local owner binding is corrupt.", e) }
        if (nonce.size != 12 || sealed.size < 16) { nonce.fill(0); sealed.fill(0); throw SecurityException("Local owner binding is corrupt.") }
        val plaintext = try { decrypt(nonce, sealed) } catch (e: Exception) { throw SecurityException("Local owner binding authentication failed.", e) }
        try {
            val value = JSONObject(String(plaintext, Charsets.UTF_8))
            val uid = value.optString("uid")
            val ownerId = value.optString("ownerId")
            if (uid.isBlank() || uid.length > 128 || ownerId.isBlank() || ownerId.length > 128) throw SecurityException("Local owner binding is corrupt.")
            Binding(uid, ownerId)
        } finally { nonce.fill(0); sealed.fill(0); plaintext.fill(0) }
    }

    fun ownerIdFor(uid: String): String = synchronized(lock) {
        require(uid.isNotBlank() && uid.length <= 128)
        val binding = read() ?: throw SecurityException("Local PMS profile is not bound to an authenticated owner.")
        if (binding.uid != uid) throw SecurityException("This local encrypted PMS profile is bound to a different Google owner.")
        binding.ownerId
    }

    fun checkUid(uid: String): Boolean = synchronized(lock) {
        if (uid.isBlank()) return false
        val binding = read() ?: return false
        binding.uid == uid
    }

    fun check(uid: String, ownerId: String): Result = synchronized(lock) {
        if (uid.isBlank() || ownerId.isBlank()) return Result.MISMATCH
        val binding = try { read() } catch (_: Exception) { return Result.CORRUPT }
        if (binding == null) Result.UNBOUND
        else if (binding.uid == uid && binding.ownerId == ownerId) Result.MATCH else Result.MISMATCH
    }

    /** Bind only after the caller has completed server-side owner membership verification. Never overwrite. */
    fun bindIfAbsent(uid: String, ownerId: String, allowExistingProfileAfterUnlock: Boolean = false): Result = synchronized(lock) {
        require(uid.isNotBlank() && uid.length <= 128 && ownerId.isNotBlank() && ownerId.length <= 128)
        when (check(uid, ownerId)) {
            Result.MATCH -> Result.MATCH
            Result.MISMATCH, Result.CORRUPT -> Result.MISMATCH
            Result.UNBOUND -> {
                // A missing preference is not permission to rebind an existing DB/envelope.
                val db = appContext.getDatabasePath("aurelia-pms-encrypted.db")
                val databaseExists = db.exists() || java.io.File(db.path + "-wal").exists() || java.io.File(db.path + "-shm").exists()
                if (!allowExistingProfileAfterUnlock && (databaseExists || AureliaEnvelopeStore(appContext).exists() || AureliaSecurityRuntime.isEnrolled())) return Result.MISMATCH
                val plaintext = JSONObject().put("uid", uid).put("ownerId", ownerId).toString().toByteArray(Charsets.UTF_8)
                try {
                    val (nonce, ciphertext) = encrypt(plaintext)
                    val committed = prefs.edit().putString("nonce", Base64.encodeToString(nonce, Base64.NO_WRAP))
                        .putString("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP)).commit()
                    nonce.fill(0); ciphertext.fill(0)
                    if (!committed) throw SecurityException("Local owner binding could not be persisted.")
                    val readBack = read()
                    if (readBack?.uid != uid || readBack.ownerId != ownerId) throw SecurityException("Local owner binding read-back verification failed.")
                    Result.MATCH
                } finally { plaintext.fill(0) }
            }
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        if (prefs.contains("ciphertext") || prefs.contains("nonce")) throw SecurityException("Binding Keystore key is missing; refusing regeneration.")
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun encrypt(value: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val nonce = cipher.iv ?: throw SecurityException("Keystore did not provide a GCM nonce.")
        return nonce to cipher.doFinal(value)
    }
    private fun decrypt(nonce: ByteArray, ciphertext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ciphertext)
    }

    companion object {
        private const val PREFS = "aurelia_local_owner_binding"
        private const val ALIAS = "aurelia_local_owner_binding_v1"
    }
}
