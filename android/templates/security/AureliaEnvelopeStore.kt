package com.aurelia.pms.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the PIN envelope at rest with a non-exportable Android Keystore key.
 * This prevents a copied app-private file from becoming an offline PIN oracle.
 */
class AureliaEnvelopeStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "aurelia-pin-envelope.v2"))

    companion object {
        private const val STORE = "AndroidKeyStore"
        private const val ALIAS = "aurelia.pms.pin-envelope-at-rest.v1"
        private const val AAD = "com.aurelia.pms|pin-envelope-at-rest|v1"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }

    fun exists(): Boolean = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists() || File(file.baseFile.path + ".prev").exists()

    @Synchronized
    fun write(envelopeJson: String) {
        val plain = envelopeJson.toByteArray(Charsets.UTF_8)
        val encrypted = try { encrypt(plain) } finally { plain.fill(0) }
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(encrypted)
            stream.fd.sync()
            file.finishWrite(stream)
        } catch (failure: Exception) {
            if (stream != null) file.failWrite(stream)
            throw SecurityException("Could not persist PIN envelope.", failure)
        } finally {
            encrypted.fill(0)
        }
    }

    /** Atomic recovery swap with a synced prior encrypted envelope retained as .prev. */
    @Synchronized
    fun writeRecoveryReplacement(envelopeJson: String) {
        require(file.baseFile.exists()) { "Previous PIN envelope is missing; refusing recovery swap." }
        val previous = File(file.baseFile.path + ".prev")
        val oldBytes = file.baseFile.readBytes()
        try {
            java.io.FileOutputStream(previous, false).use { output ->
                output.write(oldBytes)
                output.fd.sync()
            }
        } finally { oldBytes.fill(0) }
        try {
            write(envelopeJson)
            require(read() == envelopeJson) { "Recovery envelope read-back verification failed." }
        } catch (failure: Exception) {
            // Restore the exact previous encrypted bytes if promotion/read-back fails.
            val old = previous.readBytes()
            var stream: java.io.FileOutputStream? = null
            try {
                stream = file.startWrite()
                stream.write(old)
                stream.fd.sync()
                file.finishWrite(stream)
            } catch (restoreFailure: Exception) {
                if (stream != null) file.failWrite(stream)
                throw SecurityException("Recovery swap and rollback both failed; refusing PMS access.", restoreFailure)
            } finally { old.fill(0) }
            throw failure
        }
    }

    @Synchronized
    fun confirmRecoveryPinUnlock() {
        val previous = File(file.baseFile.path + ".prev")
        if (previous.exists() && !previous.delete()) throw SecurityException("Could not retire previous PIN envelope.")
    }

    @Synchronized
    fun hasPreviousEnvelope(): Boolean = File(file.baseFile.path + ".prev").exists()

    @Synchronized
    fun delete() {
        file.delete()
    }

    @Synchronized
    fun read(): String {
        val stored = file.openRead().use { it.readBytes() }
        val plain = try { decrypt(stored) } finally { stored.fill(0) }
        return try {
            require(plain.size in 1..4096) { "Invalid PIN envelope payload." }
            String(plain, Charsets.UTF_8)
        } finally {
            plain.fill(0)
        }
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(plain)
        val iv = cipher.iv
        require(iv.size == IV_BYTES)
        return byteArrayOf(iv.size.toByte()) + iv + encrypted
    }

    private fun decrypt(stored: ByteArray): ByteArray {
        require(stored.size in (1 + IV_BYTES + 16)..8192) { "Invalid encrypted envelope file." }
        val ivSize = stored[0].toInt() and 0xff
        require(ivSize == IV_BYTES)
        val iv = stored.copyOfRange(1, 1 + ivSize)
        val ciphertext = stored.copyOfRange(1 + ivSize, stored.size)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            cipher.doFinal(ciphertext)
        } finally {
            iv.fill(0)
            ciphertext.fill(0)
        }
    }

    @Synchronized
    private fun key(): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }
}
