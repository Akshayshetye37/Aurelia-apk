package com.aurelia.pms.security

/**
 * Device-side defence in depth only. The backend remains the release authority.
 * This immutable matrix intentionally permits sandbox/UAT handoff only.
 */
internal enum class PaymentImplementationStatus {
    NOT_IMPLEMENTED,
    SANDBOX_ONLY,
    PRODUCTION_READY
}

internal object PaymentReleaseSafeguards {
    private const val LIVE_GATEWAY_COLLECTION = false
    private const val AUTOMATIC_SETTLEMENT = false
    private const val AUTOMATIC_REFUND_POSTING = false

    private val providers = mapOf(
        "razorpay" to PaymentImplementationStatus.SANDBOX_ONLY,
        "cashfree" to PaymentImplementationStatus.SANDBOX_ONLY,
        "payu" to PaymentImplementationStatus.SANDBOX_ONLY,
        "phonepe" to PaymentImplementationStatus.SANDBOX_ONLY,
        "paytm" to PaymentImplementationStatus.SANDBOX_ONLY,
        "jiopay" to PaymentImplementationStatus.SANDBOX_ONLY,
        "ccavenue" to PaymentImplementationStatus.NOT_IMPLEMENTED
    )

    @JvmStatic
    fun assertSandboxCheckoutAllowed(providerInput: String, environmentInput: String) {
        val provider = providerInput.trim().lowercase()
        val environment = environmentInput.trim().lowercase()
        val status = providers[provider] ?: PaymentImplementationStatus.NOT_IMPLEMENTED
        check(status != PaymentImplementationStatus.NOT_IMPLEMENTED) {
            "payment_provider_not_implemented"
        }
        check(status == PaymentImplementationStatus.SANDBOX_ONLY) {
            "payment_provider_not_qualified_for_device_checkout"
        }
        check(!LIVE_GATEWAY_COLLECTION) { "live_gateway_collection_disabled_on_device" }
        val expectedEnvironment = when (provider) {
            "razorpay", "cashfree", "payu", "phonepe" -> "test"
            "paytm" -> "staging"
            "jiopay" -> "uat"
            else -> throw IllegalStateException("payment_provider_not_implemented")
        }
        check(environment == expectedEnvironment) {
            "production_payment_environment_blocked_on_device"
        }
    }

    @JvmStatic
    fun isAutomaticSettlementAllowed(): Boolean = AUTOMATIC_SETTLEMENT

    @JvmStatic
    fun isAutomaticRefundPostingAllowed(): Boolean = AUTOMATIC_REFUND_POSTING

    @JvmStatic
    fun isLiveCollectionAllowed(): Boolean = LIVE_GATEWAY_COLLECTION

    @JvmStatic
    fun publicStatus(): Map<String, String> = providers.mapValues { (_, status) -> status.name }
}
