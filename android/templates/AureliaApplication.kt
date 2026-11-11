package com.aurelia.pms

import android.app.Application
import com.google.firebase.FirebaseApp

/**
 * Installs App Check before application activities or Firebase feature clients run.
 * Missing Firebase configuration does not prevent offline PMS startup; any recovery
 * feature that needs Firebase separately requires successful App Check installation.
 */
class AureliaApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        val firebaseApp = try {
            FirebaseApp.getInstance()
        } catch (_: IllegalStateException) {
            FirebaseApp.initializeApp(this)
        }
        if (firebaseApp != null) {
            AureliaAppCheck.install(firebaseApp)
        }
    }
}
