package com.aurelia.pms.identity

import android.os.Bundle
import androidx.core.app.NotificationManagerCompat
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions

/**
 * Explicit owner action surface for a recovery alert. Merely receiving or displaying
 * an FCM notification never acknowledges it or starts the server-side hold.
 */
class RecoveryOwnerAlertActivity : FragmentActivity() {
    private lateinit var status: TextView
    private var tenantId: String = ""
    private var deviceHash: String = ""
    private var eventId: String = ""
    private var ackToken: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE)
        tenantId = intent.getStringExtra(EXTRA_TENANT).orEmpty()
        deviceHash = intent.getStringExtra(EXTRA_DEVICE).orEmpty()
        eventId = intent.getStringExtra(EXTRA_EVENT).orEmpty()
        ackToken = intent.getStringExtra(EXTRA_ACK_TOKEN).orEmpty()
        val localDevice = runCatching {
            com.aurelia.pms.security.RecoveryDeviceIdentity.deviceIdHash()
        }.getOrNull()
        if (tenantId.isBlank() || deviceHash.isBlank() || eventId.isBlank() ||
            !eventId.matches(Regex("^[0-9a-fA-F-]{36}$")) ||
            !ackToken.matches(Regex("^[A-Za-z0-9_-]{43}$")) || localDevice != deviceHash) {
            finish()
            return
        }

        status = TextView(this).apply {
            text = "A recovery request was started for your property account. If this was not you, cancel it. Acknowledging confirms that you saw the alert and starts the 24-hour security hold."
            textSize = 16f
            setTextColor(android.graphics.Color.WHITE)
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 48, 32, 48)
            setBackgroundColor(android.graphics.Color.rgb(5, 17, 13))
            addView(TextView(this@RecoveryOwnerAlertActivity).apply {
                text = "Account recovery alert"
                textSize = 23f
                setTextColor(android.graphics.Color.WHITE)
            })
            addView(status)
            addView(Button(this@RecoveryOwnerAlertActivity).apply {
                text = "Acknowledge alert"
                setOnClickListener { acknowledge() }
            })
            addView(Button(this@RecoveryOwnerAlertActivity).apply {
                text = "Cancel recovery request"
                setOnClickListener { cancelRecovery() }
            })
            addView(Button(this@RecoveryOwnerAlertActivity).apply {
                text = "Close"
                setOnClickListener { finish() }
            })
        }
        setContentView(root)
    }

    private fun acknowledge() {
        status.text = "Verifying your primary owner session…"
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            status.text = "Sign in again with the primary owner account using email link or passkey, then reopen this alert."
            return
        }
        user.getIdToken(true).addOnCompleteListener { tokenTask ->
            if (!tokenTask.isSuccessful) {
                status.text = "Primary owner authentication is unavailable. No acknowledgement was sent."
                return@addOnCompleteListener
            }
            FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                .getHttpsCallable("acknowledgeRecoveryOwnerAlert")
                .call(mapOf(
                    "tenantId" to tenantId, "deviceIdHash" to deviceHash,
                    "eventId" to eventId, "ackToken" to ackToken
                )).addOnCompleteListener { task ->
                    status.text = if (task.isSuccessful &&
                        (task.result?.data as? Map<*, *>)?.get("acknowledged") == true) {
                        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
                        "Alert acknowledged. The 24-hour security hold has started."
                    } else {
                        "Acknowledgement rejected. A fresh primary owner sign-in (email link or passkey) is required. The recovery hold remains blocked."
                    }
                }
        }
    }

    private fun cancelRecovery() {
        status.text = "Verifying your primary owner session…"
        val user = FirebaseAuth.getInstance().currentUser
        if (user == null) {
            status.text = "Sign in again with the primary owner account using email link or passkey, then reopen this alert."
            return
        }
        user.getIdToken(true).addOnCompleteListener { tokenTask ->
            if (!tokenTask.isSuccessful) {
                status.text = "Primary owner authentication is unavailable. No cancellation was sent."
                return@addOnCompleteListener
            }
            FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                .getHttpsCallable("cancelRecoveryRequest")
                .call(mapOf("tenantId" to tenantId, "deviceIdHash" to deviceHash))
                .addOnCompleteListener { task ->
                    status.text = if (task.isSuccessful &&
                        (task.result?.data as? Map<*, *>)?.get("cancelled") == true) {
                        NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
                        "Recovery request cancelled. The pending hold and any unconsumed grant were revoked."
                    } else {
                        "Cancellation rejected. A fresh primary owner sign-in (email link or passkey) is required."
                    }
                }
        }
    }

    companion object {
        const val EXTRA_TENANT = "recovery_alert_tenant"
        const val EXTRA_DEVICE = "recovery_alert_device"
        const val EXTRA_EVENT = "recovery_alert_event"
        const val EXTRA_ACK_TOKEN = "recovery_alert_ack_token"
        const val NOTIFICATION_ID = 9402
    }
}
