package com.aurelia.pms.security

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import android.widget.Toast
import com.aurelia.pms.MainActivity

/**
 * Exported launcher boundary. This Activity contains no WebView and starts the
 * PMS BridgeActivity only after a PIN envelope has been authenticated/enrolled.
 *
 * This is a first native gate, not a claim that a compromised/rooted OS is safe.
 */
class LockGateActivity : FragmentActivity() {
    private lateinit var manager: AureliaAppManager
    private lateinit var envelopeStore: AureliaEnvelopeStore
    private lateinit var biometricVault: BiometricVaultManager
    private lateinit var biometricStore: BiometricEnvelopeStore
    private var enrollmentMode = false
    private var pinField: EditText? = null
    private var confirmField: EditText? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(
            android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE
        )
        manager = AureliaSecurityRuntime.manager(this)
        envelopeStore = AureliaEnvelopeStore(this)
        biometricVault = BiometricVaultManager()
        biometricStore = BiometricEnvelopeStore(this)
        val enrolled = AureliaSecurityRuntime.isEnrolled()
        val envelopeExists = envelopeStore.exists()
        val databaseExists = encryptedDatabaseExists()
        if (databaseExists && !envelopeExists) {
            throw SecurityException("Encrypted PMS database exists but its key envelope is missing; data recovery is required.")
        }
        if (enrolled && !envelopeExists) {
            throw SecurityException("Enrollment marker exists without a key envelope; refusing DEK regeneration.")
        }
        // The authenticated envelope is authoritative. A missing marker can be
        // restored only after PIN/recovery unlock, never by creating a new DEK.
        enrollmentMode = !envelopeExists
        render()
    }

    private fun render() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 48, 32, 48)
            setBackgroundColor(android.graphics.Color.rgb(5, 17, 13))
        }
        val title = TextView(this).apply {
            text = if (enrollmentMode) "Set your Aurelia PIN" else "Unlock Aurelia PMS"
            textSize = 24f
            setTextColor(android.graphics.Color.WHITE)
            gravity = Gravity.CENTER
        }
        root.addView(title, LinearLayout.LayoutParams(-1, -2))
        val hint = TextView(this).apply {
            text = if (enrollmentMode) "Create a 6–16 digit PIN. Avoid repeated or sequential digits." else "Enter your PIN to open the PMS."
            textSize = 14f
            setTextColor(android.graphics.Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 24)
        }
        root.addView(hint)
        pinField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            this.hint = if (enrollmentMode) "New PIN" else "PIN"
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.GRAY)
            filters = arrayOf(android.text.InputFilter.LengthFilter(16))
        }
        root.addView(pinField, LinearLayout.LayoutParams(-1, -2))
        if (enrollmentMode) {
            confirmField = EditText(this).apply {
                inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
                this.hint = "Confirm PIN"
                setTextColor(android.graphics.Color.WHITE)
                setHintTextColor(android.graphics.Color.GRAY)
                // Must match the primary PIN field and the 6–16 digit security engine.
                filters = arrayOf(android.text.InputFilter.LengthFilter(16))
            }
            root.addView(confirmField, LinearLayout.LayoutParams(-1, -2))
        }
        val button = Button(this).apply {
            text = if (enrollmentMode) "Create secure PIN" else "Unlock"
            setOnClickListener { submit() }
        }
        root.addView(button, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 24 })
        if (!enrollmentMode) {
            if (biometricStore.exists()) {
                val biometric = Button(this).apply {
                    text = "Unlock with biometrics"
                    setOnClickListener { unlockWithBiometrics() }
                }
                root.addView(biometric, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8 })
            }
            val forgot = Button(this).apply {
                text = "Forgot PIN?"
                setOnClickListener { showRecoveryPrompt() }
            }
            root.addView(forgot, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8 })
        }
        setContentView(root)
    }

    private fun submit() {
        val firstField = pinField?.text ?: return
        val first = CharArray(firstField.length)
        firstField.getChars(0, firstField.length, first, 0)
        val secondField = confirmField?.text
        val second = secondField?.let { CharArray(it.length).also { chars -> it.getChars(0, it.length, chars, 0) } }
        try {
            if (first.size !in 6..16 || first.any { it !in '0'..'9' }) {
                showError("PIN must be 6–16 digits and not repeated or sequential.")
                return
            }
            if (enrollmentMode) {
                if (second == null || !first.contentEquals(second)) {
                    showError("PIN confirmation does not match.")
                    return
                }
                val enrollment = manager.enroll(first)
                writeEnvelope(enrollment.envelopeJson)
                AureliaSecurityRuntime.markEnrolled()
                showRecoveryKey(enrollment.recoveryKey)
            } else {
                val envelope = readEnvelope()
                if (manager.unlock(first, envelope)) {
                    if (envelopeStore.hasPreviousEnvelope()) envelopeStore.confirmRecoveryPinUnlock()
                    AureliaSecurityRuntime.markEnrolled()
                    if (JSONObject(envelope).has("recovery")) {
                        continueAfterPinUnlock()
                    } else {
                        val migrated = manager.enableRecoveryKey(first, envelope)
                        writeEnvelope(migrated.envelopeJson)
                        showRecoveryKey(migrated.recoveryKey)
                    }
                } else showError("Incorrect PIN.")
            }
        } catch (failure: SecurityException) {
            showError(failure.message ?: "Security verification failed.")
        } catch (failure: Exception) {
            showError("Secure storage is unavailable. PMS access is blocked.")
        } finally {
            first.fill('\u0000')
            second?.fill('\u0000')
            pinField?.text?.clear()
            confirmField?.text?.clear()
        }
    }

    private fun showRecoveryKey(recoveryKey: CharArray) {
        val code = TextView(this).apply {
            text = String(recoveryKey)
            textSize = 18f
            gravity = Gravity.CENTER
            setTextIsSelectable(false)
            setPadding(24, 20, 24, 20)
        }
        AlertDialog.Builder(this)
            .setTitle("Save your recovery key")
            .setMessage("This 256-bit recovery key is shown once in checksummed Base32. Write it down and store it offline. You must confirm selected groups. Anyone with this key and your encrypted backup can recover the database.")
            .setView(code)
            .setPositiveButton("I saved it") { _, _ ->
                code.text = ""
                confirmRecoveryKeySaved(recoveryKey)
            }
            .setCancelable(false)
            .show()
    }

    private fun confirmRecoveryKeySaved(recoveryKey: CharArray) {
        val groups = String(recoveryKey).split("-")
        if (groups.size != 9) {
            recoveryKey.fill('\u0000')
            showError("Recovery-key formatting failed. Do not continue enrollment.")
            return
        }
        val selected = (0 until groups.size).toMutableList().also { java.util.Collections.shuffle(it, java.security.SecureRandom()) }.take(3).sorted()
        val input = EditText(this).apply {
            hint = "Enter the three requested groups"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
            filters = arrayOf(android.text.InputFilter.LengthFilter(20))
        }
        val prompt = "Re-enter groups " + selected.joinToString(", ") { (it + 1).toString() } + " in order."
        AlertDialog.Builder(this)
            .setTitle("Confirm recovery-key backup")
            .setMessage(prompt)
            .setView(input)
            .setPositiveButton("Confirm") { _, _ ->
                val entered = input.text.toString().filterNot { it == '-' || it.isWhitespace() }.uppercase()
                val expected = selected.joinToString("") { groups[it] }
                input.text.clear()
                if (entered == expected) {
                    recoveryKey.fill('\u0000')
                    offerBiometricEnrollment()
                } else {
                    showError("Recovery-key confirmation did not match. Enrollment remains blocked.")
                    confirmRecoveryKeySaved(recoveryKey)
                }
            }
            .setNegativeButton("Cancel") { _, _ ->
                recoveryKey.fill('\u0000')
                showError("Save and verify your recovery key before using the PMS.")
                finish()
            }
            .setCancelable(false)
            .show()
    }

    private fun continueAfterPinUnlock() {
        if (!biometricStore.exists()) {
            offerBiometricEnrollment()
            return
        }
        try {
            val wrapped = biometricStore.read()
            if (biometricVault.isKeyInvalidated(wrapped.nonce)) {
                biometricStore.delete()
                biometricVault.replaceInvalidatedKeyAfterPinAuthorization()
                offerBiometricEnrollment()
            } else {
                openPms()
            }
            wrapped.nonce.fill(0)
            wrapped.ciphertext.fill(0)
        } catch (_: Exception) {
            // PIN is already authenticated. A corrupt or invalidated biometric
            // wrapper may be replaced without changing the database DEK.
            biometricStore.delete()
            try {
                biometricVault.replaceInvalidatedKeyAfterPinAuthorization()
                offerBiometricEnrollment()
            } catch (_: Exception) {
                showError("Biometric re-enrollment is unavailable. PIN access remains valid.")
                openPms()
            }
        }
    }

    private fun offerBiometricEnrollment() {
        if (!biometricVault.isStrongBiometricAvailable(this)) {
            openPms()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Enable biometric unlock?")
            .setMessage("Biometrics will wrap the same database key as your PIN. PIN and recovery remain available.")
            .setPositiveButton("Enable") { _, _ -> enrollBiometrics() }
            .setNegativeButton("Not now") { _, _ -> openPms() }
            .setCancelable(false)
            .show()
    }

    private fun enrollBiometrics() {
        try {
            // The caller has just authenticated with PIN/recovery; replace an invalidated alias safely.
            biometricVault.replaceInvalidatedKeyAfterPinAuthorization()
            val cryptoObject = biometricVault.prepareEncryptOperation()
            val prompt = BiometricPrompt(
                this,
                ContextCompat.getMainExecutor(this),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val dek = manager.currentDataKeyCopy()
                        try {
                            val wrapped = biometricVault.encryptAfterAuthentication(
                                result.cryptoObject ?: cryptoObject, dek
                            )
                            biometricStore.write(wrapped)
                            wrapped.nonce.fill(0)
                            wrapped.ciphertext.fill(0)
                            openPms()
                        } catch (failure: Exception) {
                            showError(failure.message ?: "Biometric enrollment failed.")
                            openPms()
                        } finally {
                            dek.fill(0)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        showError(errString.toString())
                        openPms()
                    }
                }
            )
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Enable Aurelia biometric unlock")
                    .setSubtitle("Wrap the existing database key")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButtonText("Skip")
                    .build(),
                cryptoObject
            )
        } catch (failure: Exception) {
            showError(failure.message ?: "Biometric unlock is unavailable.")
            openPms()
        }
    }

    private fun unlockWithBiometrics() {
        val wrapped = try { biometricStore.read() } catch (failure: Exception) {
            showError("Biometric wrapper is damaged. Unlock with PIN to recover it.")
            return
        }
        try {
            val cryptoObject = biometricVault.prepareDecryptOperation(wrapped.nonce)
            val prompt = BiometricPrompt(
                this,
                ContextCompat.getMainExecutor(this),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        try {
                            val unwrapped = biometricVault.decryptAfterAuthentication(
                                result.cryptoObject ?: cryptoObject, wrapped.ciphertext
                            )
                            try {
                                manager.unlockWithDataKey(unwrapped)
                                openPms()
                            } finally {
                                unwrapped.fill(0)
                            }
                        } catch (failure: Exception) {
                            if (failure is javax.crypto.AEADBadTagException) biometricStore.delete()
                            showError(failure.message ?: "Biometric key authentication failed.")
                        } finally {
                            wrapped.nonce.fill(0)
                            wrapped.ciphertext.fill(0)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        showError(errString.toString() + ". Use your PIN if biometric authentication is unavailable.")
                        wrapped.nonce.fill(0)
                        wrapped.ciphertext.fill(0)
                    }
                }
            )
            prompt.authenticate(
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock Aurelia PMS")
                    .setSubtitle("Authenticate to unwrap the existing database key")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .setNegativeButtonText("Use PIN")
                    .build(),
                cryptoObject
            )
        } catch (failure: android.security.keystore.KeyPermanentlyInvalidatedException) {
            wrapped.nonce.fill(0)
            wrapped.ciphertext.fill(0)
            showError("Biometric enrollment changed. Unlock with PIN to re-wrap the same database key.")
        } catch (failure: Exception) {
            wrapped.nonce.fill(0)
            wrapped.ciphertext.fill(0)
            showError(failure.message ?: "Biometric unlock is unavailable. Use your PIN.")
        }
    }

    private fun showRecoveryPrompt() {
        val recovery = EditText(this).apply {
            hint = "54-character Base32 recovery key"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            filters = arrayOf(android.text.InputFilter.LengthFilter(62))
        }
        val newPin = EditText(this).apply {
            hint = "New 6–16 digit PIN"
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(android.text.InputFilter.LengthFilter(16))
        }
        val confirm = EditText(this).apply {
            hint = "Confirm new PIN"
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            filters = arrayOf(android.text.InputFilter.LengthFilter(16))
        }
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 8, 32, 0)
            addView(recovery)
            addView(newPin)
            addView(confirm)
        }
        AlertDialog.Builder(this)
            .setTitle("Recover and reset PIN")
            .setMessage("Enter the offline recovery key and choose a new PIN. The database DEK is not regenerated.")
            .setView(form)
            .setPositiveButton("Recover") { _, _ ->
                val recoveryChars = CharArray(recovery.text.length).also { recovery.text.getChars(0, recovery.text.length, it, 0) }
                val newPinChars = CharArray(newPin.text.length).also { newPin.text.getChars(0, newPin.text.length, it, 0) }
                val confirmChars = CharArray(confirm.text.length).also { confirm.text.getChars(0, confirm.text.length, it, 0) }
                try {
                    if (newPinChars.size !in 6..16 || newPinChars.any { it !in '0'..'9' } ||
                        !newPinChars.contentEquals(confirmChars)) {
                        showError("New PIN must be 6–16 digits, avoid repeated/sequential digits, and match confirmation.")
                        return@setPositiveButton
                    }
                    val replacement = manager.recoverWithRecoveryKey(recoveryChars, newPinChars, readEnvelope())
                    envelopeStore.writeRecoveryReplacement(replacement)
                    biometricStore.delete()
                    AureliaSecurityRuntime.markEnrolled()
                    manager.lock()
                    showError("PIN recovered. Biometrics were disabled; unlock with your new PIN to continue.")
                    render()
                } catch (failure: Exception) {
                    showError(failure.message ?: "Recovery verification failed.")
                } finally {
                    recoveryChars.fill('\u0000')
                    newPinChars.fill('\u0000')
                    confirmChars.fill('\u0000')
                    recovery.text.clear()
                    newPin.text.clear()
                    confirm.text.clear()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun encryptedDatabaseExists(): Boolean {
        val databaseFile = getDatabasePath("aurelia-pms-encrypted.db")
        return databaseFile.exists() ||
            java.io.File(databaseFile.path + "-wal").exists() ||
            java.io.File(databaseFile.path + "-shm").exists()
    }

    private fun writeEnvelope(value: String) = envelopeStore.write(value)

    private fun readEnvelope(): String = envelopeStore.read()

    private fun openPms() {
        startActivity(Intent(this, MainActivity::class.java))
        // Keep the native gate as the task root. If Android kills the process,
        // task restoration returns through this gate rather than trusting a
        // restored WebView activity as the app entry point.
    }

    private fun showError(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    override fun onBackPressed() {
        // Launcher is the only entry path; back exits instead of bypassing the gate.
        super.onBackPressed()
    }
}
