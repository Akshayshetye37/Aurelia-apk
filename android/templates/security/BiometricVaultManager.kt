package com.aurelia.pms.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Device-bound biometric wrapping for a PIN-unwrapped DEK.
 * The biometric callback alone is never treated as authorization: callers must
 * use the returned CryptoObject operation to authenticate/decrypt the vault key.
 */
class BiometricVaultManager {
    companion object {
        private const val STORE = "AndroidKeyStore"
        private const val ALIAS = "aurelia.pms.biometric.dek.v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
    }

    data class WrappedKey(val nonce: ByteArray, val ciphertext: ByteArray)

    fun isStrongBiometricAvailable(activity: FragmentActivity): Boolean =
        BiometricManager.from(activity).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG
        ) == BiometricManager.BIOMETRIC_SUCCESS

    @Synchronized
    fun createOrReplaceKey() {
        require(Build.VERSION.SDK_INT >= 24) {
            "Biometric vault requires Android 7.0 or later for enrollment invalidation guarantees."
        }
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        val builder = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= 30) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG
            )
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }
        generator.init(builder.build())
        generator.generateKey()
    }

    fun prepareEncryptOperation(): BiometricPrompt.CryptoObject {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, loadKey())
        return BiometricPrompt.CryptoObject(cipher)
    }

    fun prepareDecryptOperation(nonce: ByteArray): BiometricPrompt.CryptoObject {
        require(nonce.size == 12) { "Invalid biometric envelope nonce." }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, loadKey(), GCMParameterSpec(TAG_BITS, nonce))
        return BiometricPrompt.CryptoObject(cipher)
    }

    fun encryptAfterAuthentication(
        cryptoObject: BiometricPrompt.CryptoObject,
        dataKey: ByteArray
    ): WrappedKey {
        require(dataKey.size == 32) { "DEK must be 256 bits." }
        val cipher = requireNotNull(cryptoObject.cipher) { "Missing authenticated cipher." }
        val ciphertext = cipher.doFinal(dataKey)
        return WrappedKey(requireNotNull(cipher.iv).copyOf(), ciphertext)
    }

    fun decryptAfterAuthentication(
        cryptoObject: BiometricPrompt.CryptoObject,
        ciphertext: ByteArray
    ): ByteArray {
        val cipher = requireNotNull(cryptoObject.cipher) { "Missing authenticated cipher." }
        return cipher.doFinal(ciphertext)
    }

    private fun loadKey(): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        return store.getKey(ALIAS, null) as? SecretKey
            ?: throw IllegalStateException("Biometric vault is not enrolled.")
    }
}
