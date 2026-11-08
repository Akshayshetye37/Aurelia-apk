package com.aurelia.pms.security

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager

/**
 * Standard Play Integrity client. The server supplies a per-operation requestHash;
 * the returned opaque token must be sent to the backend and decoded there by Google.
 *
 * No verdict is trusted or interpreted on-device. A missing Play Store service,
 * project configuration, or failed request is a hard failure for device enrollment.
 */
class AureliaPlayIntegrityClient(
    context: Context,
    private val cloudProjectNumber: Long
) {
    private val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
    @Volatile private var tokenProvider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null

    init {
        require(cloudProjectNumber > 0L) { "valid_google_cloud_project_number_required" }
    }

    fun prepare(
        onReady: () -> Unit,
        onFailure: (String) -> Unit
    ) {
        val request = StandardIntegrityManager.PrepareIntegrityTokenRequest.builder()
            .setCloudProjectNumber(cloudProjectNumber)
            .build()

        manager.prepareIntegrityToken(request)
            .addOnSuccessListener { provider ->
                tokenProvider = provider
                onReady()
            }
            .addOnFailureListener { error ->
                tokenProvider = null
                onFailure(error.message ?: "play_integrity_prepare_failed")
            }
    }

    fun requestToken(
        serverRequestHash: String,
        onToken: (String) -> Unit,
        onFailure: (String) -> Unit
    ) {
        require(serverRequestHash.isNotBlank() && serverRequestHash.length <= 500) {
            "invalid_play_integrity_request_hash"
        }
        val provider = tokenProvider
        if (provider == null) {
            onFailure("play_integrity_provider_not_prepared")
            return
        }

        val request = StandardIntegrityManager.IntegrityTokenRequest.builder()
            .setRequestHash(serverRequestHash)
            .build()

        provider.request(request)
            .addOnSuccessListener { response ->
                val token = response.token()
                if (token.isBlank()) onFailure("play_integrity_token_empty")
                else onToken(token)
            }
            .addOnFailureListener { error ->
                onFailure(error.message ?: "play_integrity_token_request_failed")
            }
    }
}
