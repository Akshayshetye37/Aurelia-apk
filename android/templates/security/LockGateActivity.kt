package com.aurelia.pms.security

import android.app.Activity
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
import android.widget.Toast
import com.aurelia.pms.MainActivity

/**
 * Exported launcher boundary. This Activity contains no WebView and starts the
 * PMS BridgeActivity only after a PIN envelope has been authenticated/enrolled.
 *
 * This is a first native gate, not a claim that a compromised/rooted OS is safe.
 */
class LockGateActivity : Activity() {
    private lateinit var manager: AureliaAppManager
    private lateinit var envelopeStore: AureliaEnvelopeStore
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
        val enrolled = AureliaSecurityRuntime.isEnrolled()
        val envelopeExists = envelopeStore.exists()
        val databaseExists = encryptedDatabaseExists()
        if (databaseExists && (!enrolled || !envelopeExists)) {
            throw SecurityException("Encrypted PMS database exists but its key envelope is missing; data recovery is required.")
        }
        if (enrolled != envelopeExists) {
            throw SecurityException("PIN enrollment state is inconsistent; refusing setup or unlock.")
        }
        enrollmentMode = !enrolled
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
            text = if (enrollmentMode) "Create a 4–16 digit PIN. Keep it private." else "Enter your PIN to open the PMS."
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
                // Must match the primary PIN field and the 4–16 digit security engine.
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
            if (first.size !in 4..16 || first.any { it !in '0'..'9' }) {
                showError("PIN must be 4–16 digits.")
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
                    if (JSONObject(envelope).has("recovery")) {
                        openPms()
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
            setTextIsSelectable(true)
            setPadding(24, 20, 24, 20)
        }
        AlertDialog.Builder(this)
            .setTitle("Save your recovery key")
            .setMessage("This 256-bit recovery key is shown once. Write it down and store it offline. Anyone with this key and your encrypted backup can recover the database.")
            .setView(code)
            .setPositiveButton("I saved it") { _, _ ->
                code.text = ""
                recoveryKey.fill('\u0000')
                openPms()
            }
            .setCancelable(false)
            .show()
    }

    private fun showRecoveryPrompt() {
        val recovery = EditText(this).apply {
            hint = "43-character recovery key"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            filters = arrayOf(android.text.InputFilter.LengthFilter(48))
        }
        val newPin = EditText(this).apply {
            hint = "New 4–16 digit PIN"
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
                    if (newPinChars.size !in 4..16 || newPinChars.any { it !in '0'..'9' } ||
                        !newPinChars.contentEquals(confirmChars)) {
                        showError("New PIN must be 4–16 digits and match its confirmation.")
                        return@setPositiveButton
                    }
                    val replacement = manager.recoverWithRecoveryKey(recoveryChars, newPinChars, readEnvelope())
                    writeEnvelope(replacement)
                    openPms()
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
