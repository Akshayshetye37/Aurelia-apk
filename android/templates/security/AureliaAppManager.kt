package com.aurelia.pms.security

import android.os.SystemClock
import java.security.SecureRandom

/**
 * Process-scoped security coordinator. A new process always starts unauthenticated.
 * Integration must gate MainActivity/WebView creation before BridgeActivity.onCreate.
 */
class AureliaAppManager(
    private val crypto: AureliaCryptoEngine,
    private val lockout: AppLockManager,
    private val random: SecureRandom = SecureRandom(),
    private val sessionTimeoutMs: Long = 5 * 60 * 1000L
) {
    @Volatile private var authenticated = false
    @Volatile private var backgroundAtElapsed = 0L
    @Volatile private var dataKey: ByteArray? = null

    data class Enrollment(val envelopeJson: String, val biometricKeyRequired: Boolean = false)

    /** Generates a fresh DEK and wraps it under the new PIN. Caller persists the envelope atomically. */
    @Synchronized
    fun enroll(pin: CharArray): Enrollment {
        lockout.assertUnlocked()
        val dek = ByteArray(32).also(random::nextBytes)
        return try {
            val envelope = crypto.wrapDataKey(dek, pin)
            dataKey?.fill(0)
            dataKey = dek.copyOf()
            authenticated = true
            lockout.registerSuccess()
            Enrollment(envelope.json)
        } finally {
            dek.fill(0)
        }
    }

    /** Unlocks only when the envelope authenticates and yields a 256-bit DEK. */
    @Synchronized
    fun unlock(pin: CharArray, envelopeJson: String): Boolean {
        lockout.assertUnlocked()
        val recovered = try {
            crypto.unwrapDataKey(envelopeJson, pin)
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
            crypto.unwrapDataKey(currentEnvelope, currentPin)
        } catch (failure: Exception) {
            lockout.registerFailure()
            throw SecurityException("Current PIN verification failed.", failure)
        }
        try {
            require(dek.size == 32)
            val replacement = crypto.wrapDataKey(dek, newPin)
            return replacement.json
        } finally {
            dek.fill(0)
        }
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
        if (backgroundAtElapsed > 0L &&
            SystemClock.elapsedRealtime() - backgroundAtElapsed >= sessionTimeoutMs) {
            clearSession()
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
