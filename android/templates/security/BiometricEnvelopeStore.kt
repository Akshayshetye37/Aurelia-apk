package com.aurelia.pms.security

import android.content.Context
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File

/** Stores only the AES-GCM-wrapped DEK; plaintext key material never reaches disk. */
class BiometricEnvelopeStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "aurelia-biometric-dek.v1"))

    fun exists(): Boolean = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()

    @Synchronized
    fun write(wrapped: BiometricVaultManager.WrappedKey) {
        require(wrapped.nonce.size == 12 && wrapped.ciphertext.size == 48) {
            "Invalid biometric DEK wrapper."
        }
        val encoded = JSONObject()
            .put("version", 1)
            .put("method", "BIOMETRIC")
            .put("databaseId", "aurelia-pms-encrypted.db")
            .put("nonce", Base64.encodeToString(wrapped.nonce, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(wrapped.ciphertext, Base64.NO_WRAP))
            .toString()
            .toByteArray(Charsets.UTF_8)
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(encoded)
            stream.fd.sync()
            file.finishWrite(stream)
        } catch (failure: Exception) {
            if (stream != null) file.failWrite(stream)
            throw SecurityException("Could not persist biometric DEK wrapper.", failure)
        } finally {
            encoded.fill(0)
        }
    }

    @Synchronized
    fun read(): BiometricVaultManager.WrappedKey {
        val stored = file.openRead().use { it.readBytes() }
        try {
            require(stored.size in 1..4096) { "Invalid biometric wrapper file size." }
            val json = JSONObject(String(stored, Charsets.UTF_8))
            require(json.length() == 5 && json.getInt("version") == 1 &&
                json.getString("method") == "BIOMETRIC" &&
                json.getString("databaseId") == "aurelia-pms-encrypted.db") {
                "Biometric wrapper metadata is invalid."
            }
            val nonce = Base64.decode(json.getString("nonce"), Base64.NO_WRAP)
            val ciphertext = Base64.decode(json.getString("ciphertext"), Base64.NO_WRAP)
            require(nonce.size == 12 && ciphertext.size == 48) { "Biometric wrapper length is invalid." }
            return BiometricVaultManager.WrappedKey(nonce, ciphertext)
        } finally {
            stored.fill(0)
        }
    }

    @Synchronized
    fun delete() {
        file.delete()
    }
}
