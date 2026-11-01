package com.aurelia.pms.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Process-local coordinator shared by the native launcher and MainActivity. */
object AureliaSecurityRuntime {
    @Volatile private var instance: AureliaAppManager? = null

    private const val MARKER_ALIAS = "aurelia.pms.enrollment.marker.v1"

    @Synchronized
    fun isEnrolled(): Boolean {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.containsAlias(MARKER_ALIAS)
    }

    @Synchronized
    fun markEnrolled() {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(MARKER_ALIAS)) {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            generator.init(
                KeyGenParameterSpec.Builder(
                    MARKER_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            generator.generateKey()
        }
    }

    @Synchronized
    fun manager(context: Context): AureliaAppManager {
        instance?.let { return it }
        return AureliaAppManager(
            AureliaCryptoEngine(),
            AppLockManager(context.applicationContext)
        ).also { instance = it }
    }
}
