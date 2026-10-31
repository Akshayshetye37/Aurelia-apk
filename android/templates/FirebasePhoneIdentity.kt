package com.aurelia.pms.identity

import android.app.Activity
import androidx.annotation.MainThread
import com.google.firebase.FirebaseException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.PhoneAuthCredential
import com.google.firebase.auth.PhoneAuthOptions
import com.google.firebase.auth.PhoneAuthProvider
import java.util.concurrent.TimeUnit

/**
 * Recovery-only Firebase phone verifier.
 *
 * IMPORTANT: inject a FirebaseAuth instance backed by a dedicated, named FirebaseApp,
 * not FirebaseAuth.getInstance() for the app's primary FirebaseApp. This prevents
 * recovery sign-in from replacing the user's primary Firebase session.
 *
 * The expected E.164 number must come from the already-authenticated local recovery
 * record. Never populate it from the number typed into the current OTP screen.
 */
sealed interface PhoneIdentityState {
    data object Idle : PhoneIdentityState
    data object Requesting : PhoneIdentityState
    data object CodeSent : PhoneIdentityState
    data object AutoRetrievalTimedOut : PhoneIdentityState
    data object Verifying : PhoneIdentityState
    data class IdentityVerified(val verifiedPhoneE164: String) : PhoneIdentityState
    data class Failed(val reason: FailureReason) : PhoneIdentityState
}

enum class FailureReason {
    INVALID_TRUSTED_PHONE,
    INVALID_OTP,
    INVALID_STATE,
    PHONE_MISMATCH,
    PROVIDER_FAILURE,
}

class FirebasePhoneIdentity(
    private val recoveryAuth: FirebaseAuth,
    private val onStateChanged: (PhoneIdentityState) -> Unit
) {
    private var state: PhoneIdentityState = PhoneIdentityState.Idle
    private var generation: Long = 0L
    private var trustedPhoneE164: String? = null
    private var verificationId: String? = null
    private var resendToken: PhoneAuthProvider.ForceResendingToken? = null
    private var authOperationInFlight = false

    @MainThread
    fun state(): PhoneIdentityState = state

    /**
     * Starts OTP only for the phone number already stored in the recovery record.
     * The number must be canonical E.164 (+ followed by 8–15 digits, first digit nonzero).
     */
    @MainThread
    fun requestOtp(trustedPhoneFromRecoveryRecord: String, activity: Activity) {
        if (authOperationInFlight || state is PhoneIdentityState.Requesting ||
            state is PhoneIdentityState.Verifying) {
            emit(PhoneIdentityState.Failed(FailureReason.INVALID_STATE))
            return
        }

        if (!E164.matches(trustedPhoneFromRecoveryRecord)) {
            emit(PhoneIdentityState.Failed(FailureReason.INVALID_TRUSTED_PHONE))
            return
        }

        // Never replace the phone identity while a prior challenge is still active.
        invalidateChallenge()
        trustedPhoneE164 = trustedPhoneFromRecoveryRecord
        val requestGeneration = ++generation
        emit(PhoneIdentityState.Requesting)
        startVerification(
            phone = trustedPhoneFromRecoveryRecord,
            activity = activity,
            requestGeneration = requestGeneration,
            forceToken = null
        )
    }

    @MainThread
    fun resendOtp(activity: Activity) {
        val phone = trustedPhoneE164
        val token = resendToken
        if (authOperationInFlight || phone == null || token == null ||
            (state !is PhoneIdentityState.CodeSent &&
             state !is PhoneIdentityState.AutoRetrievalTimedOut &&
             state !is PhoneIdentityState.Failed)) {
            emit(PhoneIdentityState.Failed(FailureReason.INVALID_STATE))
            return
        }

        val requestGeneration = ++generation
        verificationId = null
        resendToken = null
        emit(PhoneIdentityState.Requesting)
        startVerification(phone, activity, requestGeneration, token)
    }

    @MainThread
    fun submitOtp(code: String) {
        val id = verificationId
        val phone = trustedPhoneE164
        if (authOperationInFlight || phone == null || id == null ||
            (state !is PhoneIdentityState.CodeSent &&
             state !is PhoneIdentityState.AutoRetrievalTimedOut &&
             state !is PhoneIdentityState.Failed)) {
            emit(PhoneIdentityState.Failed(FailureReason.INVALID_STATE))
            return
        }
        if (!OTP.matches(code)) {
            emit(PhoneIdentityState.Failed(FailureReason.INVALID_OTP))
            return
        }

        val requestGeneration = generation
        authOperationInFlight = true
        emit(PhoneIdentityState.Verifying)
        authenticate(PhoneAuthProvider.getCredential(id, code), phone, requestGeneration)
    }

    /**
     * Invalidates UI/challenge state. An already-started Firebase sign-in cannot be
     * cancelled; its completion is still observed and its isolated session is signed out.
     */
    @MainThread
    fun reset() {
        generation++
        verificationId = null
        resendToken = null
        trustedPhoneE164 = null
        emit(PhoneIdentityState.Idle)
    }

    private fun startVerification(
        phone: String,
        activity: Activity,
        requestGeneration: Long,
        forceToken: PhoneAuthProvider.ForceResendingToken?
    ) {
        val callbacks = object : PhoneAuthProvider.OnVerificationStateChangedCallbacks() {
            override fun onVerificationCompleted(credential: PhoneAuthCredential) {
                if (requestGeneration != generation) return
                val expected = trustedPhoneE164 ?: return
                if (authOperationInFlight) return
                authOperationInFlight = true
                emit(PhoneIdentityState.Verifying)
                authenticate(credential, expected, requestGeneration)
            }

            override fun onVerificationFailed(exception: FirebaseException) {
                if (requestGeneration != generation || authOperationInFlight) return
                clearChallenge()
                emit(PhoneIdentityState.Failed(FailureReason.PROVIDER_FAILURE))
            }

            override fun onCodeSent(
                id: String,
                token: PhoneAuthProvider.ForceResendingToken
            ) {
                if (requestGeneration != generation || authOperationInFlight) return
                verificationId = id
                resendToken = token
                emit(PhoneIdentityState.CodeSent)
            }

            override fun onCodeAutoRetrievalTimeOut(id: String) {
                if (requestGeneration != generation || authOperationInFlight) return
                // Preserve verificationId: manual entry must still work after timeout.
                if (verificationId == null) verificationId = id
                emit(PhoneIdentityState.AutoRetrievalTimedOut)
            }
        }

        val builder = PhoneAuthOptions.newBuilder(recoveryAuth)
            .setPhoneNumber(phone)
            .setTimeout(60L, TimeUnit.SECONDS)
            .setActivity(activity)
            .setCallbacks(callbacks)
        if (forceToken != null) builder.setForceResendingToken(forceToken)
        PhoneAuthProvider.verifyPhoneNumber(builder.build())
    }

    private fun authenticate(
        credential: PhoneAuthCredential,
        expectedPhone: String,
        requestGeneration: Long
    ) {
        recoveryAuth.signInWithCredential(credential).addOnCompleteListener { task ->
            // Task.result throws when the Firebase task failed. Read it only on success,
            // otherwise the cleanup below would be skipped and the recovery flow could
            // remain permanently marked in-flight.
            val actualPhone = if (task.isSuccessful) task.result?.user?.phoneNumber else null
            val success = task.isSuccessful && actualPhone == expectedPhone

            // Always clear the recovery-only Firebase session. Do not leave a signed-in
            // temporary user or let this auth instance become an app-wide session.
            recoveryAuth.signOut()
            authOperationInFlight = false

            if (requestGeneration != generation) {
                clearChallenge()
                return@addOnCompleteListener
            }

            clearChallenge()
            if (success) {
                emit(PhoneIdentityState.IdentityVerified(expectedPhone))
            } else if (task.isSuccessful) {
                emit(PhoneIdentityState.Failed(FailureReason.PHONE_MISMATCH))
            } else {
                emit(PhoneIdentityState.Failed(FailureReason.PROVIDER_FAILURE))
            }
        }
    }

    private fun invalidateChallenge() {
        verificationId = null
        resendToken = null
    }

    private fun clearChallenge() {
        invalidateChallenge()
        trustedPhoneE164 = null
    }

    private fun emit(next: PhoneIdentityState) {
        state = next
        onStateChanged(next)
    }

    private companion object {
        val E164 = Regex("^\\+[1-9][0-9]{7,14}$")
        val OTP = Regex("^[0-9]{6}$")
    }
}
