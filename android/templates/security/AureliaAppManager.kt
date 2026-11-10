package com.aurelia.pms.security

import android.content.Context
import android.os.SystemClock
import java.security.SecureRandom
import org.json.JSONObject

/**
 * Process-scoped security coordinator. A new process always starts unauthenticated.
 * Integration must gate MainActivity/WebView creation before BridgeActivity.onCreate.
 */
class AureliaAppManager(
    private val crypto: AureliaCryptoEngine,
    private val lockout: AppLockManager,
    private val context: Context,
    private val random: SecureRandom = SecureRandom(),
    private val sessionTimeoutMs: Long = 5 * 60 * 1000L
) {
    @Volatile private var authenticated = false
    @Volatile private var backgroundAtElapsed = 0L
    @Volatile private var dataKey: ByteArray? = null
    private val recoveryLockout by lazy {
        AppLockManager(context, "aurelia-recovery-lock-state.v1", "aurelia.pms.recovery-lock-state.v1", "AURELIA-RECOVERY-LOCK-V1")
    }

    data class Enrollment(val envelopeJson: String, val recoveryKey: CharArray, val biometricKeyRequired: Boolean = false)

    /** Generates a fresh DEK and wraps it under the new PIN. Caller persists the envelope atomically. */
    @Synchronized
    fun enroll(pin: CharArray): Enrollment {
        lockout.assertUnlocked()
        val database = context.getDatabasePath("aurelia-pms-encrypted.db")
        val databaseExists = database.exists() || java.io.File(database.path + "-wal").exists() || java.io.File(database.path + "-shm").exists()
        if (databaseExists || AureliaEnvelopeStore(context).exists() || AureliaSecurityRuntime.isEnrolled()) {
            throw SecurityException("Existing PMS database or enrollment material detected; refusing DEK regeneration.")
        }
        val dek = ByteArray(32).also(random::nextBytes)
        val recoveryKey = crypto.createRecoveryKey()
        return try {
            val pinEnvelope = crypto.wrapDataKey(dek, pin)
            val recoveryEnvelope = crypto.wrapDataKeyWithRecovery(dek, recoveryKey)
            val bundle = JSONObject()
                .put("bundleVersion", 1)
                .put("pin", pinEnvelope.json)
                .put("recovery", recoveryEnvelope)
                .toString()
            dataKey?.fill(0)
            dataKey = dek.copyOf()
            authenticated = true
            lockout.registerSuccess()
            Enrollment(bundle, crypto.encodeRecoveryKey(recoveryKey))
        } finally {
            dek.fill(0)
            recoveryKey.fill(0)
        }
    }

    /** Unlocks only when the envelope authenticates and yields a 256-bit DEK. */
    /** Accepts a DEK only after a BiometricPrompt CryptoObject authenticated its wrapper. */
    @Synchronized
    fun unlockWithDataKey(unwrappedDataKey: ByteArray): Boolean {
        require(unwrappedDataKey.size == 32) { "Invalid biometric DEK." }
        dataKey?.fill(0)
        dataKey = unwrappedDataKey.copyOf()
        authenticated = true
        backgroundAtElapsed = 0L
        lockout.registerSuccess()
        return true
    }

    @Synchronized
    fun unlock(pin: CharArray, envelopeJson: String): Boolean {
        lockout.assertUnlocked()
        val recovered = try {
            crypto.unwrapDataKey(pinEnvelope(envelopeJson), pin)
        } catch (failure: Exception) {
            lockout.registerFailure()
            return false
        }
        if (recovered.size != 32) {
            recovered.fill(0)
            lockout.registerFailure()
            return false
        }
        dataKey?.fill(0)
        dataKey = recovered
        authenticated = true
        backgroundAtElapsed = 0L
        lockout.registerSuccess()
        return true
    }

    /** PIN rotation re-wraps the same DEK; backup ciphertext is not re-encrypted. */
    @Synchronized
    fun changePin(currentPin: CharArray, newPin: CharArray, currentEnvelope: String): String {
        lockout.assertUnlocked()
        val dek = try {
            crypto.unwrapDataKey(pinEnvelope(currentEnvelope), currentPin)
        } catch (failure: Exception) {
            lockout.registerFailure()
            throw SecurityException("Current PIN verification failed.", failure)
        }
        try {
            require(dek.size == 32)
            val replacement = crypto.wrapDataKey(dek, newPin)
            val parsed = JSONObject(currentEnvelope)
            if (parsed.has("pin")) {
                parsed.put("pin", replacement.json)
                return parsed.toString()
            }
            return replacement.json
        } finally {
            dek.fill(0)
        }
    }

    /** Adds a recovery wrapper to a legacy PIN-only envelope without changing the DEK. */
    @Synchronized
    fun enableRecoveryKey(pin: CharArray, currentEnvelope: String): Enrollment {
        lockout.assertUnlocked()
        val dek = try {
            crypto.unwrapDataKey(pinEnvelope(currentEnvelope), pin)
        } catch (failure: Exception) {
            lockout.registerFailure()
            throw SecurityException("PIN verification failed while enabling recovery.", failure)
        }
        val recoveryKey = crypto.createRecoveryKey()
        try {
            require(dek.size == 32)
            val bundle = JSONObject()
                .put("bundleVersion", 1)
                .put("pin", crypto.wrapDataKey(dek, pin).json)
                .put("recovery", crypto.wrapDataKeyWithRecovery(dek, recoveryKey))
                .toString()
            dataKey?.fill(0)
            dataKey = dek.copyOf()
            authenticated = true
            backgroundAtElapsed = 0L
            lockout.registerSuccess()
            return Enrollment(bundle, crypto.encodeRecoveryKey(recoveryKey))
        } finally {
            dek.fill(0)
            recoveryKey.fill(0)
        }
    }

    /** Recovers the same DEK from the one-time 256-bit recovery key and rotates only the PIN wrapper. */
    @Synchronized
    fun recoverWithRecoveryKey(recoveryCode: CharArray, newPin: CharArray, envelopeBundle: String): String {
        recoveryLockout.assertUnlocked()
        crypto.validatePin(newPin)
        val bundle = JSONObject(envelopeBundle)
        require(bundle.getInt("bundleVersion") == 1 && bundle.has("pin") && bundle.has("recovery")) {
            "A recovery-enabled envelope bundle is required."
        }
        val recoveryKey = try {
            crypto.decodeRecoveryKey(recoveryCode)
        } catch (failure: Exception) {
            recoveryLockout.registerFailure()
            throw SecurityException("Recovery key format or checksum is invalid.", failure)
        }
        val recovered = try {
            crypto.unwrapDataKeyWithRecovery(bundle.getString("recovery"), recoveryKey)
        } catch (failure: Exception) {
            recoveryLockout.registerFailure()
            throw SecurityException("Recovery key verification failed.", failure)
        } finally {
            recoveryKey.fill(0)
        }
        try {
            require(recovered.size == 32) { "Invalid recovered DEK." }
            val replacementPinEnvelope = crypto.wrapDataKey(recovered, newPin)
            val testKey = crypto.unwrapDataKey(replacementPinEnvelope.json, newPin)
            try {
                require(java.security.MessageDigest.isEqual(recovered, testKey)) {
                    "New PIN envelope did not reproduce the existing DEK."
                }
            } finally {
                testKey.fill(0)
            }
            bundle.put("pin", replacementPinEnvelope.json)
            // A recovery result is not an authenticated PMS session. The caller must
            // durably swap the envelope, then the owner must unlock with the new PIN.
            // Keep the recovery throttle intact until the replacement envelope is durably swapped.
            return bundle.toString()
        } finally {
            recovered.fill(0)
        }
    }

    /** Clear recovery throttling only after the caller has durably committed the new PIN envelope. */
    @Synchronized
    fun confirmRecoverySwapCommitted() {
        recoveryLockout.registerSuccess()
    }

    private fun pinEnvelope(envelopeJson: String): String {
        val parsed = JSONObject(envelopeJson)
        return if (parsed.has("pin")) parsed.getString("pin") else envelopeJson
    }

    @Synchronized
    fun currentDataKeyCopy(): ByteArray {
        check(isSessionAuthorized()) { "PMS session is locked." }
        return (dataKey ?: throw SecurityException("Data key is unavailable.")).copyOf()
    }

    @Synchronized
    fun onBackground() {
        if (authenticated) backgroundAtElapsed = SystemClock.elapsedRealtime()
    }

    @Synchronized
    fun onForeground(): Boolean {
        if (!authenticated) return false
        val elapsed = if (backgroundAtElapsed == 0L) 0L
            else SystemClock.elapsedRealtime() - backgroundAtElapsed
        if (elapsed < 0L || elapsed >= sessionTimeoutMs) {
            clearSession()
            return false
        }
        backgroundAtElapsed = 0L
        return true
    }

    @Synchronized
    fun isSessionAuthorized(): Boolean {
        if (!authenticated) return false
        if (backgroundAtElapsed > 0L) {
            val elapsed = SystemClock.elapsedRealtime() - backgroundAtElapsed
            if (elapsed < 0L || elapsed >= sessionTimeoutMs) clearSession()
            // Backgrounded sessions may not reopen the encrypted database.
            // onForeground() must explicitly re-authorize before key access.
            return false
        }
        return true
    }

    @Synchronized
    fun lock() = clearSession()

    private fun clearSession() {
        authenticated = false
        backgroundAtElapsed = 0L
        dataKey?.fill(0)
        dataKey = null
    }
}
