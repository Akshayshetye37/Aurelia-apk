package com.aurelia.pms.security

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Verifies the backend's pinned ECDSA P-256 authorization envelopes before a
 * device command can be considered eligible for local projection.
 *
 * This verifier is independent of WebCrypto and does not authorize folio
 * mutation by itself. The accounting lock and durable local read-back remain
 * separate mandatory controls.
 */
class SettlementEnvelopeVerifier {
    data class Verified(
        val policyLease: JSONObject,
        val authorization: JSONObject?,
        val settlementEnabled: Boolean
    )

    companion object {
        private const val KEY_ID = "aurelia-settlement-2026-01"
        private const val ISSUER = "aurelia-payment-authority"
        private const val AUDIENCE = "aurelia-pms-local-projector"
        private const val LEASE_TYPE = "aurelia.settlement.lease.v2"
        private const val AUTH_TYPE = "aurelia.settlement.authorization.v2"
        private const val PUBLIC_X = "hq9LhX0M21-OF2h2r0RKNDgXOt9t1af_elckOdHzb_Y"
        private const val PUBLIC_Y = "bhHRSvIvR6b05HtYejImWc4kSVizdA85lxyNAVMpIiQ"
        private const val MAX_CLOCK_SKEW_MS = 30_000L
        private const val MAX_LEASE_TTL_MS = 900_000L
        private const val MAX_AUTH_TTL_MS = 300_000L
    }

    fun verify(
        settlement: JSONObject,
        leaseEnvelope: JSONObject,
        authorizationEnvelope: JSONObject?
    ): Verified {
        val policy = verifyEnvelope(leaseEnvelope, LEASE_TYPE)
        val now = System.currentTimeMillis()
        val leaseIssued = parseTime(policy.getString("issuedAt"))
        val leaseExpires = parseTime(policy.getString("expiresAt"))
        require(policy.optString("issuer") == ISSUER && policy.optString("audience") == AUDIENCE) {
            "Settlement policy issuer/audience mismatch."
        }
        require(leaseIssued <= now + MAX_CLOCK_SKEW_MS && leaseExpires > now &&
            leaseExpires > leaseIssued && leaseExpires - leaseIssued <= MAX_LEASE_TTL_MS) {
            "Settlement policy lease is expired or outside its permitted lifetime."
        }
        requireSameScope(policy, settlement)
        val enabled = policy.optBoolean("settlementEnabled", false)
        if (!enabled) {
            require(authorizationEnvelope == null) {
                "Disabled settlement policy must not carry a posting authorization."
            }
            return Verified(policy, null, false)
        }
        require(authorizationEnvelope != null) {
            "Enabled settlement policy requires a signed authorization."
        }
        val auth = verifyEnvelope(authorizationEnvelope, AUTH_TYPE)
        val authIssued = parseTime(auth.getString("issuedAt"))
        val authExpires = parseTime(auth.getString("expiresAt"))
        require(auth.optString("issuer") == ISSUER && auth.optString("audience") == AUDIENCE) {
            "Settlement authorization issuer/audience mismatch."
        }
        require(auth.optString("leaseId") == policy.optString("leaseId")) {
            "Settlement authorization is not bound to the active policy lease."
        }
        require(authIssued <= now + MAX_CLOCK_SKEW_MS &&
            authIssued >= leaseIssued - MAX_CLOCK_SKEW_MS &&
            authExpires > now && authExpires > authIssued &&
            authExpires <= leaseExpires && authExpires - authIssued <= MAX_AUTH_TTL_MS) {
            "Settlement authorization is expired or outside its policy lease."
        }
        requireSameScope(auth, settlement)
        for (field in listOf("commandId", "providerTransactionId", "bookingId", "method", "reference")) {
            require(auth.optString(field) == settlement.optString(field)) {
                "Settlement authorization binding mismatch: $field."
            }
        }
        require(auth.optLong("amountPaise", -1L) == settlement.optLong("amountPaise", -2L) &&
            auth.optLong("amountPaise", -1L) > 0L) {
            "Settlement authorization amount mismatch."
        }
        require(auth.optString("authorizationId").isNotBlank()) {
            "Settlement authorization ID is missing."
        }
        return Verified(policy, auth, true)
    }

    private fun requireSameScope(envelope: JSONObject, settlement: JSONObject) {
        for (field in listOf("tenantId", "deviceId", "provider", "providerAccountId", "environment")) {
            require(envelope.optString(field).isNotBlank() &&
                envelope.optString(field) == settlement.optString(field)) {
                "Settlement signed scope mismatch: $field."
            }
        }
        require(settlement.optString("environment") == "test") {
            "Only the test environment is enabled for this local settlement bridge."
        }
    }

    private fun verifyEnvelope(envelope: JSONObject, expectedType: String): JSONObject {
        require(envelope.length() == 3 && envelope.has("kid") &&
            envelope.has("payload") && envelope.has("signature")) {
            "Malformed settlement signature envelope."
        }
        require(envelope.optString("kid") == KEY_ID) {
            "Settlement signing key is not pinned in this PMS build."
        }
        val payload = envelope.optJSONObject("payload")
            ?: throw IllegalArgumentException("Settlement signature payload is missing.")
        val signatureText = envelope.optString("signature")
        val raw = try {
            Base64.decode(signatureText, Base64.DEFAULT)
        } catch (error: Exception) {
            throw IllegalArgumentException("Settlement signature encoding is invalid.", error)
        }
        require(raw.size == 64) { "Settlement P-256 signature length is invalid." }
        val transcript = JSONObject()
            .put("typ", expectedType)
            .put("kid", KEY_ID)
            .put("payload", payload)
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(pinnedPublicKey())
        verifier.update(canonicalJson(transcript).toByteArray(Charsets.UTF_8))
        require(verifier.verify(rawToDer(raw))) {
            "Settlement signature verification failed."
        }
        return payload
    }

    private fun pinnedPublicKey(): java.security.PublicKey {
        val params = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(ECParameterSpec::class.java)
        val x = BigInteger(1, Base64.decode(PUBLIC_X, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        val y = BigInteger(1, Base64.decode(PUBLIC_Y, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        return KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(ECPoint(x, y), params)
        )
    }

    private fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64)
        fun integer(offset: Int): ByteArray {
            var start = offset
            val end = offset + 32
            while (start < end - 1 && raw[start] == 0.toByte()) start++
            val needsPrefix = (raw[start].toInt() and 0x80) != 0
            val length = end - start + if (needsPrefix) 1 else 0
            return byteArrayOf(0x02, length.toByte()) +
                (if (needsPrefix) byteArrayOf(0) else byteArrayOf()) +
                raw.copyOfRange(start, end)
        }
        val r = integer(0)
        val s = integer(32)
        val length = r.size + s.size
        return byteArrayOf(0x30, length.toByte()) + r + s
    }

    private fun parseTime(value: String): Long {
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
            isLenient = false
        }
        return parser.parse(value)?.time ?: throw IllegalArgumentException("Invalid settlement timestamp.")
    }

    private fun canonicalJson(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted()
            .joinToString(prefix = "{", postfix = "}") { key ->
                JSONObject.quote(key) + ":" + canonicalJson(value.get(key))
            }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") {
            canonicalJson(value.get(it))
        }
        is String -> JSONObject.quote(value)
        is Boolean -> value.toString()
        is Number -> JSONObject.numberToString(value)
        else -> throw IllegalArgumentException("Unsupported value in settlement signature.")
    }
}
