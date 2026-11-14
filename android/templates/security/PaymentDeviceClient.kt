package com.aurelia.pms.security

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Native-only transport for the signed LAN device protocol.
 *
 * This is deliberately transport and protocol validation only. It does not
 * mutate PMS folios, approve accounting, or acknowledge a command on its own.
 * A future projector must require owner/staff approval, persist an idempotent
 * ledger receipt, re-read the folio, and only then call acknowledge(). The cloud
 * acknowledgement remains a device report; a separate trusted accounting
 * receipt is required before the backend may mark a folio as posted.
 */
class PaymentDeviceClient(
    applianceBaseUrl: String,
    private val deviceId: String,
    private val keyStore: PaymentDeviceKeyStore
) {
    data class Lease(
        val command: JSONObject,
        val settlement: JSONObject,
        val policyLease: JSONObject,
        val authorization: JSONObject?,
        val settlementAuthorized: Boolean,
        val signedPolicyLease: JSONObject,
        val signedAuthorization: JSONObject?,
        val leaseToken: String,
        val cursor: Long,
        val leaseExpiresAt: String
    )

    private val baseUri: URI
    private val random = SecureRandom()

    companion object {
        private const val MAX_RESPONSE_BYTES = 1024 * 1024
    }

    init {
        require(deviceId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) {
            "Invalid payment device ID."
        }
        val parsed = URI(applianceBaseUrl)
        require(parsed.scheme.equals("https", ignoreCase = true) &&
            parsed.host != null && parsed.userInfo == null &&
            parsed.query == null && parsed.fragment == null) {
            "Payment appliance must use a trusted HTTPS URL."
        }
        baseUri = URI("https", null, parsed.host, parsed.port,
            parsed.path.trimEnd('/'), null, null)
        require(baseUri.path.isNullOrEmpty() || baseUri.path == "/") {
            "Payment appliance URL must not contain an API path."
        }
        require(keyStore.hasAttestedIdentity()) { "Challenge-attested payment device identity is required." }
    }

    /** Returns a validated lease envelope; the lease token is required for acknowledgement. */
    fun leaseNext(idToken: String? = null): Lease? {
        val response = post("/v1/devices/$deviceId/commands/lease", JSONObject(), idToken)
        if (!response.has("command") || response.isNull("command")) return null
        val command = response.getJSONObject("command")
        val token = response.optString("leaseToken")
        val cursor = response.optLong("cursor", -1L)
        val expiresAt = response.optString("leaseExpiresAt")
        require(token.matches(Regex("[A-Za-z0-9_-]{40,64}"))) {
            "Appliance lease token is missing or malformed."
        }
        require(cursor >= 0L && expiresAt.isNotBlank() && expiresAt.length <= 64 &&
            parseLeaseExpiry(expiresAt) > System.currentTimeMillis()) {
            "Appliance lease metadata is invalid or expired."
        }
        validateCommand(command)
        require(command.getLong("sequenceId") == cursor + 1L) {
            "Appliance returned a non-contiguous command sequence."
        }
        val payload = command.getJSONObject("payload")
        val settlement = payload.getJSONObject("settlement")
        val policyLease = response.optJSONObject("policyLease")
            ?: throw IllegalArgumentException("Signed settlement policy lease is missing.")
        val authorization = response.optJSONObject("authorization")
        val verified = SettlementEnvelopeVerifier().verify(settlement, policyLease, authorization)
        return Lease(command, settlement, verified.policyLease, verified.authorization,
            verified.settlementEnabled, policyLease, authorization, token, cursor, expiresAt)
    }

    /**
     * Acknowledges a command only when the caller supplies the ID of a durable
     * local ledger receipt. This class cannot establish that receipt itself.
     * The cloud endpoint stores it as device-reported metadata only; it does
     * not independently verify the PMS commit or mark accounting as posted.
     * The caller remains responsible for approval, atomic persistence and read-back.
     */
    fun acknowledge(lease: Lease, ledgerAckId: String, idToken: String? = null): JSONObject {
        val command = lease.command
        validateCommand(command)
        require(lease.settlementAuthorized && lease.authorization != null &&
            lease.signedAuthorization != null) {
            "A disabled or unsigned settlement lease cannot be acknowledged as a folio posting."
        }
        // JSONObject is mutable. Re-verify the original signed envelopes at the
        // point of acknowledgement so a caller cannot mutate a previously
        // verified lease or its settlement between leaseNext() and acknowledge().
        val reverified = SettlementEnvelopeVerifier().verify(
            lease.settlement, lease.signedPolicyLease, lease.signedAuthorization
        )
        require(reverified.settlementEnabled && reverified.authorization != null &&
            canonicalJson(reverified.policyLease) == canonicalJson(lease.policyLease) &&
            canonicalJson(reverified.authorization) == canonicalJson(lease.authorization) &&
            canonicalJson(lease.command.getJSONObject("payload").getJSONObject("settlement")) ==
                canonicalJson(lease.settlement)) {
            "Settlement authorization changed after lease verification."
        }
        require(lease.leaseToken.matches(Regex("[A-Za-z0-9_-]{40,64}")) &&
            lease.cursor >= 0L && command.getLong("sequenceId") == lease.cursor + 1L &&
            parseLeaseExpiry(lease.leaseExpiresAt) > System.currentTimeMillis()) {
            "Lease is malformed, expired, or no longer contiguous."
        }
        require(ledgerAckId.isNotBlank() && ledgerAckId.length <= 128 &&
            ledgerAckId.none { it.code < 0x20 || it.code == 0x7f }) {
            "Invalid durable ledger receipt."
        }
        val body = JSONObject()
            .put("leaseToken", lease.leaseToken)
            .put("sequenceId", command.getLong("sequenceId"))
            .put("payloadHash", command.getString("payloadHash"))
            .put("durableApplied", true)
            .put("ledgerAckId", ledgerAckId)
        return post(
            "/v1/devices/$deviceId/commands/${command.getString("commandId")}/ack",
            body, idToken
        )
    }

    private fun validateCommand(command: JSONObject) {
        val commandId = command.optString("commandId")
        val sequenceId = command.optLong("sequenceId", -1L)
        val transactionId = command.optString("transactionId")
        val folioId = command.optString("folioId")
        val amountMinor = command.optLong("amountMinor", -1L)
        val currency = command.optString("currency")
        val payloadHash = command.optString("payloadHash")
        require(commandId.matches(Regex("[0-9a-fA-F-]{36}")) &&
            transactionId.isNotBlank() && transactionId.length <= 128 &&
            folioId.isNotBlank() && folioId.length <= 128 &&
            sequenceId > 0L && amountMinor > 0L && currency == "INR" &&
            payloadHash.matches(Regex("[a-f0-9]{64}"))) {
            "Appliance command envelope is invalid."
        }
        require(command.optString("deviceId") == deviceId) {
            "Appliance command belongs to another device."
        }
        val payloadCanonical = command.optString("payloadCanonical")
        require(payloadCanonical.isNotBlank() && payloadCanonical.length <= 64 * 1024) {
            "Appliance canonical command payload is missing or oversized."
        }
        val actualHash = sha256Hex(payloadCanonical.toByteArray(Charsets.UTF_8))
        require(MessageDigest.isEqual(
            actualHash.toByteArray(Charsets.US_ASCII),
            payloadHash.toByteArray(Charsets.US_ASCII)
        )) { "Appliance command payload hash does not match." }
        val payload = JSONObject(payloadCanonical)
        val suppliedPayload = command.optJSONObject("payload")
            ?: throw IllegalArgumentException("Appliance command payload is missing.")
        require(canonicalJson(payload) == canonicalJson(suppliedPayload)) {
            "Appliance parsed payload differs from its canonical representation."
        }

        require(payload.optString("commandId") == commandId &&
            payload.optString("deviceId") == deviceId &&
            payload.optLong("sequenceId", -1L) == sequenceId &&
            payload.optString("transactionId") == transactionId &&
            payload.optString("folioId") == folioId &&
            payload.optLong("amountMinor", -1L) == amountMinor &&
            payload.optString("currency") == currency) {
            "Appliance command payload binding does not match its envelope."
        }
        val provider = payload.optString("provider")
        val providerAccountId = payload.optString("providerAccountId")
        val settlement = payload.optJSONObject("settlement")
            ?: throw IllegalArgumentException("Appliance settlement binding is missing.")
        require(provider.isNotBlank() && provider.length <= 64 &&
            providerAccountId.isNotBlank() && providerAccountId.length <= 128 &&
            settlement.optString("tenantId").isNotBlank() &&
            settlement.optString("deviceId") == deviceId &&
            settlement.optString("provider") == provider &&
            settlement.optString("providerAccountId") == providerAccountId &&
            settlement.optString("environment") == "test" &&
            settlement.optString("commandId") == commandId &&
            settlement.optString("providerTransactionId") == payload.optString("providerPaymentId") &&
            settlement.optString("bookingId") == folioId &&
            settlement.optString("method") == provider &&
            settlement.optLong("amountPaise", -1L) == amountMinor &&
            settlement.optString("reference") == payload.optString("providerPaymentId")) {
            "Appliance settlement binding is inconsistent."
        }
    }

    private fun post(path: String, body: JSONObject, idToken: String? = null): JSONObject {
        val canonicalBody = canonicalJson(body)
        val bodyBytes = canonicalBody.toByteArray(Charsets.UTF_8)
        val bodyHash = sha256Hex(bodyBytes)
        val timestamp = TimeUnit.MILLISECONDS.toSeconds(System.currentTimeMillis()).toString()
        val nonceBytes = ByteArray(24).also(random::nextBytes)
        val nonce = Base64.encodeToString(
            nonceBytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
        )
        val signature = keyStore.signRequest(
            deviceId, "POST", path, timestamp, nonce, bodyHash
        )
        val connection = (URL(baseUri.toString().trimEnd('/') + path).openConnection() as HttpURLConnection)
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            if (idToken != null) {
                require(idToken.length in 20..8192 && !idToken.any { it.isWhitespace() }) {
                    "A valid Firebase ID token is required for cloud device synchronization."
                }
                connection.setRequestProperty("Authorization", "Bearer " + idToken)
            }
            connection.setRequestProperty("X-Aurelia-Device-Timestamp", timestamp)
            connection.setRequestProperty("X-Aurelia-Device-Nonce", nonce)
            connection.setRequestProperty("X-Aurelia-Device-Signature", signature)
            connection.outputStream.use { it.write(bodyBytes) }
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
                    require(total <= MAX_RESPONSE_BYTES) {
                        "Payment appliance response exceeds the allowed size."
                    }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: ByteArray(0)
            val responseText = responseBytes.toString(Charsets.UTF_8)
            if (status !in 200..299) {
                throw PaymentDeviceProtocolException(status, responseCode(responseText))
            }
            require(connection.contentType?.startsWith("application/json", ignoreCase = true) == true) {
                "Payment appliance returned a non-JSON response."
            }
            return JSONObject(responseText)
        } finally {
            connection.disconnect()
        }
    }

    /** Parses the backend's UTC ISO timestamp without requiring API 26 java.time. */
    private fun parseLeaseExpiry(value: String): Long {
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
            isLenient = false
        }
        return parser.parse(value)?.time ?: throw IllegalArgumentException("Invalid lease expiry timestamp.")
    }

    private fun responseCode(raw: String): String = try {
        JSONObject(raw).optString("error", "payment_device_http_error").take(96)
    } catch (_: Exception) {
        "payment_device_http_error"
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

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
        else -> throw IllegalArgumentException("Unsupported JSON value in signed request.")
    }
}

class PaymentDeviceProtocolException(
    val httpStatus: Int,
    val protocolCode: String
) : IllegalStateException("Payment appliance rejected device request ($httpStatus: $protocolCode).")
