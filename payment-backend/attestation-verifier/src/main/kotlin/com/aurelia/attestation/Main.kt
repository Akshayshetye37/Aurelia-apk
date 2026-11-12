package com.aurelia.attestation

import com.android.keyattestation.verifier.AttestationApplicationId
import com.android.keyattestation.verifier.AttestationPackageInfo
import com.android.keyattestation.verifier.GoogleTrustAnchors
import com.android.keyattestation.verifier.SecurityLevel
import com.android.keyattestation.verifier.VerificationResult
import com.android.keyattestation.verifier.VerifiedBootState
import com.android.keyattestation.verifier.Verifier
import com.android.keyattestation.verifier.getRevocationStatusFromWeb
import com.android.keyattestation.verifier.challengecheckers.ChallengeMatcher
import com.google.protobuf.ByteString
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URI
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.time.Duration
import java.time.Instant
import java.util.HexFormat
import java.util.concurrent.Executors

private val gson = Gson()
private const val MAX_REQUEST_BYTES = 512 * 1024
private const val REVOCATION_TTL_SECONDS = 6 * 60 * 60L

private class GoogleRevocationCache {
    @Volatile private var revokedSerials: Set<String>? = null
    @Volatile private var refreshedAt: Instant? = null

    @Synchronized
    fun get(): Set<String> {
        val now = Instant.now()
        val lastRefresh = refreshedAt
        if (revokedSerials == null || lastRefresh == null ||
            Duration.between(lastRefresh, now).seconds >= REVOCATION_TTL_SECONDS) {
            val url = URI.create("https://android.googleapis.com/attestation/status").toURL()
            val fresh = getRevocationStatusFromWeb(url) { target ->
                (target.openConnection() as? HttpURLConnection
                    ?: throw IllegalStateException("Revocation endpoint is not HTTP"))
                    .apply {
                        connectTimeout = 5_000
                        readTimeout = 5_000
                        instanceFollowRedirects = false
                    }
            }
            revokedSerials = fresh
            refreshedAt = now
        }
        return revokedSerials ?: throw IllegalStateException("Revocation status unavailable")
    }

    fun isFresh(): Boolean {
        val timestamp = refreshedAt ?: return false
        return Duration.between(timestamp, Instant.now()).seconds < REVOCATION_TTL_SECONDS
    }
}

private fun requiredEnv(name: String): String =
    System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
        ?: throw IllegalStateException("$name is required")

private val appId: AttestationApplicationId by lazy {
    val packageName = requiredEnv("ATTESTATION_APP_PACKAGE")
    val minVersion = requiredEnv("ATTESTATION_APP_MIN_VERSION").toLongOrNull()
        ?.takeIf { it > 0 } ?: throw IllegalStateException("ATTESTATION_APP_MIN_VERSION must be positive")
    val signerDigest = requiredEnv("ATTESTATION_APP_SIGNER_SHA256")
    require(signerDigest.matches(Regex("(?i)[a-f0-9]{64}"))) {
        "ATTESTATION_APP_SIGNER_SHA256 must be a SHA-256 certificate digest"
    }
    AttestationApplicationId(
        packages = setOf(AttestationPackageInfo(packageName, java.math.BigInteger.valueOf(minVersion))),
        signatures = setOf(ByteString.copyFrom(HexFormat.of().parseHex(signerDigest)))
    )
}

private fun respond(exchange: HttpExchange, status: Int, payload: JsonObject) {
    val bytes = gson.toJson(payload).toByteArray(Charsets.UTF_8)
    exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
    exchange.responseHeaders.set("Cache-Control", "no-store")
    exchange.sendResponseHeaders(status, bytes.size.toLong())
    exchange.responseBody.use { it.write(bytes) }
}

private fun readBounded(exchange: HttpExchange): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    exchange.requestBody.use { input ->
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_REQUEST_BYTES) {
                throw IllegalArgumentException("request_too_large")
            }
            output.write(buffer, 0, count)
        }
    }
    return output.toByteArray()
}

private fun failure(reason: String): JsonObject =
    JsonObject().apply {
        addProperty("status", "REJECTED")
        addProperty("reason", reason)
    }

fun main() {
    val revocations = GoogleRevocationCache()
    // Load a fresh Google status list before declaring the verifier ready.
    // A network or parse failure prevents startup and therefore enrollment.
    revocations.get()
    val verifier = Verifier(
        GoogleTrustAnchors,
        revocations::get,
        { Instant.now() },
        expectedAttestationApplicationId = appId
    )

    val server = HttpServer.create(InetSocketAddress(System.getenv("ATTESTATION_BIND_HOST") ?: "127.0.0.1", System.getenv("PORT")?.toIntOrNull() ?: 8091), 0)
    server.executor = Executors.newFixedThreadPool(4)

    server.createContext("/healthz") { exchange ->
        if (exchange.requestMethod != "GET") {
            respond(exchange, 405, failure("method_not_allowed"))
        } else if (!revocations.isFresh()) {
            respond(exchange, 503, failure("revocation_status_stale"))
        } else {
            respond(exchange, 200, JsonObject().apply { addProperty("ok", true) })
        }
    }

    server.createContext("/verify") { exchange ->
        if (exchange.requestMethod != "POST") {
            respond(exchange, 405, failure("method_not_allowed"))
            return@createContext
        }
        try {
            val request = gson.fromJson(readBounded(exchange).toString(Charsets.UTF_8), JsonObject::class.java)
                ?: throw IllegalArgumentException("invalid_json")
            val chainJson = request.getAsJsonArray("certificateChainBase64")
                ?: throw IllegalArgumentException("certificate_chain_required")
            if (chainJson.size() !in 2..8) throw IllegalArgumentException("certificate_chain_length_invalid")
            val chainBytes = chainJson.map { item ->
                val encoded = item.asString
                if (encoded.length !in 128..90_000) throw IllegalArgumentException("certificate_size_invalid")
                java.util.Base64.getDecoder().decode(encoded)
            }
            val factory = CertificateFactory.getInstance("X.509")
            val chain = chainBytes.map { bytes ->
                factory.generateCertificate(bytes.inputStream()) as X509Certificate
            }
            val challenge = java.util.Base64.getUrlDecoder().decode(
                request.get("challengeBase64")?.asString ?: throw IllegalArgumentException("challenge_required")
            )
            if (challenge.size !in 16..128) throw IllegalArgumentException("challenge_length_invalid")

            val result = verifier.verify(chain, ChallengeMatcher(challenge))
            when (result) {
                is VerificationResult.Success -> {
                    if (result.securityLevel != SecurityLevel.TRUSTED_ENVIRONMENT &&
                        result.securityLevel != SecurityLevel.STRONG_BOX) {
                        respond(exchange, 422, failure("hardware_security_level_required"))
                        return@createContext
                    }
                    if (result.verifiedBootState != VerifiedBootState.VERIFIED || !result.deviceLocked) {
                        respond(exchange, 422, failure("verified_locked_boot_required"))
                        return@createContext
                    }
                    val leafKey = chain.first().publicKey.encoded
                    if (!MessageDigest.isEqual(leafKey, result.publicKey.encoded)) {
                        respond(exchange, 422, failure("leaf_public_key_binding_failed"))
                        return@createContext
                    }
                    respond(exchange, 200, JsonObject().apply {
                        addProperty("status", "VERIFIED")
                        addProperty("publicKeySpkiBase64", java.util.Base64.getEncoder().encodeToString(result.publicKey.encoded))
                        addProperty("securityLevel", result.securityLevel.name)
                        addProperty("verifiedBootState", result.verifiedBootState.name)
                        addProperty("deviceLocked", result.deviceLocked)
                    })
                }
                VerificationResult.ChallengeMismatch -> respond(exchange, 422, failure("challenge_mismatch"))
                is VerificationResult.PathValidationFailure -> respond(exchange, 422, failure("certificate_path_invalid"))
                is VerificationResult.ChainParsingFailure -> respond(exchange, 422, failure("certificate_chain_invalid"))
                is VerificationResult.ExtensionParsingFailure -> respond(exchange, 422, failure("attestation_extension_invalid"))
                is VerificationResult.ConstraintViolation -> respond(exchange, 422, failure("attestation_constraint_failed"))
                VerificationResult.SoftwareAttestationUnsupported -> respond(exchange, 422, failure("software_attestation_unsupported"))
            }
        } catch (error: Exception) {
            System.err.println("Attestation verification request rejected: ${error.javaClass.simpleName}: ${error.message}")
            respond(exchange, 400, failure("attestation_request_invalid"))
        }
    }

    server.start()
    System.err.println("Aurelia Android Key Attestation verifier listening on 127.0.0.1:8091")
}
