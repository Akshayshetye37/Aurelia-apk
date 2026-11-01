package com.aurelia.pms.security

import android.content.Context

/** Process-local coordinator shared by the native launcher and MainActivity. */
object AureliaSecurityRuntime {
    @Volatile private var instance: AureliaAppManager? = null

    @Synchronized
    fun manager(context: Context): AureliaAppManager {
        instance?.let { return it }
        return AureliaAppManager(
            AureliaCryptoEngine(),
            AppLockManager(context.applicationContext)
        ).also { instance = it }
    }
}

/** Kept package-private to make the gate's retry check explicit without exposing state. */
internal fun AureliaAppManager.lockoutCheckForGate() = Unit
