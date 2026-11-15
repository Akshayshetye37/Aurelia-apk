package com.aurelia.pms.printer

import android.app.AlertDialog
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "AureliaPrinter")
class AureliaPrinterPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val activeSockets = ConcurrentHashMap<String, java.net.Socket>()
    private val watchdog = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
    private val tag = "AureliaPrinter"
    private val store by lazy { PrinterTrustStore(context) }

    @PluginMethod
    fun discoverLan(call: PluginCall) {
        // No subnet scanning or unauthenticated service enumeration is enabled.
        // User-selected host trust is the only supported onboarding path currently.
        call.resolve(JSObject().put("candidates", JSArray()))
    }

    @PluginMethod
    fun trustLanPrinter(call: PluginCall) {
        val host = call.getString("host")?.trim()?.lowercase(java.util.Locale.ROOT)
        val port = call.getInt("port") ?: 9100
        if (host.isNullOrBlank() || port != 9100 || !validHostSyntax(host)) {
            call.reject("invalid_endpoint"); return
        }
        executor.execute {
            val addresses = try { InetAddress.getAllByName(host).distinctBy { it.hostAddress } }
            catch (_: Exception) { call.reject("dns_resolution_failed"); return@execute }
            if (addresses.isEmpty() || addresses.size > 16 || addresses.any { !isPrivateOrLinkLocal(it) }) {
                call.reject("untrusted_network_target"); return@execute
            }
            val pinned = addresses.first()
            activity?.runOnUiThread {
                val current = activity
                if (current == null || current.isFinishing || current.isDestroyed) {
                    call.reject("no_activity"); return@runOnUiThread
                }
                AlertDialog.Builder(current)
                    .setTitle("Trust LAN printer?")
                    .setMessage("Allow Aurelia PMS to send print jobs to:\n\n" + host + "\n" + pinned.hostAddress + ":9100\n\nOnly this private-network address will be used. Raw TCP printing is not encrypted.")
                    .setNegativeButton("Cancel") { _, _ -> call.reject("user_cancelled") }
                    .setPositiveButton("Trust printer") { _, _ ->
                        try {
                            val id = store.add(host, pinned, 9100)
                            call.resolve(JSObject().put("ok", true).put("deviceId", id).put("trusted", true))
                        } catch (error: Exception) {
                            Log.e(tag, "Trust record could not be persisted", error)
                            call.reject("trust_store_unavailable")
                        }
                    }.setOnCancelListener { call.reject("user_cancelled") }.show()
            } ?: call.reject("no_activity")
        }
    }

    @PluginMethod
    fun getTrustedLanDevices(call: PluginCall) {
        try {
            val result = JSArray()
            store.list().forEach { r ->
                result.put(JSObject().put("deviceId", r.id).put("host", r.host)
                    .put("port", r.port).put("trustedAt", r.trustedAt)
                    .put("lastSuccessfulWriteAt", r.lastWriteAt).put("profileVerified", r.verified).put("calibratedAt", r.calibratedAt).put("profileHash", r.profileHash))
            }
            call.resolve(JSObject().put("devices", result))
        } catch (error: Exception) {
            Log.e(tag, "Trust store read failed", error); call.reject("trust_store_unavailable")
        }
    }

    @PluginMethod
    fun revokeLanTrust(call: PluginCall) {
        val id = call.getString("deviceId")
        if (id.isNullOrBlank() || !id.matches(Regex("^lan_[a-f0-9]{64}$"))) {
            call.reject("invalid_device_id"); return
        }
        try { store.remove(id); call.resolve(JSObject().put("ok", true)) }
        catch (error: Exception) { Log.e(tag, "Trust revocation failed", error); call.reject("trust_store_unavailable") }
    }

    @PluginMethod
    fun calibrateLanPrinter(call: PluginCall) {
        val id = call.getString("deviceId")
        if (id.isNullOrBlank() || !id.matches(Regex("^lan_[a-f0-9]{64}$"))) { call.reject("device_id_required"); return }
        val record = try { store.get(id) } catch (_: Exception) { call.reject("trust_store_unavailable"); return }
        if (record == null) { call.reject("not_trusted"); return }
        executor.execute {
            val peer = resolvePinnedPeer(record)
            if (peer == null) { call.reject("peer_address_changed_or_public"); return@execute }
            val socket = java.net.Socket()
            try {
                socket.connect(java.net.InetSocketAddress(peer, 9100), 5000)
                val testPage = byteArrayOf(0x1b, 0x40, 0x1b, 0x61, 0x01, 0x41, 0x55, 0x52, 0x45, 0x4c, 0x49, 0x41, 0x0a, 0x54, 0x45, 0x53, 0x54, 0x20, 0x50, 0x41, 0x47, 0x45, 0x0a, 0x0a, 0x0a)
                if (!writeWithHardTimeout(socket, testPage)) { call.reject("calibration_write_uncertain"); return@execute }
                activity?.runOnUiThread {
                    val current = activity
                    if (current == null || current.isFinishing || current.isDestroyed) {
                        call.reject("calibration_confirmation_unavailable"); return@runOnUiThread
                    }
                    AlertDialog.Builder(current)
                        .setTitle("Confirm printer calibration")
                        .setMessage("Did the Aurelia test page print correctly on the selected printer?")
                        .setNegativeButton("No") { _, _ -> call.reject("calibration_not_confirmed") }
                        .setPositiveButton("Yes, correct") { _, _ ->
                            try {
                                val hash = "sha256:" + hex(MessageDigest.getInstance("SHA-256").digest("escpos-test-v1|raw9100".toByteArray(StandardCharsets.UTF_8)))
                                val calibratedAt = System.currentTimeMillis()
                                store.markVerified(id, calibratedAt, hash)
                                call.resolve(JSObject().put("ok", true).put("verified", true)
                                    .put("calibratedAt", calibratedAt).put("profileHash", hash))
                            } catch (_: Exception) { call.reject("calibration_store_unavailable") }
                        }.setOnCancelListener { call.reject("calibration_not_confirmed") }.show()
                } ?: call.reject("calibration_confirmation_unavailable")
            } catch (_: Exception) { call.reject("calibration_connection_failed") }
            finally { try { socket.close() } catch (_: Exception) {} }
        }
    }

    @PluginMethod
    fun verifyLanCapabilities(call: PluginCall) {
        val id = call.getString("deviceId")
        if (id.isNullOrBlank()) { call.reject("not_trusted"); return }
        val record = try { store.get(id) } catch (_: Exception) { call.reject("trust_store_unavailable"); return }
        if (record == null) { call.reject("not_trusted"); return }
        if (!record.verified) { call.reject("printer_profile_calibration_required"); return }
        call.resolve(JSObject().put("ok", true).put("profile", JSObject()
            .put("transport", "tcp").put("protocol", "escpos")
            .put("paperWidthMm", 58).put("printableDots", 384).put("dpi", 203)
            .put("verification", "calibrated").put("verified", true)))
    }

    @PluginMethod
    fun printLan(call: PluginCall) {
        val id = call.getString("deviceId")
        val requestId = call.getString("requestId")
        val kind = call.getString("kind")
        val copies = call.getInt("copies")
        val doc = call.getObject("document")
        if (id.isNullOrBlank() || !id.matches(Regex("^lan_[a-f0-9]{64}$"))) { call.reject("device_id_required"); return }
        if (requestId.isNullOrBlank() || !requestId.matches(Regex("^job_[A-Za-z0-9_-]{8,64}$"))) { call.reject("invalid_request_id"); return }
        if (copies == null || copies !in 1..3) { call.reject("invalid_copy_count"); return }
        if (doc == null) { call.reject("invalid_document"); return }
        val record = try { store.get(id) } catch (_: Exception) { call.reject("trust_store_unavailable"); return }
        if (record == null) { call.reject("not_trusted"); return }
        if (!record.verified || record.profileHash.isNullOrBlank()) { call.reject("printer_profile_calibration_required"); return }
        val validation = DocumentValidator.validate(kind, doc)
        if (!validation.ok) { call.reject(validation.error ?: "invalid_document"); return }
        val layout = doc.optString("layout")
        if (kind == "invoice" || layout == "80mm") { call.reject("printer_profile_layout_mismatch"); return }
        val ledgerKey = id + "|" + requestId
        val prior = try { store.claimJob(ledgerKey) } catch (_: Exception) { call.reject("job_ledger_unavailable"); return }
        if (prior != null) {
            if (prior.optString("error") == "delivery_in_progress") {
                call.resolve(JSObject().put("ok", false).put("status", "uncertain").put("requestId", requestId)
                    .put("duplicate", true).put("error", "delivery_in_progress"))
            } else {
                call.resolve(JSObject().put("ok", prior.optBoolean("ok", false)).put("status", prior.optString("status", "uncertain"))
                    .put("requestId", requestId).put("duplicate", true).put("error", prior.optString("error", "")))
            }
            return
        }
        executor.execute {
            val peer = resolvePinnedPeer(record)
            if (peer == null) { call.reject("peer_address_changed_or_public"); return@execute }
            val socket = java.net.Socket()
            activeSockets[requestId] = socket
            try {
                socket.tcpNoDelay = true
                val bytes = EscPosRenderer.render(kind ?: "", validation.normalizedDocument!!, copies)
                socket.connect(java.net.InetSocketAddress(peer, 9100), 5000)
                val completed = writeWithHardTimeout(socket, bytes)
                val error = if (completed) "printer_acknowledgement_unavailable" else "write_interrupted_delivery_uncertain"
                store.finishJob(ledgerKey, "uncertain", true, error)
                call.resolve(JSObject().put("ok", true).put("status", "uncertain")
                    .put("requestId", requestId).put("error", error))
            } catch (_: Exception) {
                if (socket.isConnected) {
                    store.finishJob(ledgerKey, "uncertain", true, "delivery_uncertain_after_connect")
                    call.resolve(JSObject().put("ok", true).put("status", "uncertain").put("requestId", requestId)
                        .put("error", "delivery_uncertain_after_connect"))
                } else {
                    store.finishJob(ledgerKey, "failed", false, "connection_failed_before_write")
                    call.resolve(JSObject().put("ok", false).put("status", "failed")
                        .put("requestId", requestId).put("error", "connection_failed_before_write"))
                }
            } finally {
                activeSockets.remove(requestId)
                try { socket.close() } catch (_: Exception) {}
            }
        }
    }

    @PluginMethod
    fun cancelJob(call: PluginCall) {
        val jobId = call.getString("jobId")
        if (jobId.isNullOrBlank() || !jobId.matches(Regex("^job_[A-Za-z0-9_-]{8,64}$"))) { call.reject("invalid_job_id"); return }
        // Raw TCP cannot retract bytes already delivered to the printer.
        call.resolve(JSObject().put("ok", false).put("status", "uncertain")
            .put("error", "cancel_not_supported_on_raw_tcp"))
    }

    override fun handleOnDestroy() {
        activeSockets.values.forEach { try { it.close() } catch (_: Exception) {} }
        activeSockets.clear()
        executor.shutdownNow()
        watchdog.shutdownNow()
        super.handleOnDestroy()
    }

    private fun resolvePinnedPeer(record: PrinterTrustStore.Record): InetAddress? {
        val answers = try { InetAddress.getAllByName(record.host).distinctBy { it.hostAddress } } catch (_: Exception) { return null }
        if (answers.isEmpty() || answers.size > 16 || answers.any { !isPrivateOrLinkLocal(it) }) return null
        return answers.firstOrNull { it.address.contentEquals(record.address.address) }
    }

    private fun writeWithHardTimeout(socket: java.net.Socket, bytes: ByteArray): Boolean {
        val timedOut = java.util.concurrent.atomic.AtomicBoolean(false)
        val timeout = watchdog.schedule({
            timedOut.set(true)
            try { socket.close() } catch (_: Exception) {}
        }, 8, java.util.concurrent.TimeUnit.SECONDS)
        return try {
            socket.getOutputStream().write(bytes)
            socket.getOutputStream().flush()
            !timedOut.get()
        } catch (_: Exception) { false }
        finally { timeout.cancel(false) }
    }

    private fun validHostSyntax(host: String): Boolean {
        if (host.length > 253 || host.contains("://") || host.any { it <= ' ' || it in "/@?#[]\\" }) return false
        if (host.matches(Regex("[0-9.]+"))) return host.split('.').size == 4 &&
            host.split('.').all { it.isNotEmpty() && it.length <= 3 && it.toIntOrNull() in 0..255 &&
                (it == "0" || !it.startsWith("0")) }
        if (host.contains(':')) return host.matches(Regex("[0-9a-fA-F:]+"))
        return host.endsWith(".local") && host.split('.').all {
            it.length in 1..63 && it.matches(Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"))
        }
    }

    private fun isPrivateOrLinkLocal(ip: InetAddress): Boolean {
        if (ip.isAnyLocalAddress || ip.isLoopbackAddress || ip.isMulticastAddress) return false
        val b = ip.address
        if (ip is Inet4Address && b.size == 4) {
            val a = b[0].toInt() and 255; val s = b[1].toInt() and 255; val d = b[3].toInt() and 255
            if (a == 10 || a == 192 && s == 168 || a == 172 && s in 16..31) return d != 0 && d != 255
            return a == 169 && s == 254 && d != 0 && d != 255
        }
        if (ip is Inet6Address && b.size == 16) {
            val a = b[0].toInt() and 255; val s = b[1].toInt() and 255
            return a in 0xfc..0xfd || a == 0xfe && (s and 0xc0) == 0x80
        }
        return false
    }
}

private class PrinterTrustStore(context: Context) {
    data class Record(val id: String, val host: String, val address: InetAddress, val port: Int, val trustedAt: Long, val lastWriteAt: Long, val verified: Boolean, val calibratedAt: Long, val profileHash: String?)
    private val file = AtomicFile(File(context.noBackupFilesDir, "printer-trust.v1.enc"))
    private val alias = "com.aurelia.pms.printer-trust.aes256gcm.v1"
    private val lock = Any()

    fun add(host: String, address: InetAddress, port: Int): String = synchronized(lock) {
        val id = "lan_" + hex(MessageDigest.getInstance("SHA-256").digest(
            (host + "|" + address.hostAddress + "|" + port).toByteArray(StandardCharsets.UTF_8)))
        val root = read()
        root.put(id, JSONObject().put("host", host).put("address", address.hostAddress).put("port", port)
            .put("trustedAt", System.currentTimeMillis()).put("lastWriteAt", 0L).put("profileVerified", false).put("calibratedAt", 0L).put("profileHash", ""))
        write(root); id
    }
    fun get(id: String): Record? = synchronized(lock) { parse(id, read().optJSONObject(id)) }
    fun list(): List<Record> = synchronized(lock) {
        val root = read(); val out = mutableListOf<Record>(); val keys = root.keys()
        while (keys.hasNext()) { val k = keys.next(); parse(k, root.optJSONObject(k))?.let(out::add) }
        out
    }
    fun remove(id: String) = synchronized(lock) { val root = read(); root.remove(id); write(root) }
    fun markVerified(id: String, at: Long, profileHash: String) = synchronized(lock) { val root = read(); val record = root.optJSONObject(id) ?: throw IllegalStateException("not_trusted"); record.put("profileVerified", true).put("calibratedAt", at).put("profileHash", profileHash); write(root) }
    fun claimJob(key: String): JSONObject? = synchronized(lock) {
        val root = read()
        val jobs = root.optJSONObject("_jobs") ?: JSONObject()
        val hash = hex(MessageDigest.getInstance("SHA-256").digest(key.toByteArray(StandardCharsets.UTF_8)))
        val now = System.currentTimeMillis()
        val iterator = jobs.keys()
        val stale = mutableListOf<String>()
        while (iterator.hasNext()) {
            val candidate = iterator.next()
            val item = jobs.optJSONObject(candidate)
            if (item == null || now - item.optLong("timestamp", 0L) >= 5 * 60 * 1000L) stale.add(candidate)
        }
        stale.forEach { jobs.remove(it) }
        val previous = jobs.optJSONObject(hash)
        if (previous != null) return@synchronized JSONObject(previous.toString())
        while (jobs.length() >= 200) {
            val first = jobs.keys()
            if (!first.hasNext()) break
            jobs.remove(first.next())
        }
        jobs.put(hash, JSONObject().put("timestamp", now).put("status", "uncertain").put("ok", false).put("error", "delivery_in_progress"))
        root.put("_jobs", jobs)
        write(root)
        null
    }
    fun finishJob(key: String, status: String, ok: Boolean, error: String) = synchronized(lock) {
        val root = read()
        val jobs = root.optJSONObject("_jobs") ?: JSONObject()
        val hash = hex(MessageDigest.getInstance("SHA-256").digest(key.toByteArray(StandardCharsets.UTF_8)))
        jobs.put(hash, JSONObject().put("timestamp", System.currentTimeMillis()).put("status", status).put("ok", ok).put("error", error))
        root.put("_jobs", jobs)
        write(root)
    }

    private fun parse(id: String, o: JSONObject?): Record? {
        if (o == null || !id.matches(Regex("^lan_[a-f0-9]{64}$"))) return null
        return try {
            val host = o.getString("host"); val ip = InetAddress.getByName(o.getString("address"))
            val port = o.getInt("port"); val time = o.getLong("trustedAt"); val last = o.getLong("lastWriteAt")
            val verified = o.optBoolean("profileVerified", false); val calibratedAt = o.optLong("calibratedAt", 0L); val profileHash = o.optString("profileHash").takeIf { it.isNotBlank() }
            val expectedId = "lan_" + hex(MessageDigest.getInstance("SHA-256").digest((host + "|" + ip.hostAddress + "|" + port).toByteArray(StandardCharsets.UTF_8)))
            if (port != 9100 || time <= 0 || !safe(ip) || id != expectedId || (verified && (calibratedAt <= 0 || profileHash == null))) null else Record(id, host, ip, port, time, last, verified, calibratedAt, profileHash)
        } catch (_: Exception) { null }
    }

    private fun safe(ip: InetAddress): Boolean {
        if (ip.isAnyLocalAddress || ip.isLoopbackAddress || ip.isMulticastAddress) return false
        val b = ip.address
        if (ip is Inet4Address) {
            val a = b[0].toInt() and 255; val s = b[1].toInt() and 255; val d = b[3].toInt() and 255
            return (a == 10 || a == 172 && s in 16..31 || a == 192 && s == 168 || a == 169 && s == 254) && d != 0 && d != 255
        }
        if (ip is Inet6Address) {
            val a = b[0].toInt() and 255; val s = b[1].toInt() and 255
            return a in 0xfc..0xfd || a == 0xfe && (s and 0xc0) == 0x80
        }
        return false
    }
    private fun read(): JSONObject {
        if (!file.baseFile.exists()) return JSONObject()
        val data = file.openRead().use { it.readBytes() }
        require(data.size in 29..(128 * 1024)) { "invalid_trust_store_size" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data.copyOfRange(0, 12)))
        cipher.updateAAD("AURELIA_PRINTER_TRUST_V1".toByteArray(StandardCharsets.UTF_8))
        return JSONObject(String(cipher.doFinal(data.copyOfRange(12, data.size)), StandardCharsets.UTF_8))
    }
    private fun write(root: JSONObject) {
        val plain = root.toString().toByteArray(StandardCharsets.UTF_8); require(plain.size <= 64 * 1024)
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, iv))
        cipher.updateAAD("AURELIA_PRINTER_TRUST_V1".toByteArray(StandardCharsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(iv + cipher.doFinal(plain)); stream.fd.sync(); file.finishWrite(stream) }
        catch (e: Exception) { file.failWrite(stream); throw e }
    }
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        return gen.generateKey()
    }
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}

private object DocumentValidator {
    data class Result(val ok: Boolean, val error: String? = null, val normalizedDocument: JSONObject? = null)
    private fun keys(o: JSONObject, required: Set<String>, optional: Set<String> = emptySet()): Boolean {
        val actual = mutableSetOf<String>(); val it = o.keys()
        while (it.hasNext()) actual.add(it.next())
        return actual.containsAll(required) && (required + optional).containsAll(actual)
    }
    private fun text(o: JSONObject, key: String, max: Int): Boolean {
        val s = o.opt(key) as? String ?: return false
        return s.isNotEmpty() && s.length <= max && s == s.trim() && s.none { it.code < 32 || it.code == 127 }
    }
    private fun optional(o: JSONObject, key: String, max: Int) = !o.has(key) || text(o, key, max)
    private fun amount(o: JSONObject, key: String, min: Long = 0, max: Long = 9007199254740991L): Long? {
        val n = o.opt(key) as? Number ?: return null; val d = n.toDouble(); val l = n.toLong()
        return if (d.isFinite() && d == l.toDouble() && l in min..max) l else null
    }
    private fun quantity(o: JSONObject, key: String): Boolean {
        val n = o.opt(key) as? Number ?: return false; val d = n.toDouble()
        return d.isFinite() && d > 0 && d <= 100000 && d * 1000 % 1.0 == 0.0
    }
    // API 23-compatible strict UTC timestamp validation (no java.time runtime dependency).
    private fun date(s: String): Boolean {
        val m = Regex("^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,3}))?Z$").matchEntire(s) ?: return false
        return try {
            val c = java.util.GregorianCalendar(java.util.TimeZone.getTimeZone("UTC"), java.util.Locale.ROOT)
            c.isLenient = false
            c.clear()
            c.set(java.util.Calendar.YEAR, m.groupValues[1].toInt())
            c.set(java.util.Calendar.MONTH, m.groupValues[2].toInt() - 1)
            c.set(java.util.Calendar.DAY_OF_MONTH, m.groupValues[3].toInt())
            c.set(java.util.Calendar.HOUR_OF_DAY, m.groupValues[4].toInt())
            c.set(java.util.Calendar.MINUTE, m.groupValues[5].toInt())
            c.set(java.util.Calendar.SECOND, m.groupValues[6].toInt())
            val fraction = m.groupValues[7]
            c.set(java.util.Calendar.MILLISECOND, if (fraction.isEmpty()) 0 else (fraction + "00").take(3).toInt())
            c.timeInMillis
            true
        } catch (_: Exception) { false }
    }
    private fun array(o: JSONObject, key: String, min: Int, max: Int) = o.optJSONArray(key)?.takeIf { it.length() in min..max }
    private fun hotel(o: JSONObject) = keys(o, setOf("name"), setOf("address", "phone", "gstin")) &&
        text(o, "name", 120) && optional(o, "address", 300) && optional(o, "phone", 32) &&
        (!o.has("gstin") || text(o, "gstin", 15) && o.optString("gstin").matches(Regex("[0-9A-Z]{15}")))
    private fun validLine(o: JSONObject): Boolean {
        if (!keys(o, setOf("description", "category", "quantity", "unitAmountMinor", "totalAmountMinor", "taxRateBps", "taxAmountMinor"))) return false
        return text(o, "description", 180) && o.optString("category") in setOf("room", "pos", "extra_bed", "incidentals", "food", "other") &&
            quantity(o, "quantity") && amount(o, "unitAmountMinor") != null && amount(o, "totalAmountMinor") != null &&
            amount(o, "taxRateBps", 0, 10000) != null && amount(o, "taxAmountMinor") != null
    }
    fun validate(kind: String?, doc: JSObject): Result {
        if (kind !in setOf("invoice", "receipt", "kitchen_ticket")) return Result(false, "unsupported_document_kind")
        if (doc.toString().toByteArray(StandardCharsets.UTF_8).size > 1024 * 1024) return Result(false, "document_too_large")
        return try {
            val d = JSONObject(doc.toString()); val type = d.optString("documentType")
            if (kind == "kitchen_ticket") {
                if (type != "kitchen-ticket" || !keys(d, setOf("documentType", "layout", "hotel", "order", "items")) ||
                    d.optString("layout") !in setOf("58mm", "80mm") || !hotel(d.getJSONObject("hotel"))) return Result(false, "invalid_kitchen_document")
                val order = d.getJSONObject("order")
                if (!keys(order, setOf("number", "createdAt", "outlet"), setOf("table")) || !text(order, "number", 64) ||
                    !text(order, "createdAt", 30) || !date(order.getString("createdAt")) || !text(order, "outlet", 80) ||
                    !optional(order, "table", 32)) return Result(false, "invalid_kitchen_order")
                val items = array(d, "items", 1, 200) ?: return Result(false, "invalid_kitchen_items")
                for (i in 0 until items.length()) {
                    val item = items.optJSONObject(i) ?: return Result(false, "invalid_kitchen_item")
                    if (!keys(item, setOf("name", "quantity"), setOf("modifiers", "notes")) || !text(item, "name", 120) ||
                        !quantity(item, "quantity") || !optional(item, "notes", 240)) return Result(false, "invalid_kitchen_item")
                    if (item.has("modifiers")) {
                        val mods = array(item, "modifiers", 0, 20) ?: return Result(false, "invalid_modifiers")
                        for (j in 0 until mods.length()) if (mods.opt(j) !is String || mods.optString(j).length !in 1..100) return Result(false, "invalid_modifier")
                    }
                }
            } else {
                val expected = if (kind == "invoice") "folio-invoice" else "thermal-receipt"
                if (type != expected || !keys(d, setOf("documentType", "layout", "hotel", "invoice", "guest", "lines", "taxSummary", "payments", "totals"))) return Result(false, "invalid_invoice_document")
                if (expected == "folio-invoice" && d.optString("layout") != "a4" ||
                    expected == "thermal-receipt" && d.optString("layout") !in setOf("58mm", "80mm")) return Result(false, "invalid_layout")
                if (!hotel(d.getJSONObject("hotel"))) return Result(false, "invalid_hotel")
                val inv = d.getJSONObject("invoice"); val guest = d.getJSONObject("guest"); val t = d.getJSONObject("totals")
                if (!keys(inv, setOf("number", "issuedAt", "currency")) || !text(inv, "number", 64) ||
                    !text(inv, "issuedAt", 30) || !date(inv.getString("issuedAt")) ||
                    !text(inv, "currency", 3) || !inv.optString("currency").matches(Regex("[A-Z]{3}")) || inv.optString("currency") == "XXX") return Result(false, "invalid_invoice")
                if (!keys(guest, setOf("name"), setOf("roomNumber", "bookingReference")) || !text(guest, "name", 120) ||
                    !optional(guest, "roomNumber", 32) || !optional(guest, "bookingReference", 64)) return Result(false, "invalid_guest")
                if (!keys(t, setOf("subtotalMinor", "discountMinor", "taxMinor", "grandTotalMinor", "paidMinor", "dueMinor"))) return Result(false, "invalid_totals")
                val subtotal = amount(t, "subtotalMinor") ?: return Result(false, "invalid_totals")
                val discount = amount(t, "discountMinor") ?: return Result(false, "invalid_totals")
                val tax = amount(t, "taxMinor") ?: return Result(false, "invalid_totals")
                val grand = amount(t, "grandTotalMinor") ?: return Result(false, "invalid_totals")
                val paid = amount(t, "paidMinor") ?: return Result(false, "invalid_totals")
                val due = amount(t, "dueMinor") ?: return Result(false, "invalid_totals")
                if (subtotal - discount + tax != grand || paid + due != grand) return Result(false, "totals_do_not_reconcile")
                val lines = array(d, "lines", 1, 300) ?: return Result(false, "invalid_lines")
                var lineSum = 0L
                for (i in 0 until lines.length()) {
                    val l = lines.optJSONObject(i) ?: return Result(false, "invalid_line")
                    if (!validLine(l)) return Result(false, "invalid_line")
                    lineSum = Math.addExact(lineSum, amount(l, "totalAmountMinor")!!)
                }
                val taxes = array(d, "taxSummary", 0, 20) ?: return Result(false, "invalid_tax_summary")
                var taxSum = 0L
                for (i in 0 until taxes.length()) {
                    val x = taxes.optJSONObject(i) ?: return Result(false, "invalid_tax")
                    if (!keys(x, setOf("rateBps", "taxableAmountMinor", "taxAmountMinor")) ||
                        amount(x, "rateBps", 0, 10000) == null || amount(x, "taxableAmountMinor") == null) return Result(false, "invalid_tax")
                    taxSum = Math.addExact(taxSum, amount(x, "taxAmountMinor") ?: return Result(false, "invalid_tax"))
                }
                val payments = array(d, "payments", 0, 100) ?: return Result(false, "invalid_payments")
                var paidSum = 0L
                for (i in 0 until payments.length()) {
                    val p = payments.optJSONObject(i) ?: return Result(false, "invalid_payment")
                    if (!keys(p, setOf("method", "amountMinor"), setOf("reference")) ||
                        p.optString("method") !in setOf("cash", "card", "upi", "bank_transfer", "other") ||
                        amount(p, "amountMinor", 1) == null || !optional(p, "reference", 80)) return Result(false, "invalid_payment")
                    paidSum = Math.addExact(paidSum, amount(p, "amountMinor")!!)
                }
                if (lineSum != subtotal || taxSum != tax || paidSum != paid) return Result(false, "totals_do_not_reconcile")
            }
            Result(true, normalizedDocument = d)
        } catch (_: Exception) { Result(false, "invalid_semantic_document") }
    }
}

private object EscPosRenderer {
    private const val MAX_OUTPUT = 256 * 1024
    private fun clean(value: String) = value.filter { it == '\n' || it == '\t' || it.code >= 32 && it.code != 127 }.take(300)
    fun render(kind: String, doc: JSONObject, copies: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun command(vararg b: Int) { b.forEach { out.write(it and 255) } }
        fun line(s: String) {
            val bytes = clean(s).toByteArray(StandardCharsets.UTF_8)
            require(out.size() + bytes.size + 1 <= MAX_OUTPUT)
            out.write(bytes); out.write(10)
        }
        fun rule() = line("--------------------------------")
        fun money(v: Long, currency: String) = currency + " " + String.format(java.util.Locale.ROOT, "%.2f", v / 100.0)
        command(0x1b, 0x40)
        if (kind == "kitchen_ticket") {
            val order = doc.getJSONObject("order")
            command(0x1b, 0x61, 1); line("KITCHEN TICKET"); line(doc.getJSONObject("hotel").getString("name")); command(0x1b, 0x61, 0)
            line("Order: " + order.getString("number")); line("Outlet: " + order.getString("outlet"))
            if (order.has("table")) line("Table: " + order.getString("table"))
            rule()
            val items = doc.getJSONArray("items")
            for (i in 0 until items.length()) {
                val item = items.getJSONObject(i); line(item.get("quantity").toString() + " x " + item.getString("name"))
                if (item.has("modifiers")) {
                    val mods = item.getJSONArray("modifiers")
                    for (j in 0 until mods.length()) line("  - " + mods.getString(j))
                }
                if (item.has("notes")) line("  NOTE: " + item.getString("notes"))
            }
        } else {
            val hotel = doc.getJSONObject("hotel"); val inv = doc.getJSONObject("invoice")
            val guest = doc.getJSONObject("guest"); val t = doc.getJSONObject("totals")
            command(0x1b, 0x61, 1); line(hotel.getString("name"))
            if (hotel.has("address")) line(hotel.getString("address"))
            if (hotel.has("phone")) line(hotel.getString("phone"))
            command(0x1b, 0x61, 0); rule()
            line("Invoice: " + inv.getString("number")); line("Date: " + inv.getString("issuedAt")); line("Guest: " + guest.getString("name"))
            if (guest.has("roomNumber")) line("Room: " + guest.getString("roomNumber"))
            if (guest.has("bookingReference")) line("Booking: " + guest.getString("bookingReference"))
            rule()
            val lines = doc.getJSONArray("lines")
            for (i in 0 until lines.length()) {
                val l = lines.getJSONObject(i); line(l.getString("description"))
                line(l.get("quantity").toString() + " x " + money(l.getLong("unitAmountMinor"), inv.getString("currency")) +
                    " = " + money(l.getLong("totalAmountMinor"), inv.getString("currency")))
            }
            rule()
            line("Subtotal: " + money(t.getLong("subtotalMinor"), inv.getString("currency")))
            line("Discount: " + money(t.getLong("discountMinor"), inv.getString("currency")))
            line("Tax: " + money(t.getLong("taxMinor"), inv.getString("currency")))
            line("TOTAL: " + money(t.getLong("grandTotalMinor"), inv.getString("currency")))
            line("Paid: " + money(t.getLong("paidMinor"), inv.getString("currency")))
            line("Due: " + money(t.getLong("dueMinor"), inv.getString("currency")))
            rule(); line("PAYMENTS")
            val payments = doc.getJSONArray("payments")
            for (i in 0 until payments.length()) {
                val p = payments.getJSONObject(i); line(p.getString("method") + ": " + money(p.getLong("amountMinor"), inv.getString("currency")))
            }
        }
        line(""); line(""); line(""); command(0x1d, 0x56, 0x42, 0)
        val one = out.toByteArray(); require(one.isNotEmpty() && one.size.toLong() * copies <= MAX_OUTPUT)
        return ByteArray(one.size * copies).also { dest -> repeat(copies) { System.arraycopy(one, 0, dest, it * one.size, one.size) } }
    }
}
