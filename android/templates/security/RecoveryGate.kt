package com.aurelia.pms.security

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Durable, grant-bound recovery authorization. The consumed server JTI is the
 * authorization identity; this encrypted state only enforces a local second limit.
 * A reboot expires the grant. Corrupt/missing state or a missing Keystore key fails closed.
 */
object RecoveryGate {
    private const val TTL_MS = 5 * 60_000L
    private const val MAX_ATTEMPTS = 3
    private const val FILE_NAME = "aurelia-recovery-gate.v1"
    private const val KEY_ALIAS = "aurelia.pms.recovery-gate.v1"
    private const val MAGIC = "AURELIA-RECOVERY-GATE-V1"
    private const val STORE = "AndroidKeyStore"
    private lateinit var appContext: Context
    private var stateFile: AtomicFile? = null
    @Volatile private var stateUnavailable = false

    private data class State(
        val jti: String,
        val attemptsRemaining: Int,
        val startedElapsed: Long,
        val deadlineElapsed: Long,
        val bootCount: Int
    )

    @Synchronized
    fun initialize(context: Context) {
        appContext = context.applicationContext
        stateFile = AtomicFile(File(appContext.noBackupFilesDir, FILE_NAME))
        // Corrupt/missing recovery state disables recovery only; local PIN unlock remains available.
        stateUnavailable = try { readState(); false } catch (_: Exception) { true }
    }

    @Synchronized
    fun armAfterServerConsumption(jti: String, remainingGrantMs: Long) {
        check(!stateUnavailable) { "Recovery attempt state is unavailable; refusing recovery." }
        require(jti.matches(Regex("^[0-9a-fA-F-]{36}$")))
        check(remainingGrantMs in 1..TTL_MS) {
            "A live, five-minute recovery grant consumed by the backend is required."
        }
        val currentBoot = bootCount()
        check(currentBoot >= 0) { "Reliable boot identity is unavailable; recovery is disabled on this device." }
        val now = SystemClock.elapsedRealtime()
        writeState(State(jti, MAX_ATTEMPTS, now, now + remainingGrantMs, currentBoot))
    }

    @Synchronized
    fun isOpen(): Boolean {
        if (stateUnavailable) return false
        val state = safeReadState() ?: return false
        if (state.attemptsRemaining <= 0 || expired(state)) {
            clear()
            return false
        }
        return true
    }

    @Synchronized
    fun spendAttempt(expectedJti: String? = null): Boolean {
        if (stateUnavailable) return false
        val state = safeReadState() ?: return false
        if (state.attemptsRemaining <= 0 || expired(state) ||
            (expectedJti != null && expectedJti != state.jti)) {
            clear()
            return false
        }
        writeState(state.copy(attemptsRemaining = state.attemptsRemaining - 1))
        return true
    }

    @Synchronized
    fun attemptsLeft(): Int {
        if (stateUnavailable) return 0
        val state = safeReadState() ?: return 0
        if (state.attemptsRemaining <= 0 || expired(state)) {
            clear()
            return 0
        }
        return state.attemptsRemaining
    }

    @Synchronized
    fun clear() {
        if (stateUnavailable) return
        try { writeState(State("", 0, 0L, 0L, bootCount())) }
        catch (_: Exception) { stateUnavailable = true }
    }

    private fun safeReadState(): State? {
        if (stateUnavailable) return null
        return try { readState() } catch (_: Exception) {
            stateUnavailable = true
            null
        }
    }

    private fun expired(state: State): Boolean {
        val now = SystemClock.elapsedRealtime()
        // Recovery is available only when Android exposes a reliable boot counter.
        // A missing counter or a changed counter expires the grant fail-closed.
        if (state.bootCount < 0 || state.bootCount != bootCount()) return true
        if (now < state.startedElapsed) return true
        return now >= state.deadlineElapsed
    }

    private fun bootCount(): Int = if (Build.VERSION.SDK_INT >= 24) {
        Settings.Global.getInt(appContext.contentResolver, Settings.Global.BOOT_COUNT, -1)
    } else -1

    private fun readState(): State? {
        val file = requireFile()
        val bytes = try { file.openRead().use { it.readBytes() } }
        catch (_: java.io.FileNotFoundException) {
            if (hasKey()) throw SecurityException("Recovery gate state is missing; refusing to reset attempts.")
            return null
        }
        val plain = decrypt(bytes)
        return try {
            val json = JSONObject(String(plain, Charsets.UTF_8))
            require(json.getString("magic") == MAGIC)
            val jti = json.getString("jti")
            val attempts = json.getInt("attemptsRemaining")
            val started = json.getLong("startedElapsed")
            val deadline = json.getLong("deadlineElapsed")
            val boot = json.getInt("bootCount")
            require(attempts in 0..MAX_ATTEMPTS && started >= 0L && deadline >= 0L)
            require(jti.isEmpty() || jti.matches(Regex("^[0-9a-fA-F-]{36}$")))
            State(jti, attempts, started, deadline, boot)
        } catch (failure: Exception) {
            throw SecurityException("Recovery gate state is corrupt; refusing recovery.", failure)
        } finally { plain.fill(0); bytes.fill(0) }
    }

    private fun writeState(state: State) {
        val plain = JSONObject().put("magic", MAGIC).put("jti", state.jti)
            .put("attemptsRemaining", state.attemptsRemaining)
            .put("startedElapsed", state.startedElapsed)
            .put("deadlineElapsed", state.deadlineElapsed)
            .put("bootCount", state.bootCount).toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { encrypt(plain) } finally { plain.fill(0) }
        var stream: java.io.FileOutputStream? = null
        try {
            stream = requireFile().startWrite()
            stream.write(encrypted)
            stream.fd.sync()
            requireFile().finishWrite(stream)
        } catch (failure: Exception) {
            if (stream != null) requireFile().failWrite(stream)
            throw SecurityException("Could not persist recovery gate state; refusing recovery.", failure)
        } finally { encrypted.fill(0) }
    }

    private fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keyForWrite())
        cipher.updateAAD(MAGIC.toByteArray(Charsets.UTF_8))
        return byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + cipher.doFinal(plain)
    }

    private fun decrypt(input: ByteArray): ByteArray {
        require(input.size in 30..4096)
        val ivSize = input[0].toInt() and 0xff
        require(ivSize == 12 && input.size > 1 + ivSize + 16)
        val iv = input.copyOfRange(1, 1 + ivSize)
        val ciphertext = input.copyOfRange(1 + ivSize, input.size)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, existingKey(), GCMParameterSpec(128, iv))
            cipher.updateAAD(MAGIC.toByteArray(Charsets.UTF_8))
            return cipher.doFinal(ciphertext)
        } finally { iv.fill(0); ciphertext.fill(0) }
    }

    private fun keyForWrite(): SecretKey {
        existingKeyOrNull()?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun existingKeyOrNull(): SecretKey? {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        return store.getKey(KEY_ALIAS, null) as? SecretKey
    }

    private fun existingKey(): SecretKey = existingKeyOrNull()
        ?: throw SecurityException("Recovery gate Keystore key is missing; refusing to reset attempts.")

    private fun hasKey(): Boolean {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        return store.containsAlias(KEY_ALIAS)
    }

    private fun requireFile(): AtomicFile = stateFile
        ?: throw IllegalStateException("RecoveryGate must be initialized with application context.")
}
