package com.aurelia.pms.identity

import android.content.Intent
import android.net.Uri
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
    private lateinit var tenantInput: EditText
    private lateinit var emailInput: EditText
    private lateinit var emailLinkInput: EditText
    private lateinit var acknowledgeButton: Button
    private lateinit var cancelButton: Button
    private var tenantId = ""
    private var deviceHash = ""
    private var eventId = ""
    private var ackToken = ""
    private var purpose = "enrollment"
    private var hasAlertContext = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val incomingLink = intent.dataString
        if (!loadAlertContext(intent)) {
            val binding = runCatching { RecoveryTenantIdentity.getBinding(this) }.getOrNull()
            tenantId = binding?.tenantId
                ?: intent.getStringExtra(EXTRA_TENANT_ID).orEmpty()
            val enrollmentRequested = intent.getBooleanExtra(EXTRA_ENROLLMENT_MODE, false)
            deviceHash = runCatching { RecoveryDeviceIdentity.deviceIdHashOrNull() }.getOrNull().orEmpty()
            val enrollmentFlow = enrollmentRequested || !incomingLink.isNullOrBlank()
            if (deviceHash.isBlank() && !enrollmentFlow) {
                finish()
                return
            }
            if (!incomingLink.isNullOrBlank()) applyEmailLinkContext(incomingLink)
            if (tenantId.isBlank() && !enrollmentFlow) {
                finish()
                return
            }
        }
        if (hasAlertContext) purpose = "alert"
        buildContent()
        incomingLink?.let {
            emailLinkInput.setText(it)
            applyEmailLinkContext(it)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadAlertContext(intent)
        intent.dataString?.let {
            applyEmailLinkContext(it)
            emailLinkInput.setText(it)
            status.text = "Email sign-in link received. Enter the same owner email and complete sign-in."
        }
        tenantInput.setText(tenantId)
        tenantInput.visibility = if (hasAlertContext) View.GONE else View.VISIBLE
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
        purpose = "alert"
        if (::acknowledgeButton.isInitialized) {
            acknowledgeButton.visibility = View.VISIBLE
            cancelButton.visibility = View.VISIBLE
        }
        return true
    }

    private fun applyEmailLinkContext(emailLink: String) {
        runCatching {
            val link = Uri.parse(emailLink)
            val continueUrl = link.getQueryParameter("continueUrl")
            if (!continueUrl.isNullOrBlank()) {
                val state = Uri.parse(continueUrl)
                state.getQueryParameter("tenantId")?.takeIf { it.isNotBlank() }?.let { tenantId = it }
                state.getQueryParameter("purpose")?.takeIf { it == "alert" || it == "enrollment" }?.let { purpose = it }
            }
        }
        if (hasAlertContext) purpose = "alert"
        if (::tenantInput.isInitialized) tenantInput.setText(tenantId)
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
                "Primary owner sign-in is required before recovery phone enrollment or owner alert actions."
            }
            textSize = 16f
        }
        tenantInput = EditText(this).apply {
            hint = "Tenant ID supplied by your administrator"
            inputType = InputType.TYPE_CLASS_TEXT
            singleLine = true
            setText(tenantId)
            visibility = if (hasAlertContext) View.GONE else View.VISIBLE
        }
        emailInput = EditText(this).apply {
            hint = "Primary owner's registered email address"
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
        root.addView(tenantInput)
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
        tenantId = tenantInput.text.toString().trim()
        if (!tenantId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"))) {
            status.text = "Enter the tenant ID provided by your administrator."
            return
        }
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
        purpose = if (hasAlertContext) "alert" else "enrollment"
        val continueUrl = "https://$projectId.firebaseapp.com/?tenantId=${Uri.encode(tenantId)}&purpose=$purpose"
        val settings = ActionCodeSettings.newBuilder()
            .setUrl(continueUrl)
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
        tenantId = tenantInput.text.toString().trim().ifBlank { tenantId }
        val email = emailInput.text.toString().trim()
        val emailLink = emailLinkInput.text.toString().trim()
        if (!tenantId.matches(Regex("^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")) ||
            !email.matches(Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")) || emailLink.isBlank()) {
            status.text = "Enter the tenant ID, same owner email and complete email sign-in link."
            return
        }
        purpose = if (hasAlertContext) "alert" else purpose
        status.text = "Verifying the one-time owner email link..."
        runCatching {
            FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                .getHttpsCallable("exchangeOwnerEmailLink")
                .call(mapOf(
                    "tenantId" to tenantId,
                    "deviceIdHash" to deviceHash,
                    "email" to email,
                    "emailLink" to emailLink,
                    "purpose" to purpose
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
                                if (!token.isSuccessful) {
                                    status.text = "Owner session refresh failed. Recovery remains locked."
                                } else if (purpose == "enrollment") {
                                    RecoveryTenantIdentity.bindAuthorizedOwner(this, tenantId)
                                        .addOnCompleteListener { binding ->
                                            if (!binding.isSuccessful) {
                                                status.text = "Owner session verified, but the encrypted local owner binding could not be saved."
                                            } else {
                                                status.text = "Primary owner verified and device bound. Continue recovery phone enrollment."
                                                startActivity(Intent(this, RecoveryPhoneSettingsActivity::class.java))
                                                finish()
                                            }
                                        }
                                } else {
                                    status.text = "Primary owner verified on this enrolled device. Acknowledge or cancel the recovery request."
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
        const val EXTRA_ENROLLMENT_MODE = "recovery_owner_enrollment_mode"
        const val NOTIFICATION_ID = 9402
    }
}
