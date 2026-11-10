package com.aurelia.pms.identity

import com.google.firebase.FirebaseApp
import com.google.firebase.functions.FirebaseFunctions
import com.google.android.gms.tasks.Task
import java.security.SecureRandom
import java.util.Base64

/** Callable client for the trusted recovery authorization service. */
class RecoveryGrantClient {
    private val functions = FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")

    fun registerRecoveryPhone(phoneIdToken: String): Task<Map<*, *>> =
        functions.getHttpsCallable("registerRecoveryPhone")
            .call(mapOf("phoneIdToken" to phoneIdToken))
            .continueWith { task ->
                @Suppress("UNCHECKED_CAST")
                task.result?.data as? Map<*, *> ?: throw IllegalStateException("Phone registration failed.")
            }

    fun issueRecoveryGrant(phoneIdToken: String, tenantId: String): GrantRequest {
        val nonceBytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes)
        nonceBytes.fill(0)
        val deviceHash = com.aurelia.pms.security.RecoveryDeviceIdentity.deviceIdHash()
        val task = functions.getHttpsCallable("issueRecoveryGrant").call(
            mapOf("phoneIdToken" to phoneIdToken, "tenantId" to tenantId,
                "deviceIdHash" to deviceHash, "nonce" to nonce)
        ).continueWith { result ->
            @Suppress("UNCHECKED_CAST")
            val data = result.result?.data as? Map<*, *> ?: throw IllegalStateException("Recovery authorization failed.")
            val grant = data["grant"] as? String ?: throw IllegalStateException("Recovery authorization failed.")
            grant
        }
        return GrantRequest(task, nonce, deviceHash)
    }

    fun consumeRecoveryGrant(grant: String, nonce: String, deviceHash: String): Task<Boolean> =
        functions.getHttpsCallable("consumeRecoveryGrant").call(
            mapOf("grant" to grant, "nonce" to nonce, "deviceIdHash" to deviceHash)
        ).continueWith { task ->
            val data = task.result?.data as? Map<*, *>
            data?.get("consumed") == true
        }

    data class GrantRequest(val task: Task<String>, val nonce: String, val deviceIdHash: String)
}
