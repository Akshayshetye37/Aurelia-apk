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
import com.aurelia.pms.identity.FirebasePhoneIdentity
import com.aurelia.pms.identity.PhoneIdentityState
import com.aurelia.pms.identity.RecoveryFirebaseAuthFactory
import com.aurelia.pms.identity.RecoveryGrantClient
import com.aurelia.pms.identity.RecoveryPhoneStore
import com.aurelia.pms.identity.RecoveryTenantIdentity

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
    private var recoveryPhoneIdentity: FirebasePhoneIdentity? = null
    private var recoveryOtpDialogShown = false
    @Volatile private var recoveryFlowActive = false

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
        if ((databaseExists || enrolled) && !envelopeExists && !biometricStore.exists()) {
            showUnrecoverableState()
            return
        }
        // The authenticated envelope is authoritative. A missing marker can be
        // restored only after PIN/recovery unlock, never by creating a new DEK.
        enrollmentMode = !envelopeExists && !databaseExists && !enrolled && !biometricStore.exists()
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
            if (first.size !in (if (enrollmentMode) 6..16 else 4..16) || first.any { it !in '0'..'9' }) {
                showError(if (enrollmentMode) "New PIN must contain 6–16 digits." else "Enter your existing PIN.")
                return
            }
            if (enrollmentMode) {
                if (second == null || !first.contentEquals(second)) {
                    showError("PIN confirmation does not match.")
                    return
                }
                val enrollment = manager.enroll(first)
                showRecoveryKey(enrollment.recoveryKey) {
                    writeEnvelope(enrollment.envelopeJson)
                    AureliaSecurityRuntime.markEnrolled()
                }
            } else {
                val envelope = readEnvelope()
                if (manager.unlock(first, envelope)) {
                    if (envelopeStore.hasPreviousEnvelope()) envelopeStore.confirmRecoveryPinUnlock()
                    AureliaSecurityRuntime.markEnrolled()
                    if (first.size < 6) {
                        showMandatoryPinUpgrade(first, envelope)
                    } else if (JSONObject(envelope).has("recovery")) {
                        continueAfterPinUnlock()
                    } else {
                        val migrated = manager.enableRecoveryKey(first, envelope)
                        showRecoveryKey(migrated.recoveryKey) {
                            writeEnvelope(migrated.envelopeJson)
                        }
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

    private fun showMandatoryPinUpgrade(currentPin: CharArray, currentEnvelope: String) {
        val current = currentPin.copyOf()
        val next = EditText(this).apply {
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
            addView(next)
            addView(confirm)
        }
        AlertDialog.Builder(this)
            .setTitle("Upgrade your PIN")
            .setMessage("Your existing PIN is still accepted to preserve access. Set a stronger 6–16 digit PIN before opening Aurelia.")
            .setView(form)
            .setPositiveButton("Update PIN") { _, _ ->
                val newPin = CharArray(next.text.length).also { next.text.getChars(0, next.text.length, it, 0) }
                val repeated = CharArray(confirm.text.length).also { confirm.text.getChars(0, confirm.text.length, it, 0) }
                try {
                    if (!newPin.contentEquals(repeated)) {
                        showError("PIN confirmation does not match.")
                        showMandatoryPinUpgrade(current, currentEnvelope)
                        return@setPositiveButton
                    }
                    val replacement = manager.changePin(current, newPin, currentEnvelope)
                    envelopeStore.write(replacement)
                    manager.lock()
                    render()
                } catch (failure: Exception) {
                    showError(failure.message ?: "PIN upgrade failed.")
                    showMandatoryPinUpgrade(current, currentEnvelope)
                } finally {
                    newPin.fill('\u0000')
                    repeated.fill('\u0000')
                    next.text.clear()
                    confirm.text.clear()
                    current.fill('\u0000')
                }
            }
            .setNegativeButton("Exit") { _, _ ->
                current.fill('\u0000')
                manager.lock()
                finish()
            }
            .setCancelable(false)
            .show()
    }

    private fun showRecoveryKey(recoveryKey: CharArray, onConfirmed: () -> Unit) {
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
                confirmRecoveryKeySaved(recoveryKey, onConfirmed)
            }
            .setCancelable(false)
            .show()
    }

    private fun confirmRecoveryKeySaved(recoveryKey: CharArray, onConfirmed: () -> Unit) {
        val groups = String(recoveryKey).split("-")
        if (groups.size != 9) {
            recoveryKey.fill('\u0000')
            manager.lock()
            showError("Recovery-key formatting failed. Do not continue enrollment.")
            finish()
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
                    try {
                        onConfirmed()
                        recoveryKey.fill('\u0000')
                        offerBiometricEnrollment()
                    } catch (failure: Exception) {
                        recoveryKey.fill('\u0000')
                        manager.lock()
                        showError(failure.message ?: "Could not persist the confirmed recovery key.")
                        finish()
                    }
                } else {
                    showError("Recovery-key confirmation did not match. Enrollment remains blocked.")
                    confirmRecoveryKeySaved(recoveryKey, onConfirmed)
                }
            }
            .setNegativeButton("Cancel") { _, _ ->
                recoveryKey.fill('\u0000')
                manager.lock()
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

    private fun showUnrecoverableState() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 48, 32, 48)
            setBackgroundColor(android.graphics.Color.rgb(5, 17, 13))
        }
        root.addView(TextView(this).apply {
            text = "Aurelia data cannot be unlocked"
            textSize = 23f
            setTextColor(android.graphics.Color.WHITE)
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = "Enrollment or encrypted data exists, but no PIN/recovery envelope or usable biometric wrapper is available. No replacement key will be generated. If you have no usable unlock method, the only remaining option is an irreversible local-data reset."
            textSize = 14f
            setTextColor(android.graphics.Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, 20, 0, 24)
        })
        root.addView(Button(this).apply {
            text = "Destructive reset"
            setOnClickListener { showDestructiveResetPrompt() }
        })
        setContentView(root)
    }

    private fun showDestructiveResetPrompt() {
        val confirmation = EditText(this).apply {
            hint = "Type RESET AURELIA DATA"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        AlertDialog.Builder(this)
            .setTitle("Permanently erase local Aurelia data?")
            .setMessage("This permanently deletes the encrypted PMS database, its local photo archive, PIN/recovery envelopes and biometric wrapper on this device. It cannot recover data and does not delete owner-held external backups. Type the exact phrase to continue.")
            .setView(confirmation)
            .setPositiveButton("Erase local data") { _, _ ->
                if (confirmation.text.toString() != "RESET AURELIA DATA") {
                    showError("Confirmation phrase did not match. No data was deleted.")
                    return@setPositiveButton
                }
                try {
                    manager.lock()
                    val database = getDatabasePath("aurelia-pms-encrypted.db")
                    val files = listOf(
                        database,
                        java.io.File(database.path + "-wal"),
                        java.io.File(database.path + "-shm"),
                        java.io.File(database.path + "-journal")
                    )
                    files.forEach { if (it.exists() && !it.delete()) throw SecurityException("Could not delete encrypted database files.") }
                    val photos = java.io.File(filesDir, "aurelia_photo_archive")
                    if (photos.exists() && !photos.deleteRecursively()) throw SecurityException("Could not delete local photo archive.")
                    envelopeStore.delete()
                    biometricStore.delete()
                    AureliaSecurityRuntime.clearEnrollmentMarkerForConfirmedDestructiveReset()
                    enrollmentMode = true
                    render()
                } catch (failure: Exception) {
                    showError(failure.message ?: "Destructive reset failed. Data remains unavailable.")
                } finally {
                    confirmation.text.clear()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showRecoveryPrompt() {
        try {
            val record = RecoveryPhoneStore(this).read()
            if (record.state == RecoveryPhoneStore.State.UNSET) {
                showRecoveryKeyPrompt()
                return
            }
            if (record.state == RecoveryPhoneStore.State.UNVERIFIED) {
                showError("Recovery phone setup is incomplete. Finish phone verification in Settings before using Forgot PIN.")
                return
            }
            if (record.otpRequired && record.currentE164 == null) {
                showError("Recovery phone policy is incomplete. Recovery is blocked until the registered phone is verified.")
                return
            }
            if (!record.otpRequired) {
                showRecoveryKeyPrompt()
                return
            }
            beginRecoveryOtp(record.currentE164 ?: throw SecurityException("Verified recovery phone is missing."))
        } catch (failure: Exception) {
            showError("Recovery phone policy could not be verified. Recovery is blocked: ${failure.message}")
        }
    }

    /** Only the encrypted, previously verified E.164 is used; no phone input exists here. */
    private fun beginRecoveryOtp(trustedPhone: String) {
        try {
            recoveryFlowActive = true
            recoveryOtpDialogShown = false
            val auth = RecoveryFirebaseAuthFactory.create(this)
            lateinit var identity: FirebasePhoneIdentity
            identity = FirebasePhoneIdentity(auth) { state ->
                runOnUiThread {
                    if (!recoveryFlowActive || isFinishing) {
                        RecoveryGate.clear()
                        return@runOnUiThread
                    }
                    when (state) {
                        PhoneIdentityState.Requesting -> showError("Sending OTP to your registered recovery number…")
                        PhoneIdentityState.CodeSent,
                        PhoneIdentityState.AutoRetrievalTimedOut -> promptForRecoveryOtp(identity)
                        PhoneIdentityState.Verifying -> Unit
                        is PhoneIdentityState.IdentityVerified -> {
                            try {
                                val tenant = RecoveryTenantIdentity.getOrCreate(this)
                                val client = RecoveryGrantClient(this)
                                val grantRequest = client.issueRecoveryGrant(state.firebaseIdToken, tenant)
                                grantRequest.task.addOnCompleteListener { task ->
                                    if (!task.isSuccessful) {
                                        recoveryFlowActive = false
                                        identity.reset()
                                        RecoveryGate.clear()
                                        showError("OTP was verified, but recovery authorization failed. Request a fresh OTP.")
                                        return@addOnCompleteListener
                                    }
                                    when (val outcome = task.result) {
                                        is RecoveryGrantClient.GrantIssueResult.Cooldown -> {
                                            recoveryFlowActive = false
                                            identity.reset()
                                            RecoveryGate.clear()
                                            if (outcome.awaitingOwnerAlert) {
                                                showError("Recovery is blocked until a registered owner device posts and acknowledges the security alert. The 24-hour hold has not started yet.")
                                            } else {
                                                showError("For account safety, recovery is on a 24-hour hold after the owner alert was acknowledged. After the hold, tap Forgot PIN and verify a fresh SMS code.")
                                            }
                                        }
                                        is RecoveryGrantClient.GrantIssueResult.Issued -> {
                                            client.consumeAndArm(outcome.grant, grantRequest.nonce, grantRequest.deviceIdHash, tenant, grantRequest.startedAtElapsedMs) { armed ->
                                                runOnUiThread {
                                                    if (!recoveryFlowActive || isFinishing) {
                                                        RecoveryGate.clear()
                                                        return@runOnUiThread
                                                    }
                                                    if (armed && RecoveryGate.isOpen()) showRecoveryKeyPrompt()
                                                    else showError("Recovery authorization expired or was already used. Request a fresh OTP.")
                                                }
                                            }
                                        }
                                    }
                                }
                            } catch (failure: Exception) {
                                RecoveryGate.clear()
                                showError("Recovery tenant binding must be re-verified by the property owner in Settings: ${failure.message}")
                            }
                        }
                        is PhoneIdentityState.Failed -> {
                            recoveryOtpDialogShown = false
                            showError("Recovery OTP failed: ${state.reason}. Request a new code.")
                        }
                        PhoneIdentityState.Idle -> Unit
                    }
                }
            }
            recoveryPhoneIdentity = identity
            identity.requestOtp(trustedPhone, this)
        } catch (failure: Exception) {
            RecoveryGate.clear()
            showError("Recovery OTP is unavailable: ${failure.message}")
        }
    }

    private fun promptForRecoveryOtp(identity: FirebasePhoneIdentity) {
        if (recoveryOtpDialogShown || isFinishing) return
        recoveryOtpDialogShown = true
        val code = EditText(this).apply {
            hint = "6-digit SMS code"
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(android.text.InputFilter.LengthFilter(6))
        }
        AlertDialog.Builder(this)
            .setTitle("Verify recovery phone")
            .setMessage("Enter the code sent to your saved recovery number.")
            .setView(code)
            .setPositiveButton("Verify") { _, _ ->
                recoveryOtpDialogShown = false
                identity.submitOtp(code.text.toString().trim())
            }
            .setNegativeButton("Cancel") { _, _ ->
                recoveryOtpDialogShown = false
                recoveryFlowActive = false
                identity.reset()
                RecoveryGate.clear()
            }
            .setOnCancelListener {
                recoveryOtpDialogShown = false
                recoveryFlowActive = false
                identity.reset()
                RecoveryGate.clear()
            }
            .setCancelable(false)
            .show()
    }

    /** This is the only path that renders the offline recovery-key input. */
    private fun showRecoveryKeyPrompt() {
        val record = RecoveryPhoneStore(this).read()
        if (record.state == RecoveryPhoneStore.State.UNVERIFIED ||
            (record.state != RecoveryPhoneStore.State.UNSET &&
                record.otpRequired && record.currentE164 == null)) {
            showError("Recovery phone setup is incomplete. Recovery is blocked until the registered phone is verified.")
            return
        }
        if (record.otpRequired && record.currentE164 != null && !RecoveryGate.isOpen()) {
            showError("Verify the registered recovery phone before entering the recovery key.")
            return
        }
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
            .setMessage("Your registered phone is verified. Enter your offline recovery key and choose a new PIN. One OTP authorizes up to three checksum-valid key attempts.")
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
                    // Revoke biometric access before committing the new PIN wrapper. If the
                    // process dies before the atomic envelope swap, old PIN/recovery still work.
                    biometricStore.delete()
                    biometricVault.invalidateAfterRecovery()
                    envelopeStore.writeRecoveryReplacement(replacement)
                    manager.confirmRecoverySwapCommitted()
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
            .setNegativeButton("Cancel") { _, _ -> RecoveryGate.clear() }
            .setNeutralButton("Destructive reset") { _, _ ->
                RecoveryGate.clear()
                showDestructiveResetPrompt()
            }
            .setOnCancelListener { RecoveryGate.clear() }
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

    override fun onUserLeaveHint() {
        // A user-initiated departure (Home/Recents) invalidates in-flight recovery.
        recoveryFlowActive = false
        recoveryOtpDialogShown = false
        recoveryPhoneIdentity?.reset()
        recoveryPhoneIdentity = null
        RecoveryGate.clear()
        super.onUserLeaveHint()
    }

    override fun onStop() {
        // Persist grant attempts across activity recreation and process death.
        // Explicit user departure still revokes the active grant.
        super.onStop()
    }

    override fun onBackPressed() {
        // Launcher is the only entry path; back exits instead of bypassing the gate.
        super.onBackPressed()
    }
}
