package com.aurelia.pms.security

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/**
 * Cloud enrollment coordinator for the server-owned challenge -> Play Integrity
 * -> Android Key Attestation -> owner activation workflow.
 *
 * Callbacks are delivered from background/listener threads. This class never
 * activates the device; the tenant owner must approve activation separately.
 */
class CloudPaymentDeviceEnrollmentClient(
    backendBaseUrl: String,
    private val deviceId: String,
    private val keyStore: PaymentDeviceKeyStore,
    private val playIntegrity: AureliaPlayIntegrityClient
) {
    data class EnrollmentResult(
        val deviceId: String,
        val status: String,
        val attestationSecurityLevel: String
    )

    private val baseUri: URI

    init {
        require(deviceId.matches(Regex("[A-Za-z0-9_-]{6,64}"))) {
            "invalid_payment_device_id"
        }
        val parsed = URI(backendBaseUrl)
        require(parsed.scheme.equals("https", true) && parsed.host != null &&
            parsed.userInfo == null && parsed.query == null && parsed.fragment == null) {
            "payment_backend_must_use_https"
        }
        baseUri = URI("https", null, parsed.host, parsed.port,
            parsed.path.trimEnd('/'), null, null)
        require(baseUri.path.isNullOrEmpty() || baseUri.path == "/") {
            "payment_backend_base_url_must_not_contain_path"
        }
    }

    fun enroll(
        firebaseIdToken: String,
        onComplete: (EnrollmentResult) -> Unit,
        onFailure: (String) -> Unit
    ) {
        if (firebaseIdToken.length !in 20..8192 || firebaseIdToken.any { it.isWhitespace() }) {
            onFailure("verified_firebase_id_token_required")
            return
        }

        // Warm the Standard Integrity provider first. No attested key is created
        // until Play Integrity can issue a token for this server challenge.
        playIntegrity.prepare(
            onReady = {
                Thread({
                    try {
                        val challenge = post(
                            "/v1/admin/devices/enrollment/challenge",
                            JSONObject().put("deviceId", deviceId),
                            firebaseIdToken,
                            expectedStatus = 201
                        )
                        val challengeId = challenge.getString("challengeId")
                        val nonce = challenge.getString("nonce")
                        val requestHash = challenge.getString("playIntegrityRequestHash")
                        require(challengeId.matches(Regex("[0-9a-fA-F-]{36}")) &&
                            nonce.matches(Regex("[A-Za-z0-9_-]{40,64}")) &&
                            requestHash.matches(Regex("[A-Za-z0-9_-]{43}"))) {
                            "payment_device_enrollment_challenge_invalid"
                        }

                        playIntegrity.requestToken(
                            requestHash,
                            onToken = { integrityToken ->
                                Thread({
                                    try {
                                        val challengeBytes = Base64.decode(
                                            nonce, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
                                        )
                                        val identity = keyStore.createAttestedIdentity(challengeBytes)
                                        val chain = JSONArray()
                                        identity.certificateChainBase64.forEach { certificate -> chain.put(certificate) }
                                        val body = JSONObject()
                                            .put("deviceId", deviceId)
                                            .put("challengeId", challengeId)
                                            .put("publicKeyPem", identity.publicKeyPem)
                                            .put("certificateChainBase64", chain)
                                            .put("integrityToken", integrityToken)
                                        val response = post(
                                            "/v1/admin/devices/enroll", body,
                                            firebaseIdToken, expectedStatus = 202
                                        )
                                        val status = response.optString("status")
                                        require(status == "PENDING") {
                                            "payment_device_enrollment_not_pending"
                                        }
                                        onComplete(EnrollmentResult(
                                            deviceId, status,
                                            response.optString("attestationSecurityLevel", identity.securityLevel)
                                        ))
                                    } catch (error: Exception) {
                                        onFailure(error.message ?: "payment_device_enrollment_failed")
                                    }
                                }, "AureliaDeviceEnrollSubmit").start()
                            },
                            onFailure = onFailure
                        )
                    } catch (error: Exception) {
                        onFailure(error.message ?: "payment_device_challenge_failed")
                    }
                }, "AureliaDeviceEnrollChallenge").start()
            },
            onFailure = onFailure
        )
    }

    private fun post(
        path: String,
        body: JSONObject,
        firebaseIdToken: String,
        expectedStatus: Int
    ): JSONObject {
        val connection = (URL(baseUri.toString().trimEnd('/') + path)
            .openConnection() as HttpURLConnection)
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer " + firebaseIdToken)
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            val bytes = body.toString().toByteArray(Charsets.UTF_8)
            require(bytes.size <= 500 * 1024) { "payment_device_enrollment_payload_too_large" }
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBytes = stream?.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= 64 * 1024) { "payment_device_enrollment_response_too_large" }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: ByteArray(0)
            val responseText = responseBytes.toString(Charsets.UTF_8)
            if (status != expectedStatus) {
                val code = try { JSONObject(responseText).optString("error") }
                    catch (_: Exception) { "payment_device_enrollment_http_error" }
                throw IllegalStateException(code.ifBlank { "payment_device_enrollment_http_error" })
            }
            require(connection.contentType?.startsWith("application/json", true) == true) {
                "payment_device_enrollment_non_json_response"
            }
            return JSONObject(responseText)
        } finally {
            connection.disconnect()
        }
    }
}
