package com.aurelia.pms.security

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec

/** Strict ES256 verifier. Trust anchors are packaged in the APK, never fetched dynamically. */
object RecoveryGrantVerifier {
    sealed interface Result {
        data class Verified(val jti: String, val expiresAtEpochSec: Long) : Result
        data class Fail(val reason: String) : Result
    }

    fun keyId(jwt: String): String {
        require(jwt.length in 100..4096)
        val parts = jwt.split('.')
        require(parts.size == 3 && parts.all { it.isNotEmpty() })
        val header = JSONObject(String(Base64.decode(parts[0], Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING), StandardCharsets.UTF_8))
        require(header.optString("alg") == "ES256" && header.optString("typ") == "JWT")
        val kid = header.optString("kid")
        require(kid.matches(Regex("^[A-Za-z0-9._-]{1,64}$")))
        return kid
    }

    fun pinnedPublicKey(context: Context, kid: String): PublicKey? {
        if (!kid.matches(Regex("^[A-Za-z0-9._-]{1,64}$"))) return null
        return runCatching {
            val pins = JSONObject(context.applicationContext.getString(
                com.aurelia.pms.R.string.recovery_grant_public_keys_json
            ))
            val encoded = pins.optString(kid).takeIf { it.isNotEmpty() } ?: return null
            val der = Base64.decode(encoded, Base64.DEFAULT)
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
            val ec = key as? ECPublicKey ?: return null
            if (ec.params.order.bitLength() != 256) return null
            key
        }.getOrNull()
    }

    private fun decodeUrlBase64(value: String): ByteArray =
        Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun verify(
        jwt: String,
        pinnedPublicKey: PublicKey,
        tenantId: String,
        nonce: String,
        deviceIdHash: String,
        ownerUid: String,
        expectedKid: String,
        nowEpochSec: Long = System.currentTimeMillis() / 1000
    ): Result {
        return try {
            if (jwt.length !in 100..4096) return Result.Fail("size")
            val parts = jwt.split('.')
            if (parts.size != 3 || parts.any { it.isEmpty() }) return Result.Fail("format")
            val headerBytes = decodeUrlBase64(parts[0])
            val payloadBytes = decodeUrlBase64(parts[1])
            val rawSignature = decodeUrlBase64(parts[2])
            if (rawSignature.size != 64) return Result.Fail("signature_length")

            val header = JSONObject(String(headerBytes, StandardCharsets.UTF_8))
            if (header.optString("alg") != "ES256" || header.optString("typ") != "JWT" ||
                header.length() != 3 || !header.optString("kid").matches(Regex("^[A-Za-z0-9._-]{1,64}$"))) {
                return Result.Fail("header")
            }

            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initVerify(pinnedPublicKey)
            signature.update("${parts[0]}.${parts[1]}".toByteArray(StandardCharsets.US_ASCII))
            if (!signature.verify(rawToDer(rawSignature))) return Result.Fail("signature")

            // Signature is verified above using the APK-pinned key. Only now trust
            // the header key identifier and registered claims.
            val kid = header.optString("kid")
            if (kid.isBlank() || kid != expectedKid) return Result.Fail("kid")

            val claims = JSONObject(String(payloadBytes, StandardCharsets.UTF_8))
            fun requiredString(name: String): String? =
                if (!claims.has(name) || claims.isNull(name)) null else claims.optString(name).takeIf { it.isNotBlank() }

            val uid = requiredString("uid") ?: return Result.Fail("uid")
            val tenant = requiredString("tenant") ?: return Result.Fail("tenant")
            val jti = requiredString("jti") ?: return Result.Fail("jti")
            val grantNonce = requiredString("nonce") ?: return Result.Fail("nonce")
            val did = requiredString("did") ?: return Result.Fail("did")
            val issuer = requiredString("iss") ?: return Result.Fail("issuer")
            val audience = requiredString("aud") ?: return Result.Fail("audience")
            val subject = requiredString("sub") ?: return Result.Fail("subject")
            val scope = requiredString("scope") ?: return Result.Fail("scope")
            if (!claims.has("iat") || !claims.has("exp") ||
                claims.isNull("iat") || claims.isNull("exp")) return Result.Fail("time")
            val issuedAt = claims.getLong("iat")
            val expiresAt = claims.getLong("exp")

            if (issuer != "aurelia-recovery") return Result.Fail("issuer")
            if (audience != "aurelia-recovery-client") return Result.Fail("audience")
            if (issuedAt !in 0..(nowEpochSec + 30) || expiresAt <= nowEpochSec ||
                expiresAt <= issuedAt || expiresAt - issuedAt > 300) return Result.Fail("time")

            val nonceMatches = MessageDigest.isEqual(
                grantNonce.toByteArray(StandardCharsets.UTF_8),
                nonce.toByteArray(StandardCharsets.UTF_8)
            )
            if (uid != ownerUid || tenant != tenantId || subject != tenantId ||
                did != deviceIdHash || !nonceMatches || scope != "recovery:continue" ||
                !jti.matches(Regex("^[0-9a-fA-F-]{36}$"))) return Result.Fail("bindings")
            Result.Verified(jti, expiresAt)
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
