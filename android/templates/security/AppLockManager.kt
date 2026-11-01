package com.aurelia.pms.security

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Tamper-evident local retry state. Corruption or Keystore invalidation fails closed.
 * A reboot restarts the active cooldown instead of trusting the mutable wall clock.
 */
class AppLockManager(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "aurelia-lock-state.v1"))
    private val appContext = context.applicationContext

    companion object {
        private const val STORE = "AndroidKeyStore"
        private const val ALIAS = "aurelia.pms.lock-state.v1"
        private const val MAX_ATTEMPTS = 5
        private const val BASE_LOCK_MS = 60_000L
        private const val MAX_LOCK_MS = 60 * 60 * 1000L
        private const val MAGIC = "AURELIA-LOCK-V1"
    }

    data class State(
        val failures: Int,
        val lockedUntilElapsed: Long,
        val bootCount: Int
    )

    @Synchronized
    fun state(): State {
        val state = readState()
        val currentBoot = bootCount()
        if (state.bootCount != currentBoot && state.lockedUntilElapsed > 0L) {
            // Do not let a reboot erase an active lockout or make wall-clock time authoritative.
            val restarted = state.copy(
                lockedUntilElapsed = SystemClock.elapsedRealtime() + lockDuration(state.failures),
                bootCount = currentBoot
            )
            writeState(restarted)
            return restarted
        }
        return state
    }

    @Synchronized
    fun assertUnlocked() {
        val current = state()
        val remaining = current.lockedUntilElapsed - SystemClock.elapsedRealtime()
        if (remaining > 0L) {
            throw SecurityException("PIN retry is temporarily locked.")
        }
    }

    @Synchronized
    fun registerFailure() {
        val current = state()
        val failures = (current.failures + 1).coerceAtMost(30)
        val until = if (failures >= MAX_ATTEMPTS) {
            SystemClock.elapsedRealtime() + lockDuration(failures)
        } else 0L
        writeState(State(failures, until, bootCount()))
    }

    @Synchronized
    fun registerSuccess() {
        writeState(State(0, 0L, bootCount()))
    }

    private fun lockDuration(failures: Int): Long {
        val exponent = (failures - MAX_ATTEMPTS).coerceIn(0, 10)
        return (BASE_LOCK_MS * (1L shl exponent)).coerceAtMost(MAX_LOCK_MS)
    }

    private fun bootCount(): Int = if (Build.VERSION.SDK_INT >= 24) {
        Settings.Global.getInt(appContext.contentResolver, Settings.Global.BOOT_COUNT, -1)
    } else -1

    private fun readState(): State {
        val bytes = try { file.openRead().use { it.readBytes() } }
        catch (missing: java.io.FileNotFoundException) { return State(0, 0L, bootCount()) }
        val plain = decrypt(bytes)
        try {
            val json = JSONObject(String(plain, Charsets.UTF_8))
            require(json.getString("magic") == MAGIC)
            val failures = json.getInt("failures")
            require(failures in 0..30)
            val deadline = json.getLong("lockedUntilElapsed")
            require(deadline >= 0L)
            State(failures, deadline, json.getInt("bootCount"))
        } catch (failure: Exception) {
            throw SecurityException("Local lock state is corrupt; refusing unlock.", failure)
        } finally {
            plain.fill(0)
        }
    }

    private fun writeState(state: State) {
        val plain = JSONObject()
            .put("magic", MAGIC)
            .put("failures", state.failures)
            .put("lockedUntilElapsed", state.lockedUntilElapsed)
            .put("bootCount", state.bootCount)
            .toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { encrypt(plain) } finally { plain.fill(0) }
        var stream: java.io.FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(encrypted)
            stream.fd.sync()
            file.finishWrite(stream)
        } catch (failure: Exception) {
            if (stream != null) file.failWrite(stream)
            throw SecurityException("Could not persist lock state; refusing unlock.", failure)
        } finally {
            encrypted.fill(0)
        }
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(MAGIC.toByteArray(Charsets.UTF_8))
        val ciphertext = cipher.doFinal(plain)
        return byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + ciphertext
    }

    private fun decrypt(input: ByteArray): ByteArray {
        require(input.size in 29..4096) { "Invalid lock state size." }
        val ivSize = input[0].toInt() and 0xff
        require(ivSize == 12 && input.size > 1 + ivSize + 16) { "Invalid lock state envelope." }
        val iv = input.copyOfRange(1, 1 + ivSize)
        val ciphertext = input.copyOfRange(1 + ivSize, input.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(MAGIC.toByteArray(Charsets.UTF_8))
        return try { cipher.doFinal(ciphertext) } finally { iv.fill(0); ciphertext.fill(0) }
    }

    @Synchronized
    private fun getOrCreateKey(): SecretKey {
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
