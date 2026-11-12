package com.aurelia.pms.identity

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import com.aurelia.pms.security.RecoveryDeviceIdentity
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.ActionCodeSettings
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions

class RecoveryOwnerAlertActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private lateinit var emailInput: EditText
    private lateinit var emailLinkInput: EditText
    private lateinit var acknowledgeButton: Button
    private lateinit var cancelButton: Button
    private var tenantId = ""
    private var deviceHash = ""
    private var eventId = ""
    private var ackToken = ""
    private var hasAlertContext = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!loadAlertContext(intent)) {
            val binding = runCatching { RecoveryTenantIdentity.getBinding(this) }.getOrNull()
            if (binding == null) {
                finish()
                return
            }
            tenantId = binding.tenantId
            deviceHash = runCatching { RecoveryDeviceIdentity.deviceIdHash() }.getOrElse {
                finish()
                return
            }
        }
        buildContent()
        intent.dataString?.let { emailLinkInput.setText(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadAlertContext(intent)
        intent.dataString?.let {
            emailLinkInput.setText(it)
            status.text = "Email sign-in link received. Enter the same owner email and complete sign-in."
        }
    }

    private fun loadAlertContext(source: Intent): Boolean {
        val incomingTenant = source.getStringExtra(EXTRA_TENANT_ID)
        val incomingDevice = source.getStringExtra(EXTRA_DEVICE_HASH)
        val incomingEvent = source.getStringExtra(EXTRA_EVENT_ID)
        val incomingToken = source.getStringExtra(EXTRA_ACK_TOKEN)
        if (incomingTenant.isNullOrBlank() && incomingDevice.isNullOrBlank() &&
            incomingEvent.isNullOrBlank() && incomingToken.isNullOrBlank()) return false
        if (incomingTenant.isNullOrBlank() || incomingDevice.isNullOrBlank() ||
            incomingEvent.isNullOrBlank() || incomingToken.isNullOrBlank()) return false
        val localDevice = runCatching { RecoveryDeviceIdentity.deviceIdHash() }.getOrNull()
        if (localDevice != incomingDevice) return false
        tenantId = incomingTenant
        deviceHash = incomingDevice
        eventId = incomingEvent
        ackToken = incomingToken
        hasAlertContext = true
        if (::acknowledgeButton.isInitialized) {
            acknowledgeButton.visibility = View.VISIBLE
            cancelButton.visibility = View.VISIBLE
        }
        return true
    }

    private fun buildContent() {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 32, 28, 24)
        }
        status = TextView(this).apply {
            text = if (hasAlertContext) {
                "A recovery request was made for this account. Verify the primary owner before acknowledging or cancelling."
            } else {
                "Complete primary-owner sign-in on this enrolled device, then reopen the recovery alert notification."
            }
            textSize = 16f
        }
        emailInput = EditText(this).apply {
            hint = "Primary owner's email address"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            singleLine = true
        }
        emailLinkInput = EditText(this).apply {
            hint = "Paste the email sign-in link here if the app did not open it automatically"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2
            maxLines = 4
        }
        root.addView(status)
        root.addView(emailInput)
        root.addView(Button(this).apply {
            text = "Send owner sign-in link"
            setOnClickListener { sendOwnerEmailLink() }
        })
        root.addView(emailLinkInput)
        root.addView(Button(this).apply {
            text = "Complete owner sign-in"
            setOnClickListener { completeOwnerEmailLink() }
        })
        acknowledgeButton = Button(this).apply {
            text = "Acknowledge alert and start 24-hour hold"
            visibility = if (hasAlertContext) View.VISIBLE else View.GONE
            setOnClickListener { acknowledge() }
        }
        cancelButton = Button(this).apply {
            text = "Cancel recovery request"
            visibility = if (hasAlertContext) View.VISIBLE else View.GONE
            setOnClickListener { cancelRequest() }
        }
        root.addView(acknowledgeButton)
        root.addView(cancelButton)
        root.addView(Button(this).apply {
            text = "Close"
            setOnClickListener { finish() }
        })
        scroll.addView(root)
        setContentView(scroll)
    }

    private fun sendOwnerEmailLink() {
        val email = emailInput.text.toString().trim()
        if (!email.matches(Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"))) {
            status.text = "Enter the primary owner's registered email address."
            return
        }
        val projectId = runCatching { FirebaseApp.getInstance().options.projectId }.getOrNull()
        if (projectId.isNullOrBlank()) {
            status.text = "Firebase is not configured. Local PIN and biometric unlock remain available."
            return
        }
        val settings = ActionCodeSettings.newBuilder()
            .setUrl("https://$projectId.firebaseapp.com")
            .setHandleCodeInApp(true)
            .setAndroidPackageName(packageName, true, null)
            .build()
        runCatching {
            FirebaseAuth.getInstance().sendSignInLinkToEmail(email, settings)
                .addOnCompleteListener { task ->
                    status.text = if (task.isSuccessful) {
                        "Owner sign-in link sent. Open it on this device, or paste the full link below."
                    } else {
                        "Could not send the owner sign-in link. Check the registered email and Firebase email-link configuration."
                    }
                }
        }.onFailure {
            status.text = "Owner email-link sign-in is unavailable. Recovery remains locked."
        }
    }

    private fun completeOwnerEmailLink() {
        val email = emailInput.text.toString().trim()
        val emailLink = emailLinkInput.text.toString().trim()
        if (!email.matches(Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")) || emailLink.isBlank()) {
            status.text = "Enter the same owner email and the complete email sign-in link."
            return
        }
        status.text = "Verifying the one-time owner email link..."
        runCatching {
            FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                .getHttpsCallable("exchangeOwnerEmailLink")
                .call(mapOf(
                    "tenantId" to tenantId,
                    "deviceIdHash" to deviceHash,
                    "email" to email,
                    "emailLink" to emailLink
                ))
                .addOnCompleteListener { exchange ->
                    if (!exchange.isSuccessful) {
                        status.text = "Owner email-link verification failed. The link may be expired, used, or belong to another owner."
                        return@addOnCompleteListener
                    }
                    val customToken = (exchange.result?.data as? Map<*, *>)?.get("customToken") as? String
                    if (customToken.isNullOrBlank()) {
                        status.text = "The owner verification response was invalid."
                        return@addOnCompleteListener
                    }
                    FirebaseAuth.getInstance().signInWithCustomToken(customToken)
                        .addOnCompleteListener { signIn ->
                            if (!signIn.isSuccessful) {
                                status.text = "The verified owner session could not be established."
                                return@addOnCompleteListener
                            }
                            signIn.result?.user?.getIdToken(true)?.addOnCompleteListener { token ->
                                status.text = if (token.isSuccessful) {
                                    if (hasAlertContext) {
                                        "Primary owner verified on this enrolled device. Acknowledge or cancel the recovery request."
                                    } else {
                                        "Primary owner verified. Reopen the recovery alert notification to acknowledge or cancel."
                                    }
                                } else {
                                    "Owner session refresh failed. Recovery remains locked."
                                }
                            }
                        }
                }
        }.onFailure {
            status.text = "Owner email-link verification is unavailable. Recovery remains locked."
        }
    }

    private fun acknowledge() {
        withFreshOwnerSession("acknowledgeRecoveryOwnerAlert") { result ->
            val acknowledged = (result as? Map<*, *>)?.get("acknowledged") == true
            if (acknowledged) NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
            status.text = if (acknowledged) {
                "Alert acknowledged. The 24-hour security hold has started."
            } else {
                "The owner alert could not be acknowledged. The hold has not started."
            }
        }
    }

    private fun cancelRequest() {
        withFreshOwnerSession("cancelRecoveryRequest") { result ->
            val cancelled = (result as? Map<*, *>)?.get("cancelled") == true
            if (cancelled) NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
            status.text = if (cancelled) {
                "Recovery request cancelled. The pending hold and any unconsumed grant were revoked."
            } else {
                "No cancellable recovery request was found."
            }
        }
    }

    private fun withFreshOwnerSession(
        callable: String,
        onSuccess: (Any?) -> Unit
    ) {
        if (!hasAlertContext) {
            status.text = "Open the original recovery alert notification to acknowledge or cancel."
            return
        }
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            status.text = "Complete primary-owner email-link sign-in first."
            return
        }
        status.text = "Verifying the fresh primary-owner session..."
        user.getIdToken(true).addOnCompleteListener { tokenTask ->
            if (!tokenTask.isSuccessful) {
                status.text = "Primary-owner authentication is unavailable. Recovery remains locked."
                return@addOnCompleteListener
            }
            FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                .getHttpsCallable(callable)
                .call(mapOf(
                    "tenantId" to tenantId,
                    "deviceIdHash" to deviceHash,
                    "eventId" to eventId,
                    "ackToken" to ackToken
                ))
                .addOnCompleteListener { task ->
                    if (!task.isSuccessful) {
                        status.text = "The owner action was rejected. Reauthenticate with the primary email link if needed."
                    } else {
                        onSuccess(task.result?.data)
                    }
                }
        }
    }

    companion object {
        const val EXTRA_TENANT_ID = "recovery_alert_tenant_id"
        const val EXTRA_DEVICE_HASH = "recovery_alert_device_hash"
        const val EXTRA_EVENT_ID = "recovery_alert_event_id"
        const val EXTRA_ACK_TOKEN = "recovery_alert_ack_token"
        const val NOTIFICATION_ID = 9402
    }
}
