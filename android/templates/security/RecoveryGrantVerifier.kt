package com.aurelia.pms.security

import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.util.Base64

/** Strict ES256 verifier for backend-issued, short-lived recovery grants. */
object RecoveryGrantVerifier {
    sealed interface Result {
        data object Ok : Result
        data class Fail(val reason: String) : Result
    }

    fun verify(
        jwt: String,
        pinnedPublicKey: PublicKey,
        tenantId: String,
        nonce: String,
        deviceIdHash: String,
        markJtiUsed: (String) -> Boolean,
        nowEpochSec: Long = System.currentTimeMillis() / 1000
    ): Result {
        return try {
            if (jwt.length !in 100..4096) return Result.Fail("size")
            val parts = jwt.split('.')
            if (parts.size != 3 || parts.any { it.isEmpty() }) return Result.Fail("format")
            val decoder = Base64.getUrlDecoder()
            val headerBytes = decoder.decode(parts[0])
            val payloadBytes = decoder.decode(parts[1])
            val rawSignature = decoder.decode(parts[2])
            if (rawSignature.size != 64) return Result.Fail("signature_length")

            val header = JSONObject(String(headerBytes, StandardCharsets.UTF_8))
            if (header.optString("alg") != "ES256" || header.optString("typ") != "JWT" ||
                header.length() != 2) return Result.Fail("header")

            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initVerify(pinnedPublicKey)
            signature.update("${parts[0]}.${parts[1]}".toByteArray(StandardCharsets.US_ASCII))
            if (!signature.verify(rawToDer(rawSignature))) return Result.Fail("signature")

            val claims = JSONObject(String(payloadBytes, StandardCharsets.UTF_8))
            val issuedAt = claims.optLong("iat", -1)
            val expiresAt = claims.optLong("exp", -1)
            val jti = claims.optString("jti")
            val nonceMatches = MessageDigest.isEqual(
                claims.optString("nonce").toByteArray(StandardCharsets.UTF_8),
                nonce.toByteArray(StandardCharsets.UTF_8)
            )
            val valid = claims.optString("iss") == "aurelia-recovery" &&
                claims.optString("aud") == "aurelia-recovery-client" &&
                claims.optString("scope") == "recovery:continue" &&
                claims.optString("sub") == tenantId &&
                claims.optString("did") == deviceIdHash &&
                nonceMatches && issuedAt in 0..(nowEpochSec + 30) &&
                expiresAt > nowEpochSec && expiresAt > issuedAt &&
                expiresAt - issuedAt <= 300 && jti.matches(Regex("^[0-9a-fA-F-]{36}$"))
            if (!valid) return Result.Fail("claims")
            if (!markJtiUsed(jti)) return Result.Fail("replay")
            Result.Ok
        } catch (_: Exception) {
            Result.Fail("malformed")
        }
    }

    private fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64)
        fun encodeInteger(source: ByteArray): ByteArray {
            var first = 0
            while (first < source.lastIndex && source[first] == 0.toByte()) first++
            var value = source.copyOfRange(first, source.size)
            if ((value[0].toInt() and 0x80) != 0) value = byteArrayOf(0) + value
            return byteArrayOf(0x02, value.size.toByte()) + value
        }
        val body = encodeInteger(raw.copyOfRange(0, 32)) + encodeInteger(raw.copyOfRange(32, 64))
        require(body.size < 128)
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}
