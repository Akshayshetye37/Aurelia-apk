package com.aurelia.pms.identity

import android.content.Context
import android.os.SystemClock
import com.aurelia.pms.security.RecoveryGate
import com.aurelia.pms.security.RecoveryGrantReplayStore
import com.aurelia.pms.security.RecoveryGrantVerifier
import com.google.firebase.FirebaseApp
import com.google.firebase.functions.FirebaseFunctions
import com.google.android.gms.tasks.Task
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64

/** Server signature validation/atomic jti consumption is authoritative; this client performs claim preflight and local replay suppression only. */
class RecoveryGrantClient(private val context: Context) {
    private val functions = FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
    private val replayStore = RecoveryGrantReplayStore(context)

    fun registerRecoveryPhone(phoneIdToken: String, tenantId: String, deviceIdHash: String, currentPhoneIdToken: String? = null): Task<Map<*, *>> =
        functions.getHttpsCallable("registerRecoveryPhone").call(mapOf(
            "phoneIdToken" to phoneIdToken, "tenantId" to tenantId,
            "deviceIdHash" to deviceIdHash, "currentPhoneIdToken" to currentPhoneIdToken
        )).continueWith { task ->
            @Suppress("UNCHECKED_CAST")
            task.result?.data as? Map<*, *> ?: throw IllegalStateException("Phone registration failed.")
        }

    fun createRecoveryAttestationChallenge(tenantId: String, deviceHash: String?): Task<Map<*, *>> =
        functions.getHttpsCallable("createRecoveryAttestationChallenge").call(mapOf(
            "tenantId" to tenantId, "deviceIdHash" to deviceHash
        )).continueWith { task ->
            if (!task.isSuccessful) throw task.exception ?: IllegalStateException("Device attestation challenge failed.")
            task.result?.data as? Map<*, *> ?: throw IllegalStateException("Device attestation challenge response is invalid.")
        }

    fun verifyRecoveryDeviceAttestation(
        tenantId: String, challengeId: String, deviceHash: String, certificateChainBase64: List<String>
    ): Task<Boolean> = functions.getHttpsCallable("verifyRecoveryDeviceAttestation").call(mapOf(
        "tenantId" to tenantId, "challengeId" to challengeId,
        "deviceIdHash" to deviceHash, "certificateChainBase64" to certificateChainBase64
    )).continueWith { task ->
        if (!task.isSuccessful) throw task.exception ?: IllegalStateException("Hardware attestation was rejected.")
        (task.result?.data as? Map<*, *>)?.get("verified") == true
    }

    fun registerOwnerNotificationDevice(tenantId: String, deviceHash: String, fcmToken: String): Task<Boolean> =
        functions.getHttpsCallable("registerRecoveryOwnerDevice").call(mapOf(
            "tenantId" to tenantId, "deviceIdHash" to deviceHash, "fcmToken" to fcmToken
        )).continueWith { task ->
            if (!task.isSuccessful) throw task.exception ?: IllegalStateException("Owner notification registration failed.")
            (task.result?.data as? Map<*, *>)?.get("registered") == true
        }

    fun issueRecoveryGrant(phoneIdToken: String, tenantId: String): GrantRequest {
        // Start before the network request so local authorization cannot outlive
        // the five-minute grant even if the device wall clock is changed.
        val startedAtElapsedMs = SystemClock.elapsedRealtime()
        val nonceBytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes)
        nonceBytes.fill(0)
        val deviceHash = com.aurelia.pms.security.RecoveryDeviceIdentity.deviceIdHash()
        val task = functions.getHttpsCallable("issueRecoveryGrant").call(
            mapOf("phoneIdToken" to phoneIdToken, "tenantId" to tenantId, "deviceIdHash" to deviceHash, "nonce" to nonce)
        ).continueWith { result ->
            if (!result.isSuccessful) throw result.exception ?: IllegalStateException("Recovery authorization failed.")
            @Suppress("UNCHECKED_CAST")
            val data = result.result?.data as? Map<*, *> ?: throw IllegalStateException("Recovery authorization failed.")
            when (data["status"] as? String) {
                "COOLDOWN" -> GrantIssueResult.Cooldown(
                    (data["eligibleAt"] as? Number)?.toLong()
                        ?: throw IllegalStateException("Recovery cooldown response is invalid.")
                )
                "ISSUED" -> GrantIssueResult.Issued(
                    data["grant"] as? String ?: throw IllegalStateException("Recovery grant is missing.")
                )
                else -> throw IllegalStateException("Recovery authorization response is invalid.")
            }
        }
        return GrantRequest(task, nonce, deviceHash, startedAtElapsedMs)
    }

    fun consumeRecoveryGrant(grant: String, nonce: String, deviceHash: String): Task<Boolean> =
        functions.getHttpsCallable("consumeRecoveryGrant").call(
            mapOf("grant" to grant, "nonce" to nonce, "deviceIdHash" to deviceHash)
        ).continueWith { task ->
            if (!task.isSuccessful) throw task.exception ?: IllegalStateException("Grant consumption failed.")
            (task.result?.data as? Map<*, *>)?.get("consumed") == true
        }

    /**
     * Claim preflight blocks malformed/expired/wrong-tenant/device/nonce grants.
     * It is NOT cryptographic signature verification: server validates ES256 and
     * atomically consumes jti. A durable local replay marker is required before arming.
     */
    fun consumeAndArm(grant: String, nonce: String, deviceHash: String, tenantId: String, startedAtElapsedMs: Long, onResult: (Boolean) -> Unit) {
        val verified = try {
            val kid = RecoveryGrantVerifier.keyId(grant)
            val pinnedKey = RecoveryGrantVerifier.pinnedPublicKey(context, kid)
                ?: throw SecurityException("Recovery signing key is not pinned in this app version.")
            when (val result = RecoveryGrantVerifier.verify(grant, pinnedKey, tenantId, nonce, deviceHash)) {
                is RecoveryGrantVerifier.Result.Verified -> result
                is RecoveryGrantVerifier.Result.Fail -> throw SecurityException("Recovery grant verification failed.")
            }
        } catch (_: Exception) { onResult(false); return }

        if (replayStore.isUsed(verified.jti)) {
            onResult(false)
            return
        }

        consumeRecoveryGrant(grant, nonce, deviceHash).addOnCompleteListener { task ->
            val consumed = task.isSuccessful && task.result == true
            val recorded = if (consumed) runCatching {
                replayStore.markUsed(verified.jti, verified.expiresAtEpochSec)
            }.getOrDefault(false) else false
            val remainingGrantMs = 5 * 60_000L - (SystemClock.elapsedRealtime() - startedAtElapsedMs)
            val armed = consumed && recorded && runCatching {
                RecoveryGate.armAfterServerConsumption(remainingGrantMs)
            }.isSuccess
            if (armed) {
                onResult(true)
            } else {
                RecoveryGate.clear()
                onResult(false)
            }
        }
    }

    sealed class GrantIssueResult {
        data class Issued(val grant: String) : GrantIssueResult()
        data class Cooldown(val eligibleAtEpochMs: Long) : GrantIssueResult()
    }

    data class GrantRequest(val task: Task<GrantIssueResult>, val nonce: String, val deviceIdHash: String, val startedAtElapsedMs: Long)
}
