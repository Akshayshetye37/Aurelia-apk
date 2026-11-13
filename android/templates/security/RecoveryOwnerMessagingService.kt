package com.aurelia.pms.security

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.aurelia.pms.identity.RecoveryTenantIdentity
import com.aurelia.pms.identity.RecoveryOwnerAlertActivity
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Posts the owner alert; explicit acknowledgement happens only after the owner opens it. */
class RecoveryOwnerMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        if (FirebaseAuth.getInstance().currentUser == null) return
        val tenant = runCatching { RecoveryTenantIdentity.getOrCreate(this) }.getOrNull() ?: return
        val deviceHash = runCatching { RecoveryDeviceIdentity.deviceIdHash() }.getOrNull() ?: return
        FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
            .getHttpsCallable("registerRecoveryOwnerDevice")
            .call(mapOf("tenantId" to tenant, "deviceIdHash" to deviceHash, "fcmToken" to token))
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] != "RECOVERY_COOLDOWN_STARTED") return
        val tenantId = data["tenantId"] ?: return
        val deviceIdHash = data["deviceIdHash"] ?: return
        val eventId = data["eventId"] ?: return
        val ackToken = data["ackToken"] ?: return
        val localDeviceHash = runCatching { RecoveryDeviceIdentity.deviceIdHash() }.getOrNull() ?: return
        if (localDeviceHash != deviceIdHash) return
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Account security", NotificationManager.IMPORTANCE_HIGH)
            )
            // Android may silently accept notify() while the user has blocked this channel.
            // Never acknowledge delivery or start the 24-hour hold for a suppressed alert.
            if (manager.getNotificationChannel(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) return
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return

        val openApp = Intent(this, RecoveryOwnerAlertActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(RecoveryOwnerAlertActivity.EXTRA_TENANT_ID, tenantId)
            putExtra(RecoveryOwnerAlertActivity.EXTRA_DEVICE_HASH, deviceIdHash)
            putExtra(RecoveryOwnerAlertActivity.EXTRA_EVENT_ID, eventId)
            putExtra(RecoveryOwnerAlertActivity.EXTRA_ACK_TOKEN, ackToken)
        }
        val pending = PendingIntent.getActivity(
            this, NOTIFICATION_ID, openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val body = "A recovery request was started for your property account. If this was not you, open Aurelia immediately."
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Aurelia recovery request")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            // Keep the notification until explicit owner acknowledgement/cancellation.
            .setAutoCancel(false)
            .setContentIntent(pending)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            return
        }

        // A notification being posted is not owner consent. The owner must open
        // the alert and explicitly acknowledge or cancel from a fresh primary session.
    }

    private companion object {
        const val CHANNEL_ID = "aurelia_recovery_security"
        const val NOTIFICATION_ID = 9402
    }
}
