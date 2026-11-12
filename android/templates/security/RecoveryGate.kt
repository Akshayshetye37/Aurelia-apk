package com.aurelia.pms.security

import android.os.SystemClock

/**
 * Process-local authorization window. It is armed only after the backend verifies
 * and atomically consumes a signed grant and the encrypted local replay marker commits.
 * Process death closes the gate automatically.
 *
 * One grant authorizes at most three checksum-valid recovery-key unwrap attempts.
 * A fresh phone OTP is required after the server-side 24-hour recovery hold.
 * The remaining duration is measured from a monotonic timestamp captured before
 * the grant request; wall-clock changes cannot extend the authorization window.
 */
object RecoveryGate {
    private const val TTL_MS = 5 * 60_000L
    private const val MAX_ATTEMPTS = 3

    @Volatile private var deadlineElapsed = 0L
    @Volatile private var attemptsRemaining = 0

    /**
     * Call only after the backend has verified the ES256 grant and atomically
     * consumed its jti, and the encrypted local replay marker is durable.
     * The local window can never outlive the signed grant expiry.
     */
    @Synchronized
    fun armAfterServerConsumption(remainingGrantMs: Long) {
        check(remainingGrantMs in 1..TTL_MS) {
            "A live, five-minute recovery grant consumed by the backend is required."
        }
        deadlineElapsed = SystemClock.elapsedRealtime() + remainingGrantMs
        attemptsRemaining = MAX_ATTEMPTS
    }

    @Synchronized
    fun isOpen(): Boolean {
        if (attemptsRemaining <= 0 || SystemClock.elapsedRealtime() >= deadlineElapsed) {
            clear()
            return false
        }
        return true
    }

    @Synchronized
    fun spendAttempt(): Boolean {
        if (!isOpen()) return false
        attemptsRemaining--
        return true
    }

    @Synchronized
    fun attemptsLeft(): Int = if (isOpen()) attemptsRemaining else 0

    @Synchronized
    fun clear() {
        attemptsRemaining = 0
        deadlineElapsed = 0L
    }
}
