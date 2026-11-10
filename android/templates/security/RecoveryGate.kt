package com.aurelia.pms.security

import android.os.SystemClock

/**
 * Process-local authorization window. It is armed only after a signed backend
 * recovery grant has been verified. Process death closes the gate automatically.
 *
 * One grant authorizes at most three checksum-valid recovery-key unwrap attempts.
 * Checksum/format failures are handled before spendAttempt() and are free.
 */
object RecoveryGate {
    private const val TTL_MS = 10 * 60_000L
    private const val MAX_ATTEMPTS = 3

    @Volatile private var deadlineElapsed = 0L
    @Volatile private var attemptsRemaining = 0

    @Synchronized
    fun arm(verification: RecoveryGrantVerifier.Result) {
        check(verification === RecoveryGrantVerifier.Result.Ok) {
            "A verified recovery grant is required to arm the recovery gate."
        }
        deadlineElapsed = SystemClock.elapsedRealtime() + TTL_MS
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
