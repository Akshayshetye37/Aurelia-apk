package com.aurelia.pms.identity

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.FirebaseApp
import com.google.firebase.functions.FirebaseFunctions
import com.google.android.gms.tasks.Tasks
import org.json.JSONObject
import com.google.android.gms.tasks.Task
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stores only a tenant ID asserted by a freshly authenticated Firebase owner token.
 * A random local installation ID is not a cloud authorization identity.
 */
object RecoveryTenantIdentity {
    data class Binding(val ownerUid: String, val tenantId: String)

    private const val PREFS = "aurelia_recovery_tenant_v1"
    private const val BLOB = "encrypted_record"
    private const val ALIAS = "aurelia.pms.recovery-tenant.v1"
    private const val AAD = "AURELIA-RECOVERY-TENANT-V1"

    @Synchronized
    fun getOrCreate(context: Context): String {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val blob = prefs.getString(BLOB, null)
        if (blob != null) {
            val decoded = decrypt(blob, context)
            val bound = runCatching { JSONObject(decoded).getString("tenantId") }.getOrElse { decoded }
            if (bound.startsWith("local_")) {
                throw SecurityException("Legacy local-only tenant binding must be re-verified by the property owner in Settings.")
            }
            return bound
        }
        throw SecurityException("This installation is not bound to an authenticated owner tenant.")
    }

    /** Bind setup to the existing primary Firebase owner session; never trust a typed tenant ID. */
    fun bindAuthorizedOwner(context: Context, expectedTenantId: String? = null): Task<String> {
        val user = FirebaseAuth.getInstance().currentUser
            ?: throw SecurityException("Sign in as the property owner before registering a recovery phone.")
        val ownerUid = user.uid.takeIf { it.isNotBlank() && it.length <= 128 }
            ?: throw SecurityException("Authenticated owner UID is invalid.")
        return user.getIdToken(true).continueWithTask { task ->
            if (!task.isSuccessful) throw task.exception ?: SecurityException("Owner identity verification failed.")
            val claims = task.result?.claims ?: throw SecurityException("Owner identity claims are missing.")
            if (claims["role"] != "owner") throw SecurityException("Only the property owner can register recovery security.")
            val tenant = claims["tenantId"] as? String
                ?: throw SecurityException("The owner account has no tenant binding.")
            if (expectedTenantId != null && expectedTenantId != tenant) {
                throw SecurityException("The authenticated owner tenant does not match the requested tenant.")
            }
            require(tenant.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) {
                "The authenticated tenant claim is invalid."
            }
            val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val existingBlob = prefs.getString(BLOB, null)
            val previous = existingBlob?.let { decrypt(it, context) }
            val previousTenant = if (previous == null) null else
                runCatching { JSONObject(previous).getString("tenantId") }.getOrDefault(previous)
            val previousRecord = previous?.let { runCatching { JSONObject(it) }.getOrNull() }
            val previousUid = previousRecord?.optString("ownerUid")?.takeIf { !it.isNullOrBlank() }
            if (existingBlob != null && previousTenant == tenant && previousUid == null) {
                FirebaseFunctions.getInstance(FirebaseApp.getInstance(), "asia-south1")
                    .getHttpsCallable("confirmRecoveryOwnerBinding")
                    .call(mapOf("tenantId" to tenant))
                    .continueWith { confirmTask ->
                        if (!confirmTask.isSuccessful ||
                            (confirmTask.result?.data as? Map<*, *>)?.get("confirmed") != true) {
                            throw confirmTask.exception
                                ?: SecurityException("Legacy recovery owner binding could not be confirmed.")
                        }
                        synchronized(this) { persistOrConfirm(context, tenant, ownerUid) }
                        tenant
                    }
            } else {
                synchronized(this) { persistOrConfirm(context, tenant, ownerUid) }
                Tasks.forResult(tenant)
            }
        }
    }

    /** Read the owner identity written during enrollment; never consult recovery Phone Auth here. */
    @Synchronized
    fun getBinding(context: Context): Binding {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val blob = prefs.getString(BLOB, null)
            ?: throw SecurityException("Owner recovery enrollment is missing.")
        val decoded = decrypt(blob, context)
        val record = runCatching { JSONObject(decoded) }
            .getOrElse { throw SecurityException("Owner recovery enrollment must be refreshed by the primary owner.") }
        val uid = record.optString("ownerUid")
        val tenant = record.optString("tenantId")
        if (uid.isBlank() || uid.length > 128 || !tenant.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) {
            throw SecurityException("Owner recovery enrollment is incomplete.")
        }
        return Binding(uid, tenant)
    }

    @Synchronized
    private fun persistOrConfirm(context: Context, tenant: String, ownerUid: String) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString(BLOB, null)
        if (existing != null) {
            val previous = decrypt(existing, context)
            val previousTenant = runCatching { JSONObject(previous).getString("tenantId") }.getOrElse { previous }
            check(previousTenant == tenant || previousTenant.startsWith("local_")) {
                "This device is already bound to a different owner tenant."
            }
            if (previousTenant == tenant) {
                val existingRecord = runCatching { JSONObject(previous) }.getOrNull()
                val previousUid = existingRecord?.optString("ownerUid")?.takeIf { !it.isNullOrBlank() }
                if (previousUid != null) {
                    check(previousUid == ownerUid) {
                        "This device is bound to a different authenticated owner identity."
                    }
                    return
                }
            }
            // Upgrade the prior tenant-only encrypted enrollment only while a
            // freshly refreshed primary Firebase owner token proves the same tenant.
        }
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (existing == null) {
            check(!store.containsAlias(ALIAS)) {
                "Recovery tenant record is missing; refusing to create a replacement namespace."
            }
        }
        val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(context), GCMParameterSpec(128, nonce))
        cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
        val plain = JSONObject().put("ownerUid", ownerUid).put("tenantId", tenant)
            .toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        val packed = nonce + encrypted
        try {
            check(prefs.edit().putString(BLOB, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()) {
                "Could not persist authenticated recovery tenant binding."
            }
        } finally {
            nonce.fill(0); encrypted.fill(0); packed.fill(0)
        }
    }

    private fun decrypt(blob: String, context: Context): String {
        val packed = Base64.decode(blob, Base64.NO_WRAP)
        require(packed.size > 28)
        val nonce = packed.copyOfRange(0, 12)
        val encrypted = packed.copyOfRange(12, packed.size)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(context), GCMParameterSpec(128, nonce))
            cipher.updateAAD(AAD.toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(encrypted)
            try {
                val decoded = String(plain, Charsets.UTF_8)
                val tenant = runCatching { JSONObject(decoded).getString("tenantId") }.getOrElse { decoded }
                require(tenant.matches(Regex("^[A-Za-z0-9_-]{8,128}$")))
                val record = runCatching { JSONObject(decoded) }.getOrNull()
                if (record != null) {
                    val ownerUid = record.optString("ownerUid")
                    require(ownerUid.isNotBlank() && ownerUid.length <= 128)
                }
                return decoded
            } finally { plain.fill(0) }
        } finally {
            nonce.fill(0); encrypted.fill(0); packed.fill(0)
        }
    }

    private fun key(context: Context): SecretKey {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        if (prefs.contains(BLOB)) {
            throw SecurityException("Persisted recovery state exists but its Keystore key is missing; refusing key regeneration.")
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }
}
