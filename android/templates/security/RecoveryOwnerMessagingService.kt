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
import com.aurelia.pms.R
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Posts the owner alert, then acknowledges it; the server starts the 24h hold only after this ack. */
class RecoveryOwnerMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] != "RECOVERY_COOLDOWN_STARTED") return
        val tenantId = data["tenantId"] ?: return
        val deviceIdHash = data["deviceIdHash"] ?: return
        val eventId = data["eventId"] ?: return
        val localDeviceHash = runCatching { RecoveryDeviceIdentity.deviceIdHash() }.getOrNull() ?: return
        if (localDeviceHash != deviceIdHash) return
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Account security", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return

        val openApp = Intent(this, LockGateActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, NOTIFICATION_ID, openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val body = "A recovery request was started for your property account. If this was not you, open Aurelia immediately."
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Aurelia recovery request")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            return
        }

        // Server-side cooldown starts only after the attested owner app confirms
        // that Android accepted the notification for display.
        if (FirebaseAuth.getInstance().currentUser == null) return
        FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
            .getHttpsCallable("acknowledgeRecoveryOwnerAlert")
            .call(mapOf("tenantId" to tenantId, "deviceIdHash" to deviceIdHash, "eventId" to eventId))
    }

    private companion object {
        const val CHANNEL_ID = "aurelia_recovery_security"
        const val NOTIFICATION_ID = 9402
    }
}
