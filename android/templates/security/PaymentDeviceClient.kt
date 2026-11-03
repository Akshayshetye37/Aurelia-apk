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
import java.util.concurrent.TimeUnit

/**
 * Native-only transport for the signed LAN device protocol.
 *
 * Owner registration/challenge/activation/revocation deliberately remain on
 * the owner-authenticated PMS console. This class never accepts owner cookies,
 * credentials, arbitrary URLs, or WebView-provided signatures.
 *
 * It implements only device-authenticated lease and acknowledgement calls.
 * The caller must durably apply and independently verify a command before it
 * calls acknowledge(). The backend cursor advances only after that call.
 */
class PaymentDeviceClient(
    applianceBaseUrl: String,
    private val deviceId: String,
    private val keyStore: PaymentDeviceKeyStore
) {
    private val baseUri: URI
    private val random = SecureRandom()

    companion object {
        private const val MAX_RESPONSE_BYTES = 1024 * 1024
    }

    init {
        // Device IDs are inserted into signed URL path segments. Restrict the
        // alphabet rather than attempting to repair or ambiguously encode them.
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
        require(keyStore.hasIdentity()) { "Payment device identity is not enrolled." }
    }

    /** Returns the next contiguous command, or null when no command is ready. */
    fun leaseNext(): JSONObject? {
        val response = post("/v1/devices/$deviceId/commands/lease", JSONObject())
        if (!response.has("command") || response.isNull("command")) return null
        return response.getJSONObject("command")
    }

    /**
     * Acknowledges only a command with a caller-supplied durable ledger receipt.
     * This method does not apply the folio and must only be called after the
     * native projector has verified the durable PMS state.
     */
    fun acknowledge(
        command: JSONObject,
        leaseToken: String,
        ledgerAckId: String
    ): JSONObject {
        val commandId = command.getString("commandId")
        val sequenceId = command.getLong("sequenceId")
        val payloadHash = command.getString("payloadHash")
        require(commandId.matches(Regex("[0-9a-fA-F-]{36}"))) { "Invalid command ID." }
        require(sequenceId > 0) { "Invalid command sequence." }
        require(payloadHash.matches(Regex("[a-f0-9]{64}"))) { "Invalid command payload hash." }
        require(leaseToken.matches(Regex("[A-Za-z0-9_-]{40,64}"))) { "Invalid lease token." }
        require(ledgerAckId.isNotBlank() && ledgerAckId.length <= 128 &&
            ledgerAckId.none { it.code < 0x20 || it.code == 0x7f }) { "Invalid durable ledger receipt." }

        val body = JSONObject()
            .put("leaseToken", leaseToken)
            .put("sequenceId", sequenceId)
            .put("payloadHash", payloadHash)
            .put("durableApplied", true)
            .put("ledgerAckId", ledgerAckId)
        return post("/v1/devices/$deviceId/commands/$commandId/ack", body)
    }

    private fun post(path: String, body: JSONObject): JSONObject {
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
