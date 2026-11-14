package com.aurelia.pms.identity

import android.app.AlertDialog
import android.os.Bundle
import android.content.Intent
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import com.aurelia.pms.security.RecoveryDeviceIdentity
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.messaging.FirebaseMessaging
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64

/** Explicit Settings workflow; Hotel Identity fields never call this activity. */
class RecoveryPhoneSettingsActivity : FragmentActivity() {
    companion object {
        const val EXTRA_ENROLL_PASSKEY_AFTER_SETUP = "recovery_enroll_passkey_after_setup"
    }
    private lateinit var store: RecoveryPhoneStore
    private lateinit var identity: FirebasePhoneIdentity
    private lateinit var client: RecoveryGrantClient
    private lateinit var status: TextView
    private lateinit var phone: EditText
    private var candidate = ""
    private var stage = Stage.NEW
    private var oldPhoneToken: String? = null
    private var pendingNotificationPermissionAction: (() -> Unit)? = null
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
            if (Build.VERSION.SDK_INT >= 26) {
                getSystemService(NotificationManager::class.java).createNotificationChannel(
                    NotificationChannel("aurelia_recovery_security", "Account security", NotificationManager.IMPORTANCE_HIGH)
                )
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
                RecoveryPhoneStore.State.UNSET -> "Important: SMS OTP only authorizes recovery; it does not unlock the database or replace your offline recovery key. You must enter that key to restore access. If you lose both this device and the offline recovery key, your encrypted data cannot be recovered."
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
            addView(Button(this@RecoveryPhoneSettingsActivity).apply {
                text = "Verify primary owner with email link"
                setOnClickListener {
                    val tenant = runCatching { RecoveryTenantIdentity.getBinding(this@RecoveryPhoneSettingsActivity).tenantId }.getOrNull().orEmpty()
                    startActivity(Intent(this@RecoveryPhoneSettingsActivity, RecoveryOwnerAlertActivity::class.java)
                        .putExtra(RecoveryOwnerAlertActivity.EXTRA_ENROLLMENT_MODE, true)
                        .putExtra(RecoveryOwnerAlertActivity.EXTRA_TENANT_ID, tenant))
                }
            })
            addView(TextView(this@RecoveryPhoneSettingsActivity).apply {
                text = "SMS OTP never unlocks the database. Your offline recovery key is still required. If both this device and that key are lost, the encrypted data is permanently unrecoverable."
                textSize = 13f
                setTextColor(android.graphics.Color.LTGRAY)
                setPadding(0, 0, 0, 20)
            })
            addView(phone, LinearLayout.LayoutParams(-1, -2))
            addView(button, LinearLayout.LayoutParams(-1, -2))
            addView(Button(this@RecoveryPhoneSettingsActivity).apply {
                text = "Close"
                setOnClickListener { finish() }
            })
            addView(Button(this@RecoveryPhoneSettingsActivity).apply {
                text = "Register this device for owner security alerts"
                setOnClickListener { registerThisDeviceForAlerts() }
            })
            addView(Button(this@RecoveryPhoneSettingsActivity).apply {
                text = "Enroll or add owner passkey"
                setOnClickListener {
                    val tenant = runCatching { RecoveryTenantIdentity.getBinding(this@RecoveryPhoneSettingsActivity).tenantId }.getOrNull().orEmpty()
                    startActivity(Intent(this@RecoveryPhoneSettingsActivity, RecoveryOwnerAlertActivity::class.java)
                        .putExtra(RecoveryOwnerAlertActivity.EXTRA_ENROLLMENT_MODE, true)
                        .putExtra(RecoveryOwnerAlertActivity.EXTRA_PASSKEY_ONLY_MODE, true)
                        .putExtra(RecoveryOwnerAlertActivity.EXTRA_TENANT_ID, tenant))
                }
            })
            addView(Button(this@RecoveryPhoneSettingsActivity).apply {
                text = "Cancel suspicious recovery request"
                setOnClickListener {
                    AlertDialog.Builder(this@RecoveryPhoneSettingsActivity)
                        .setTitle("Cancel account recovery?")
                        .setMessage("This will revoke any unconsumed recovery grant and stop the pending recovery hold.")
                        .setNegativeButton("Keep request", null)
                        .setPositiveButton("Cancel recovery") { _, _ -> cancelPendingRecovery() }
                        .show()
                }
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
                    status.text = "Recovery phone setup requires a recently authenticated property-owner account."
                    return@runOnUiThread
                }
                val tenant = tenantTask.result
                val existingHash = try { RecoveryDeviceIdentity.deviceIdHashOrNull() } catch (_: Exception) {
                    status.text = "Secure device binding is unavailable."
                    return@runOnUiThread
                }
                status.text = "Checking hardware-backed device attestation…"
                client.createRecoveryAttestationChallenge(tenant, existingHash).addOnCompleteListener { challengeTask ->
                    runOnUiThread {
                        if (!challengeTask.isSuccessful) {
                            status.text = "Hardware attestation challenge is unavailable. Recovery registration is blocked."
                            return@runOnUiThread
                        }
                        val response = challengeTask.result
                        if (response["verified"] == true) {
                            if (existingHash == null || response["deviceIdHash"] != existingHash) {
                                status.text = "Device attestation binding is inconsistent."
                                return@runOnUiThread
                            }
                            registerOwnerAlertEndpoint(tenant, existingHash) { persistRecoveryPhone(newPhoneToken, tenant, existingHash) }
                            return@runOnUiThread
                        }
                        val challengeId = response["challengeId"] as? String
                        val challengeEncoded = response["challengeBase64"] as? String
                        if (challengeId.isNullOrBlank() || challengeEncoded.isNullOrBlank()) {
                            status.text = "Server attestation challenge is malformed."
                            return@runOnUiThread
                        }
                        val identity = try {
                            val challenge = Base64.decode(challengeEncoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                            try { RecoveryDeviceIdentity.createAttestedIdentity(challenge) }
                            finally { challenge.fill(0) }
                        } catch (_: Exception) {
                            status.text = "Android hardware attestation is unavailable. Software-only keys are rejected."
                            return@runOnUiThread
                        }
                        client.verifyRecoveryDeviceAttestation(
                            tenant, challengeId, identity.deviceIdHash, identity.certificateChainBase64
                        ).addOnCompleteListener { verifyTask ->
                            runOnUiThread {
                                if (!verifyTask.isSuccessful || verifyTask.result != true) {
                                    status.text = "Hardware key attestation failed. This device cannot be enrolled."
                                    return@runOnUiThread
                                }
                                registerOwnerAlertEndpoint(tenant, identity.deviceIdHash) { persistRecoveryPhone(newPhoneToken, tenant, identity.deviceIdHash) }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun registerOwnerAlertEndpoint(tenant: String, deviceHash: String, onRegistered: () -> Unit) {
        withNotificationPermission {
            status.text = "Registering owner security notifications…"
            FirebaseMessaging.getInstance().token.addOnCompleteListener { tokenTask ->
                runOnUiThread {
                    if (!tokenTask.isSuccessful || tokenTask.result.isNullOrBlank()) {
                        status.text = "Owner security notifications are unavailable. Recovery registration is blocked."
                        return@runOnUiThread
                    }
                    client.registerOwnerNotificationDevice(tenant, deviceHash, tokenTask.result)
                        .addOnCompleteListener { notificationTask ->
                            runOnUiThread {
                                if (!notificationTask.isSuccessful || notificationTask.result != true) {
                                    status.text = "Could not register owner security notifications. Recovery registration is blocked."
                                    return@runOnUiThread
                                }
                                onRegistered()
                            }
                        }
                }
            }
        }
    }

    private fun registerThisDeviceForAlerts() {
        status.text = "Checking owner identity and hardware attestation…"
        RecoveryTenantIdentity.bindAuthorizedOwner(this).addOnCompleteListener { ownerTask ->
            runOnUiThread {
                if (!ownerTask.isSuccessful) {
                    status.text = "Sign in again as the property owner to register this device."
                    return@runOnUiThread
                }
                val tenant = ownerTask.result
                val existingHash = runCatching { RecoveryDeviceIdentity.deviceIdHashOrNull() }.getOrNull()
                client.createRecoveryAttestationChallenge(tenant, existingHash).addOnCompleteListener { challengeTask ->
                    runOnUiThread {
                        if (!challengeTask.isSuccessful) {
                            status.text = "Device attestation service is unavailable."
                            return@runOnUiThread
                        }
                        val response = challengeTask.result
                        if (response["verified"] == true && existingHash != null &&
                            response["deviceIdHash"] == existingHash) {
                            registerOwnerAlertEndpoint(tenant, existingHash) {
                                status.text = "This device is registered for owner security alerts."
                            }
                            return@runOnUiThread
                        }
                        val challengeId = response["challengeId"] as? String
                        val challengeEncoded = response["challengeBase64"] as? String
                        if (challengeId.isNullOrBlank() || challengeEncoded.isNullOrBlank()) {
                            status.text = "Server attestation challenge is malformed."
                            return@runOnUiThread
                        }
                        val identity = try {
                            val challenge = Base64.decode(challengeEncoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                            try { RecoveryDeviceIdentity.createAttestedIdentity(challenge) }
                            finally { challenge.fill(0) }
                        } catch (_: Exception) {
                            status.text = "Hardware-backed Android key attestation is unavailable."
                            return@runOnUiThread
                        }
                        client.verifyRecoveryDeviceAttestation(
                            tenant, challengeId, identity.deviceIdHash, identity.certificateChainBase64
                        ).addOnCompleteListener { verifyTask ->
                            runOnUiThread {
                                if (!verifyTask.isSuccessful || verifyTask.result != true) {
                                    status.text = "Hardware attestation failed; this device is not trusted."
                                    return@runOnUiThread
                                }
                                registerOwnerAlertEndpoint(tenant, identity.deviceIdHash) {
                                    status.text = "This device is registered for owner security alerts."
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun withNotificationPermission(action: () -> Unit) {
        if (Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            action()
            return
        }
        pendingNotificationPermissionAction = action
        status.text = "Allow security notifications to protect this recovery destination."
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 9401)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 9401) return
        val action = pendingNotificationPermissionAction
        pendingNotificationPermissionAction = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            action?.invoke()
        } else {
            status.text = "Security notifications are required. Recovery phone registration remains blocked."
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
                        if (intent.getBooleanExtra(EXTRA_ENROLL_PASSKEY_AFTER_SETUP, false) &&
                            serverState != "CHANGE_PENDING") {
                            intent.removeExtra(EXTRA_ENROLL_PASSKEY_AFTER_SETUP)
                            startActivity(Intent(this, RecoveryOwnerAlertActivity::class.java)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_ENROLLMENT_MODE, true)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_PASSKEY_ONLY_MODE, true)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_TENANT_ID, tenant))
                            finish()
                        }
                    } catch (_: Exception) {
                        status.text = "Server accepted verification, but local state could not be saved."
                    }
                }
            }
    }

    private fun cancelPendingRecovery() {
        status.text = "Checking the fresh primary-owner session..."
        RecoveryTenantIdentity.getPrimaryOwnerTenant().addOnCompleteListener { ownerTask ->
            runOnUiThread {
                if (!ownerTask.isSuccessful) {
                    status.text = "Sign in again as the property owner before cancelling recovery."
                    return@runOnUiThread
                }
                val tenant = ownerTask.result
                val deviceHash = runCatching { RecoveryDeviceIdentity.deviceIdHash() }.getOrNull()
                if (deviceHash == null) {
                    status.text = "This device has no verified recovery identity."
                    return@runOnUiThread
                }
                val user = FirebaseAuth.getInstance().currentUser
                if (user == null) {
                    status.text = "Complete primary-owner email-link sign-in before cancelling recovery."
                    return@runOnUiThread
                }
                user.getIdToken(true).addOnCompleteListener { tokenTask ->
                    if (!tokenTask.isSuccessful) {
                        status.text = "Fresh owner authentication is unavailable. Recovery remains unchanged."
                        return@addOnCompleteListener
                    }
                    FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                        .getHttpsCallable("getRecoveryOwnerPendingAction")
                        .call(mapOf("tenantId" to tenant, "deviceIdHash" to deviceHash))
                        .addOnCompleteListener { contextTask ->
                            val data = contextTask.result?.data as? Map<*, *>
                            val requestId = data?.get("requestId") as? String
                            if (!contextTask.isSuccessful || data?.get("available") != true || requestId.isNullOrBlank()) {
                                status.text = "No cancellable recovery request was found, or owner/device verification failed."
                                return@addOnCompleteListener
                            }
                            startActivity(Intent(this, RecoveryOwnerAlertActivity::class.java)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_TENANT_ID, tenant)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_DEVICE_HASH, deviceHash)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_EVENT_ID, requestId)
                                .putExtra(RecoveryOwnerAlertActivity.EXTRA_ACTION, "cancel"))
                        }
                }
            }
        }
    }

    private fun mask(value: String): String {
        val digits = value.filter(Char::isDigit)
        return "+" + digits.take(2) + " " + "•".repeat((digits.length - 5).coerceAtLeast(0)) + digits.takeLast(3)
    }
}
