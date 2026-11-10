package com.aurelia.pms.identity

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypted local recovery-phone record. The E.164 number is never written in
 * plaintext to preferences, logs, backups or the Hotel Identity settings entity.
 * The Android Keystore AES key is deliberately non-authentication-bound so the
 * locked recovery screen can read the already-verified destination.
 */
class RecoveryPhoneStore(context: Context) {
    enum class State { UNSET, UNVERIFIED, VERIFIED, CHANGE_PENDING }

    data class Record(
        val state: State,
        val currentE164: String?,
        val pendingE164: String?,
        val effectiveAtEpochMs: Long,
        val otpRequired: Boolean
    ) {
        fun maskedCurrent(): String? = currentE164?.let(::mask)
    }

    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val random = SecureRandom()

    @Synchronized
    fun read(): Record {
        val blob = prefs.getString(BLOB, null) ?: run {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (store.containsAlias(KEY_ALIAS)) {
                throw SecurityException("Recovery phone record is missing; refusing to disable OTP policy.")
            }
            return Record(State.UNSET, null, null, 0L, true)
        }
        try {
            val packed = Base64.decode(blob, Base64.NO_WRAP)
            require(packed.size > NONCE_BYTES + TAG_BYTES) { "Invalid recovery phone record." }
            val nonce = packed.copyOfRange(0, NONCE_BYTES)
            val ciphertext = packed.copyOfRange(NONCE_BYTES, packed.size)
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, nonce))
                cipher.updateAAD(AAD)
                val json = JSONObject(String(cipher.doFinal(ciphertext), Charsets.UTF_8))
                val state = State.valueOf(json.getString("state"))
                val current = json.optString("currentE164").takeIf { it.isNotEmpty() }
                val pending = json.optString("pendingE164").takeIf { it.isNotEmpty() }
                require((state == State.UNSET) == (current == null) || state == State.UNVERIFIED) {
                    "Recovery phone state is inconsistent."
                }
                if (current != null) require(E164.matches(current))
                if (pending != null) require(E164.matches(pending))
                require(state == State.CHANGE_PENDING || pending == null)
                return Record(state, current, pending, json.optLong("effectiveAtEpochMs"), json.optBoolean("otpRequired", true))
            } finally {
                nonce.fill(0)
                ciphertext.fill(0)
                packed.fill(0)
            }
        } catch (failure: Exception) {
            throw SecurityException("Recovery phone record could not be authenticated; recovery is blocked.", failure)
        }
    }

    @Synchronized
    fun markUnverified(typedE164: String) {
        require(E164.matches(typedE164)) { "Phone number must be canonical E.164." }
        val old = read()
        // An edit to Hotel Identity never calls this method. This method is only
        // used by the explicit recovery-phone registration workflow.
        write(Record(if (old.currentE164 == null) State.UNVERIFIED else old.state,
            old.currentE164, old.pendingE164, old.effectiveAtEpochMs, old.otpRequired))
    }

    @Synchronized
    fun markVerified(e164: String) {
        require(E164.matches(e164)) { "Phone number must be canonical E.164." }
        val old = read()
        if (old.currentE164 != null && old.currentE164 != e164) {
            throw SecurityException("A verified recovery number can only be changed through the cooldown flow.")
        }
        write(Record(State.VERIFIED, e164, null, 0L, old.otpRequired))
    }

    @Synchronized
    fun requestChange(newE164: String, nowEpochMs: Long = System.currentTimeMillis()) {
        require(E164.matches(newE164)) { "Phone number must be canonical E.164." }
        val old = read()
        require(old.state == State.VERIFIED && old.currentE164 != null) {
            "A verified recovery number is required before requesting a change."
        }
        require(old.currentE164 != newE164) { "New recovery number is unchanged." }
        require(old.state != State.CHANGE_PENDING) { "A recovery-number change is already pending." }
        write(Record(State.CHANGE_PENDING, old.currentE164, newE164,
            nowEpochMs + CHANGE_COOLDOWN_MS, old.otpRequired))
    }

    @Synchronized
    fun cancelChange() {
        val old = read()
        require(old.state == State.CHANGE_PENDING && old.currentE164 != null)
        write(Record(State.VERIFIED, old.currentE164, null, 0L, old.otpRequired))
    }

    @Synchronized
    fun activatePending(nowEpochMs: Long = System.currentTimeMillis()) {
        val old = read()
        require(old.state == State.CHANGE_PENDING && old.pendingE164 != null)
        require(nowEpochMs >= old.effectiveAtEpochMs) { "Recovery phone change cooldown has not elapsed." }
        write(Record(State.VERIFIED, old.pendingE164, null, 0L, old.otpRequired))
    }

    fun requiresOtp(): Boolean {
        val record = read()
        return record.otpRequired && record.currentE164 != null &&
            (record.state == State.VERIFIED || record.state == State.CHANGE_PENDING)
    }

    private fun write(record: Record) {
        val json = JSONObject()
            .put("state", record.state.name)
            .put("currentE164", record.currentE164 ?: "")
            .put("pendingE164", record.pendingE164 ?: "")
            .put("effectiveAtEpochMs", record.effectiveAtEpochMs)
            .put("otpRequired", record.otpRequired)
            .toString()
        val nonce = ByteArray(NONCE_BYTES).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(AAD)
        val plaintext = json.toByteArray(Charsets.UTF_8)
        val encrypted = try {
            cipher.doFinal(plaintext)
        } finally {
            plaintext.fill(0)
        }
        val packed = nonce + encrypted
        try {
            check(prefs.edit().putString(BLOB, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
                "Could not persist recovery phone record."
            }
        } finally {
            nonce.fill(0)
            encrypted.fill(0)
            packed.fill(0)
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    private fun mask(value: String): String {
        val digits = value.filter(Char::isDigit)
        return "+" + digits.take(2) + " " + "•".repeat((digits.length - 5).coerceAtLeast(0)) + digits.takeLast(3)
    }

    private companion object {
        const val PREFS = "aurelia_recovery_phone_v1"
        const val BLOB = "encrypted_record"
        const val KEY_ALIAS = "aurelia.pms.recovery-phone.v1"
        const val AAD = "AURELIA-RECOVERY-PHONE-V1"
        const val NONCE_BYTES = 12
        const val TAG_BITS = 128
        const val TAG_BYTES = 16
        const val CHANGE_COOLDOWN_MS = 48L * 60L * 60L * 1000L
        val E164 = Regex("^\\+[1-9][0-9]{7,14}$")
    }
}
