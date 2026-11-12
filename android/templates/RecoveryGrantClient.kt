package com.aurelia.pms.identity

import android.content.Context
import com.aurelia.pms.AureliaAppCheck
import com.aurelia.pms.security.RecoveryGate
import com.aurelia.pms.security.RecoveryGrantReplayStore
import com.google.firebase.FirebaseApp
import com.google.firebase.functions.FirebaseFunctions
import com.google.android.gms.tasks.Task
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64

/** Server signature validation/atomic jti consumption is authoritative; this client performs claim preflight and local replay suppression only. */
class RecoveryGrantClient(private val context: Context) {
    private val firebaseApp = FirebaseApp.getInstance().also { AureliaAppCheck.requireInstalled(it) }
    private val functions = FirebaseFunctions.getInstance(firebaseApp, "asia-south1")
    private val replayStore = RecoveryGrantReplayStore(context)

    fun registerRecoveryPhone(phoneIdToken: String, tenantId: String, deviceIdHash: String, currentPhoneIdToken: String? = null): Task<Map<*, *>> =
        functions.getHttpsCallable("registerRecoveryPhone").call(mapOf(
            "phoneIdToken" to phoneIdToken, "tenantId" to tenantId,
            "deviceIdHash" to deviceIdHash, "currentPhoneIdToken" to currentPhoneIdToken
        )).continueWith { task ->
            @Suppress("UNCHECKED_CAST")
            task.result?.data as? Map<*, *> ?: throw IllegalStateException("Phone registration failed.")
        }

    fun issueRecoveryGrant(phoneIdToken: String, tenantId: String): GrantRequest {
        val nonceBytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(nonceBytes)
        nonceBytes.fill(0)
        val deviceHash = com.aurelia.pms.security.RecoveryDeviceIdentity.deviceIdHash()
        val task = functions.getHttpsCallable("issueRecoveryGrant").call(
            mapOf("phoneIdToken" to phoneIdToken, "tenantId" to tenantId, "deviceIdHash" to deviceHash, "nonce" to nonce)
        ).continueWith { result ->
            @Suppress("UNCHECKED_CAST")
            val data = result.result?.data as? Map<*, *> ?: throw IllegalStateException("Recovery authorization failed.")
            data["grant"] as? String ?: throw IllegalStateException("Recovery authorization failed.")
        }
        return GrantRequest(task, nonce, deviceHash)
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
    fun consumeAndArm(grant: String, nonce: String, deviceHash: String, tenantId: String, onResult: (Boolean) -> Unit) {
        val claims = try { inspectClaims(grant, nonce, deviceHash, tenantId) }
        catch (_: Exception) { onResult(false); return }

        if (replayStore.isUsed(claims.jti)) {
            onResult(false)
            return
        }
        consumeRecoveryGrant(grant, nonce, deviceHash).addOnCompleteListener { task ->
            val consumed = task.isSuccessful && task.result == true
            val recorded = if (consumed) runCatching {
                replayStore.markUsed(claims.jti, claims.expiresAt)
            }.getOrDefault(false) else false
            if (consumed && recorded) {
                RecoveryGate.armAfterServerConsumption()
                onResult(true)
            } else {
                RecoveryGate.clear()
                onResult(false)
            }
        }
    }

    private fun inspectClaims(jwt: String, nonce: String, deviceHash: String, tenantId: String): GrantClaims {
        require(jwt.length in 100..4096)
        val parts = jwt.split('.')
        require(parts.size == 3 && parts.all { it.isNotEmpty() })
        val decoder = Base64.getUrlDecoder()
        val header = JSONObject(String(decoder.decode(parts[0]), Charsets.UTF_8))
        require(header.optString("alg") == "ES256" && header.optString("typ") == "JWT" && header.length() == 2)
        val payload = JSONObject(String(decoder.decode(parts[1]), Charsets.UTF_8))
        val now = System.currentTimeMillis() / 1000
        val issuedAt = payload.optLong("iat", -1)
        val expiresAt = payload.optLong("exp", -1)
        val jti = payload.optString("jti")
        require(payload.optString("iss") == "aurelia-recovery")
        require(payload.optString("aud") == "aurelia-recovery-client")
        require(payload.optString("scope") == "recovery:continue")
        require(payload.optString("sub") == tenantId)
        require(payload.optString("did") == deviceHash)
        require(payload.optString("nonce") == nonce)
        require(issuedAt in 1..(now + 30))
        require(expiresAt > now && expiresAt > issuedAt && expiresAt - issuedAt <= 600)
        require(jti.matches(Regex("^[0-9a-fA-F-]{36}$")))
        return GrantClaims(jti, expiresAt)
    }

    private data class GrantClaims(val jti: String, val expiresAt: Long)
    data class GrantRequest(val task: Task<String>, val nonce: String, val deviceIdHash: String)
}
