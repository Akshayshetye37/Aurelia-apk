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
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
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
    private var passkeyOnlyMode = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val incomingLink = intent.dataString
        passkeyOnlyMode = intent.getBooleanExtra(EXTRA_PASSKEY_ONLY_MODE, false)
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
            setSingleLine(true)
            setText(tenantId)
            visibility = if (hasAlertContext) View.GONE else View.VISIBLE
        }
        emailInput = EditText(this).apply {
            hint = "Primary owner's registered email address"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
            setSingleLine(true)
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
            text = "Passkey approval not configured"
            visibility = if (hasAlertContext) View.VISIBLE else View.GONE
            isEnabled = false
            contentDescription = "Owner acknowledgement requires a server-verified passkey assertion."
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
                                                if (passkeyOnlyMode) {
                                                    status.text = "Owner verified. Complete passkey registration with the device credential provider."
                                                    enrollRecoveryPasskey {
                                                        if (it) finish()
                                                    }
                                                } else {
                                                    status.text = "Primary owner verified. Continue to recovery phone setup and hardware device attestation."
                                                    startActivity(Intent(this, RecoveryPhoneSettingsActivity::class.java)
                                                        .putExtra(RecoveryPhoneSettingsActivity.EXTRA_ENROLL_PASSKEY_AFTER_SETUP, true))
                                                    finish()
                                                }
                                            }
                                        }
                                } else {
                                    acknowledgeButton.isEnabled = hasAlertContext
                                    acknowledgeButton.text = "Acknowledge with passkey"
                                    status.text = "Primary owner email session verified. Use the passkey on this device to acknowledge; the server verifies the assertion and applies the hold atomically."
                                }
                            }
                        }
                }
        }.onFailure {
            status.text = "Owner email-link verification is unavailable. Recovery remains locked."
        }
    }

    private fun acknowledge() {
        val user = FirebaseAuth.getInstance().currentUser
        if (!hasAlertContext || user == null || tenantId.isBlank() || deviceHash.isBlank() ||
            eventId.isBlank() || ackToken.isBlank()) {
            status.text = "Open the original alert and complete primary-owner email-link sign-in first."
            return
        }
        acknowledgeButton.isEnabled = false
        status.text = "Requesting a one-time owner-action challenge..."
        user.getIdToken(true).addOnCompleteListener { tokenTask ->
            if (!tokenTask.isSuccessful) {
                acknowledgeButton.isEnabled = true
                status.text = "The fresh owner session could not be verified. The hold has not started."
                return@addOnCompleteListener
            }
            val functions = FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
            functions.getHttpsCallable("createRecoveryOwnerActionOptions").call(mapOf(
                "tenantId" to tenantId, "deviceIdHash" to deviceHash, "action" to "ack", "requestId" to eventId
            )).addOnCompleteListener { challengeTask ->
                if (!challengeTask.isSuccessful) {
                    acknowledgeButton.isEnabled = true
                    status.text = "The server rejected the passkey challenge request. The hold has not started."
                    return@addOnCompleteListener
                }
                val payload = challengeTask.result?.data as? Map<*, *>
                val challengeId = payload?.get("challengeId") as? String
                val options = payload?.get("options") as? Map<*, *>
                if (challengeId.isNullOrBlank() || options == null) {
                    acknowledgeButton.isEnabled = true
                    status.text = "The server returned an invalid passkey challenge."
                    return@addOnCompleteListener
                }
                lifecycleScope.launch {
                    try {
                        val requestJson = JSONObject(options).toString()
                        val response = CredentialManager.create(this@RecoveryOwnerAlertActivity).getCredential(
                            this@RecoveryOwnerAlertActivity,
                            GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
                        )
                        val passkey = response.credential as? PublicKeyCredential
                            ?: throw IllegalStateException("Credential provider did not return a public-key credential.")
                        val credentialResponse = jsonObjectToMap(JSONObject(passkey.authenticationResponseJson))
                        functions.getHttpsCallable("acknowledgeRecoveryOwnerAlert").call(mapOf(
                            "tenantId" to tenantId, "deviceIdHash" to deviceHash, "requestId" to eventId,
                            "challengeId" to challengeId, "credentialResponse" to credentialResponse, "ackToken" to ackToken
                        )).addOnCompleteListener { assertionTask ->
                            val acknowledged = assertionTask.isSuccessful &&
                                (assertionTask.result?.data as? Map<*, *>)?.get("acknowledged") == true
                            if (acknowledged) {
                                NotificationManagerCompat.from(this@RecoveryOwnerAlertActivity).cancel(NOTIFICATION_ID)
                                status.text = "Passkey verified. The 24-hour security hold has started."
                            } else {
                                status.text = "The server rejected the passkey assertion. The hold has not started."
                                acknowledgeButton.isEnabled = true
                            }
                        }
                    } catch (_: Exception) {
                        acknowledgeButton.isEnabled = true
                        status.text = "Passkey authentication was cancelled or unavailable. No acknowledgement was recorded."
                    }
                }
            }
        }
    }

    private fun enrollRecoveryPasskey(onComplete: (Boolean) -> Unit) {
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null || tenantId.isBlank() || deviceHash.isBlank()) {
            status.text = "A fresh owner session and attested device are required to enroll a passkey."
            onComplete(false)
            return
        }
        user.getIdToken(true).addOnCompleteListener { tokenTask ->
            if (!tokenTask.isSuccessful) {
                status.text = "The fresh owner session could not be verified. Passkey enrollment was not started."
                onComplete(false)
                return@addOnCompleteListener
            }
            val functions = FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
            functions.getHttpsCallable("createRecoveryPasskeyEnrollmentOptions").call(mapOf(
                "tenantId" to tenantId, "deviceIdHash" to deviceHash
            )).addOnCompleteListener { optionsTask ->
                if (!optionsTask.isSuccessful) {
                    status.text = "The server rejected passkey enrollment. Recovery phone registration remains locked."
                    onComplete(false)
                    return@addOnCompleteListener
                }
                val payload = optionsTask.result?.data as? Map<*, *>
                val challengeId = payload?.get("challengeId") as? String
                val options = payload?.get("options") as? Map<*, *>
                if (challengeId.isNullOrBlank() || options == null) {
                    status.text = "The passkey enrollment challenge was invalid."
                    onComplete(false)
                    return@addOnCompleteListener
                }
                lifecycleScope.launch {
                    try {
                        val requestJson = JSONObject(options).toString()
                        val created = CredentialManager.create(this@RecoveryOwnerAlertActivity).createCredential(
                            this@RecoveryOwnerAlertActivity, CreatePublicKeyCredentialRequest(requestJson)
                        ) as? CreatePublicKeyCredentialResponse
                            ?: throw IllegalStateException("Credential provider did not create a public-key credential.")
                        val credentialResponse = jsonObjectToMap(JSONObject(created.registrationResponseJson))
                        functions.getHttpsCallable("completeRecoveryPasskeyEnrollment").call(mapOf(
                            "tenantId" to tenantId, "deviceIdHash" to deviceHash,
                            "challengeId" to challengeId, "credentialResponse" to credentialResponse
                        )).addOnCompleteListener { completion ->
                            val result = completion.result?.data as? Map<*, *>
                            val registered = completion.isSuccessful && result?.get("registered") == true
                            val alertAccepted = result?.get("alertAccepted") == true
                            val credentialHash = result?.get("credentialHash") as? String
                            if (!registered || credentialHash.isNullOrBlank()) {
                                status.text = "The server rejected passkey enrollment. Recovery phone registration remains locked."
                                onComplete(false)
                            } else if (alertAccepted) {
                                status.text = "Passkey enrolled. The independent owner alert was accepted; recovery phone setup can continue."
                                onComplete(true)
                            } else {
                                status.text = "Passkey enrolled, but the independent owner alert needs retry. Recovery remains locked."
                                functions.getHttpsCallable("retryRecoveryPasskeyEnrollmentAlert")
                                    .call(mapOf("credentialHash" to credentialHash))
                                    .addOnCompleteListener { retry ->
                                        val notified = retry.isSuccessful &&
                                            (retry.result?.data as? Map<*, *>)?.get("alertAccepted") == true
                                        status.text = if (notified) {
                                            "Passkey enrolled and the independent owner alert was accepted. Recovery phone setup can continue."
                                        } else {
                                            "The independent owner alert was not accepted. Recovery phone registration remains locked."
                                        }
                                        onComplete(notified)
                                    }
                            }
                        }
                    } catch (_: Exception) {
                        status.text = "Passkey creation was cancelled or unavailable. Recovery phone registration remains locked."
                        onComplete(false)
                    }
                }
            }
        }
    }

    private fun jsonObjectToMap(value: JSONObject): Map<String, Any?> {
        val result = linkedMapOf<String, Any?>()
        val keys = value.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            result[key] = jsonValue(value.get(key))
        }
        return result
    }

    private fun jsonValue(value: Any?): Any? = when (value) {
        JSONObject.NULL -> null
        is JSONObject -> jsonObjectToMap(value)
        is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
        else -> value
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
        const val EXTRA_PASSKEY_ONLY_MODE = "recovery_owner_passkey_only_mode"
        const val NOTIFICATION_ID = 9402
    }
}
