package com.aurelia.pms.identity

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth

/**
 * Creates a dedicated FirebaseApp/Auth session for recovery OTP only.
 * The default FirebaseApp must have been initialized by the Google Services plugin.
 * Never use this Auth instance for ordinary PMS sign-in or other application features.
 */
object RecoveryFirebaseAuthFactory {
    private const val RECOVERY_APP_NAME = "aurelia-pms-recovery-auth"

    @Synchronized
    fun create(context: Context): FirebaseAuth {
        val defaultApp = try {
            FirebaseApp.getInstance()
        } catch (error: IllegalStateException) {
            throw IllegalStateException(
                "Firebase is not configured. Recovery phone verification is unavailable.",
                error
            )
        }

        val recoveryApp = try {
            FirebaseApp.getInstance(RECOVERY_APP_NAME)
        } catch (_: IllegalStateException) {
            FirebaseApp.initializeApp(
                context.applicationContext,
                defaultApp.options,
                RECOVERY_APP_NAME
            ) ?: throw IllegalStateException("Unable to initialize isolated recovery FirebaseApp.")
        }

        return FirebaseAuth.getInstance(recoveryApp).also {
            // Clear any recovery-only session left by a process termination.
            it.signOut()
        }
    }
}
