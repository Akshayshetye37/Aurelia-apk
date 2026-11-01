package com.aurelia.pms.security

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.util.AtomicFile
import com.aurelia.pms.MainActivity
import java.io.File

/**
 * Exported launcher boundary. This Activity contains no WebView and starts the
 * PMS BridgeActivity only after a PIN envelope has been authenticated/enrolled.
 *
 * This is a first native gate, not a claim that a compromised/rooted OS is safe.
 */
class LockGateActivity : Activity() {
    private lateinit var manager: AureliaAppManager
    private lateinit var envelopeFile: AtomicFile
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
        envelopeFile = AtomicFile(File(noBackupFilesDir, "aurelia-pin-envelope.v2"))
        val enrolled = AureliaSecurityRuntime.isEnrolled()
        val envelopeExists = envelopeFile.baseFile.exists() ||
            File(envelopeFile.baseFile.path + ".bak").exists()
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
            text = if (enrollmentMode) "Create a 6–12 digit PIN. Keep it private." else "Enter your PIN to open the PMS."
            textSize = 14f
            setTextColor(android.graphics.Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 24)
        }
        root.addView(hint)
        pinField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = if (enrollmentMode) "New PIN" else "PIN"
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.GRAY)
            filters = arrayOf(android.text.InputFilter.LengthFilter(12))
        }
        root.addView(pinField, LinearLayout.LayoutParams(-1, -2))
        if (enrollmentMode) {
            confirmField = EditText(this).apply {
                inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
                hint = "Confirm PIN"
                setTextColor(android.graphics.Color.WHITE)
                setHintTextColor(android.graphics.Color.GRAY)
                filters = arrayOf(android.text.InputFilter.LengthFilter(12))
            }
            root.addView(confirmField, LinearLayout.LayoutParams(-1, -2))
        }
        val button = Button(this).apply {
            text = if (enrollmentMode) "Create secure PIN" else "Unlock"
            setOnClickListener { submit() }
        }
        root.addView(button, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 24 })
        setContentView(root)
    }

    private fun submit() {
        val first = pinField?.text?.toString()?.toCharArray() ?: return
        val second = confirmField?.text?.toString()?.toCharArray()
        try {
            if (first.size !in 6..12 || first.any { it !in '0'..'9' }) {
                showError("PIN must be 6–12 digits.")
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
                openPms()
            } else {
                val envelope = readEnvelope()
                if (manager.unlock(first, envelope)) openPms()
                else showError("Incorrect PIN.")
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

    private fun writeEnvelope(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        var stream: java.io.FileOutputStream? = null
        try {
            stream = envelopeFile.startWrite()
            stream.write(bytes)
            stream.fd.sync()
            envelopeFile.finishWrite(stream)
        } catch (failure: Exception) {
            if (stream != null) envelopeFile.failWrite(stream)
            throw failure
        } finally {
            bytes.fill(0)
        }
    }

    private fun readEnvelope(): String {
        val bytes = envelopeFile.openRead().use { it.readBytes() }
        try {
            require(bytes.size in 1..4096) { "Invalid PIN envelope file." }
            return String(bytes, Charsets.UTF_8)
        } finally {
            bytes.fill(0)
        }
    }

    private fun openPms() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    private fun showError(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    override fun onBackPressed() {
        // Launcher is the only entry path; back exits instead of bypassing the gate.
        super.onBackPressed()
    }
}
