package com.aurelia.pms

import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory

/**
 * Installs real Play Integrity attestation for each FirebaseApp used by Aurelia.
 * There is deliberately no debug-provider or token bypass in this source set.
 */
object AureliaAppCheck {
    private val installedApps = mutableSetOf<String>()

    @Synchronized
    fun install(firebaseApp: FirebaseApp): Boolean {
        if (installedApps.contains(firebaseApp.name)) return true
        return try {
            val appCheck = FirebaseAppCheck.getInstance(firebaseApp)
            appCheck.installAppCheckProviderFactory(
                PlayIntegrityAppCheckProviderFactory.getInstance()
            )
            appCheck.setTokenAutoRefreshEnabled(true)
            installedApps.add(firebaseApp.name)
            true
        } catch (_: Exception) {
            false
        }
    }

    @Synchronized
    fun requireInstalled(firebaseApp: FirebaseApp) {
        check(installedApps.contains(firebaseApp.name)) {
            "Firebase App Check is unavailable. Recovery network access is blocked."
        }
    }
}
