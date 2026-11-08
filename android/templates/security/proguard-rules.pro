# AURELIA_PAYMENT_SDK_KEEP_RULES
# Keep public SDK entry points used through reflection, callbacks and SDK handoffs.
-keep class com.razorpay.** { *; }
-dontwarn com.razorpay.**

-keep class com.cashfree.** { *; }
-dontwarn com.cashfree.**

-keep class com.paytm.** { *; }
-dontwarn com.paytm.**
