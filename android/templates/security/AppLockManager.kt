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
class AppLockManager(
    context: Context,
    stateFileName: String = "aurelia-lock-state.v1",
    private val keyAlias: String = "aurelia.pms.lock-state.v1",
    private val stateMagic: String = "AURELIA-LOCK-V1"
) {
    private val file = AtomicFile(File(context.noBackupFilesDir, stateFileName))
    private val appContext = context.applicationContext

    /** Java instrumentation and existing native callers use the original one-argument API. */
    constructor(context: Context) : this(
        context,
        "aurelia-lock-state.v1",
        "aurelia.pms.lock-state.v1",
        "AURELIA-LOCK-V1"
    )

    companion object {
        private const val STORE = "AndroidKeyStore"
        private const val MAX_ATTEMPTS = 5
        private const val BASE_LOCK_MS = 60_000L
        private const val MAX_LOCK_MS = 60 * 60 * 1000L
    }

    data class State(
        val failures: Int,
        val lockedUntilElapsed: Long,
        val bootCount: Int,
        val pendingAttempt: Boolean = false
    )

    @Synchronized
    fun state(): State {
        var current = readState()
        val currentBoot = bootCount()
        // A process/device death while an attempt is pending is conservatively
        // treated as a failed attempt. The counter cannot be reset by killing the app.
        if (current.pendingAttempt) {
            val failures = (current.failures + 1).coerceAtMost(30)
            val until = if (failures >= MAX_ATTEMPTS) {
                SystemClock.elapsedRealtime() + lockDuration(failures)
            } else 0L
            current = State(failures, until, currentBoot, pendingAttempt = false)
            writeState(current)
        }
        if (current.bootCount != currentBoot && current.lockedUntilElapsed > 0L) {
            // Do not let a reboot erase an active lockout or make wall-clock time authoritative.
            val restarted = current.copy(
                lockedUntilElapsed = SystemClock.elapsedRealtime() + lockDuration(current.failures),
                bootCount = currentBoot
            )
            writeState(restarted)
            return restarted
        }
        if (current.bootCount != currentBoot) {
            current = current.copy(bootCount = currentBoot)
            writeState(current)
        }
        return current
    }

    /** Persist an in-flight attempt before any recovery-key unwrap operation. */
    @Synchronized
    fun beginAttempt() {
        val current = state()
        if (current.lockedUntilElapsed - SystemClock.elapsedRealtime() > 0L) {
            throw SecurityException("Recovery key retry is temporarily locked.")
        }
        writeState(current.copy(pendingAttempt = true))
    }

    /** Stable test seam; callers cannot mutate the authenticated retry state. */
    @androidx.annotation.VisibleForTesting(otherwise = androidx.annotation.VisibleForTesting.PRIVATE)
    fun lockoutFailureCount(): Int = state().failures

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
        val current = readState()
        val failures = (current.failures + 1).coerceAtMost(30)
        val until = if (failures >= MAX_ATTEMPTS) {
            SystemClock.elapsedRealtime() + lockDuration(failures)
        } else 0L
        writeState(State(failures, until, bootCount(), pendingAttempt = false))
    }

    @Synchronized
    fun registerSuccess() {
        writeState(State(0, 0L, bootCount(), pendingAttempt = false))
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
        catch (missing: java.io.FileNotFoundException) {
            if (hasKeyAlias()) throw SecurityException("PIN lock state is missing after enrollment; refusing to reset retry counters.")
            return State(0, 0L, bootCount())
        }
        val plain = decrypt(bytes)
        return try {
            val json = JSONObject(String(plain, Charsets.UTF_8))
            require(json.getString("magic") == stateMagic)
            val failures = json.getInt("failures")
            require(failures in 0..30)
            val deadline = json.getLong("lockedUntilElapsed")
            require(deadline >= 0L)
            State(failures, deadline, json.getInt("bootCount"), json.optBoolean("pendingAttempt", false))
        } catch (failure: Exception) {
            throw SecurityException("Local lock state is corrupt; refusing unlock.", failure)
        } finally {
            plain.fill(0)
        }
    }

    private fun writeState(state: State) {
        val plain = JSONObject()
            .put("magic", stateMagic)
            .put("failures", state.failures)
            .put("lockedUntilElapsed", state.lockedUntilElapsed)
            .put("bootCount", state.bootCount)
            .put("pendingAttempt", state.pendingAttempt)
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
        cipher.updateAAD(stateMagic.toByteArray(Charsets.UTF_8))
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
        cipher.init(Cipher.DECRYPT_MODE, existingKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(stateMagic.toByteArray(Charsets.UTF_8))
        return try { cipher.doFinal(ciphertext) } finally { iv.fill(0); ciphertext.fill(0) }
    }

    private fun hasKeyAlias(): Boolean {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        return store.containsAlias(keyAlias)
    }

    private fun existingKey(): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        return store.getKey(keyAlias, null) as? SecretKey
            ?: throw SecurityException("PIN lock-state key is missing; refusing to reset retry counters.")
    }

    @Synchronized
    private fun getOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
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
