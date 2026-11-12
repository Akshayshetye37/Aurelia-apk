package com.aurelia.pms.identity

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import com.aurelia.pms.security.RecoveryDeviceIdentity
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging

/** Explicit Settings workflow; Hotel Identity fields never call this activity. */
class RecoveryPhoneSettingsActivity : FragmentActivity() {
    private lateinit var store: RecoveryPhoneStore
    private lateinit var identity: FirebasePhoneIdentity
    private lateinit var client: RecoveryGrantClient
    private lateinit var status: TextView
    private lateinit var phone: EditText
    private var candidate = ""
    private var stage = Stage.NEW
    private var oldPhoneToken: String? = null
    private enum class Stage { OLD, NEW }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE)
        try {
            store = RecoveryPhoneStore(this)
            client = RecoveryGrantClient(this)
            identity = FirebasePhoneIdentity(RecoveryFirebaseAuthFactory.create(this)) { state ->
                runOnUiThread { onPhoneState(state) }
            }
            render()
        } catch (failure: Exception) {
            status = TextView(this)
            status.text = "Recovery phone setup unavailable: ${failure.message}"
            setContentView(status)
        }
    }

    private fun render() {
        val record = store.read()
        status = TextView(this).apply {
            text = when (record.state) {
                RecoveryPhoneStore.State.UNSET -> "Recovery phone not set. Your offline recovery key remains available."
                RecoveryPhoneStore.State.UNVERIFIED -> "Phone verification was not completed."
                RecoveryPhoneStore.State.VERIFIED -> "Verified recovery phone: ${record.maskedCurrent()}"
                RecoveryPhoneStore.State.CHANGE_PENDING -> "Current: ${record.maskedCurrent()}\nPending: ${record.pendingE164?.let { mask(it) }}\nChange activates after the 48-hour security delay."
            }
            setTextColor(android.graphics.Color.WHITE)
            textSize = 16f
            setPadding(0, 0, 0, 20)
        }
        phone = EditText(this).apply {
            hint = "Recovery phone number (+country code)"
            inputType = InputType.TYPE_CLASS_PHONE
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.GRAY)
        }
        val button = Button(this).apply {
            text = if (record.currentE164 == null) "Use as recovery number" else "Change recovery number"
            setOnClickListener { beginRegistration() }
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 48, 32, 48)
            setBackgroundColor(android.graphics.Color.rgb(5, 17, 13))
            addView(TextView(this@RecoveryPhoneSettingsActivity).apply {
                text = "Recovery phone security"
                textSize = 23f
                setTextColor(android.graphics.Color.WHITE)
            })
            addView(status)
            addView(phone, LinearLayout.LayoutParams(-1, -2))
            addView(button, LinearLayout.LayoutParams(-1, -2))
            addView(Button(this@RecoveryPhoneSettingsActivity).apply {
                text = "Close"
                setOnClickListener { finish() }
            })
        }
        setContentView(root)
    }

    private fun beginRegistration() {
        candidate = phone.text.toString().trim()
        if (!candidate.matches(Regex("^\\+[1-9][0-9]{7,14}$"))) {
            status.text = "Enter a valid E.164 number, including its country code."
            return
        }
        val record = store.read()
        if (record.state == RecoveryPhoneStore.State.CHANGE_PENDING) {
            status.text = "A recovery phone change is already pending. Wait for the security delay or contact support."
            return
        }
        oldPhoneToken = null
        if (record.currentE164 != null && record.currentE164 != candidate) {
            stage = Stage.OLD
            status.text = "First verify your existing recovery number ${record.maskedCurrent()}."
            identity.requestOtp(record.currentE164, this)
        } else {
            stage = Stage.NEW
            status.text = "Sending a verification code to ${mask(candidate)}…"
            identity.requestOtp(candidate, this)
        }
    }

    private fun onPhoneState(state: PhoneIdentityState) {
        when (state) {
            PhoneIdentityState.Requesting -> Unit
            PhoneIdentityState.CodeSent -> promptForCode()
            PhoneIdentityState.AutoRetrievalTimedOut -> if (!isFinishing) promptForCode()
            PhoneIdentityState.Verifying -> status.text = "Verifying phone ownership…"
            is PhoneIdentityState.Failed -> status.text = "Phone verification failed: ${state.reason}. Try again."
            is PhoneIdentityState.IdentityVerified -> {
                if (stage == Stage.OLD) {
                    oldPhoneToken = state.firebaseIdToken
                    stage = Stage.NEW
                    status.text = "Existing number verified. Sending a code to the new number…"
                    identity.requestOtp(candidate, this)
                } else {
                    registerNewPhone(state.firebaseIdToken)
                }
            }
            PhoneIdentityState.Idle -> Unit
        }
    }

    private fun promptForCode() {
        if (isFinishing) return
        val code = EditText(this).apply {
            hint = "6-digit SMS code"
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(android.text.InputFilter.LengthFilter(6))
        }
        AlertDialog.Builder(this)
            .setTitle("Verify recovery phone")
            .setMessage("Enter the code sent to the selected recovery number.")
            .setView(code)
            .setPositiveButton("Verify") { _, _ -> identity.submitOtp(code.text.toString().trim()) }
            .setNegativeButton("Cancel") { _, _ -> identity.reset(); status.text = "Verification cancelled." }
            .setCancelable(false)
            .show()
    }

    private fun registerNewPhone(newPhoneToken: String) {
        status.text = "Checking authenticated property-owner identity…"
        RecoveryTenantIdentity.bindAuthorizedOwner(this).addOnCompleteListener { tenantTask ->
            runOnUiThread {
                if (!tenantTask.isSuccessful) {
                    status.text = "Recovery phone setup requires a recently authenticated property-owner account with a tenant binding."
                    return@runOnUiThread
                }
                val tenant = tenantTask.result
                val deviceHash = try { RecoveryDeviceIdentity.deviceIdHash() } catch (_: Exception) {
                    status.text = "Secure device binding is unavailable."
                    return@runOnUiThread
                }
                status.text = "Registering owner security notifications…"
                FirebaseMessaging.getInstance().token.addOnCompleteListener { tokenTask ->
                    runOnUiThread {
                        if (!tokenTask.isSuccessful || tokenTask.result.isNullOrBlank()) {
                            status.text = "Owner security notifications are unavailable. Recovery phone registration is blocked."
                            return@runOnUiThread
                        }
                        client.registerOwnerNotificationDevice(tenant, deviceHash, tokenTask.result)
                            .addOnCompleteListener { notificationTask ->
                                runOnUiThread {
                                    if (!notificationTask.isSuccessful || notificationTask.result != true) {
                                        status.text = "Could not register owner security notifications. Recovery phone registration is blocked."
                                        return@runOnUiThread
                                    }
                                    persistRecoveryPhone(newPhoneToken, tenant, deviceHash)
                                }
                            }
                    }
                }
            }
        }
    }

    private fun persistRecoveryPhone(newPhoneToken: String, tenant: String, deviceHash: String) {
        status.text = "Saving verified recovery phone…"
        try {
            if (store.read().currentE164 == null) store.markUnverified(candidate)
        } catch (_: Exception) {
            status.text = "Could not stage recovery-phone policy safely."
            return
        }
        client.registerRecoveryPhone(newPhoneToken, tenant, deviceHash, oldPhoneToken)
            .addOnCompleteListener { task ->
                runOnUiThread {
                    if (!task.isSuccessful) {
                        status.text = "Could not register recovery phone. Verify owner access and phone proof, then try again."
                        return@runOnUiThread
                    }
                    val serverState = (task.result?.get("state") as? String) ?: "UNSET"
                    try {
                        val record = store.read()
                        if (record.currentE164 == null || record.currentE164 == candidate) {
                            store.markVerified(candidate)
                        } else if (serverState == "CHANGE_PENDING") {
                            store.requestChange(candidate)
                        }
                        status.text = if (serverState == "CHANGE_PENDING") {
                            "New number verified. The old number remains active for 48 hours."
                        } else {
                            "Recovery phone verified: ${mask(candidate)}"
                        }
                        phone.text.clear()
                    } catch (_: Exception) {
                        status.text = "Server accepted verification, but local state could not be saved."
                    }
                }
            }
    }

    private fun mask(value: String): String {
        val digits = value.filter(Char::isDigit)
        return "+" + digits.take(2) + " " + "•".repeat((digits.length - 5).coerceAtLeast(0)) + digits.takeLast(3)
    }
}
