# Superseded architecture note

**This document is retained for historical context only.** Its former device-local payment execution target is superseded by the formally selected **Hybrid Production Architecture (Architecture A)**.

The current authority is [HYBRID_PAYMENT_ARCHITECTURE.md](./HYBRID_PAYMENT_ARCHITECTURE.md). The Android application remains offline-first, but merchant credentials, provider API calls, public webhook ingress, authoritative verification, refunds and payment orchestration must run in a trusted publicly reachable backend. Do not implement new production gateway adapters in the Android APK.

The local Docker/LAN payment runtime is development/administration only. It cannot serve as the production webhook endpoint behind ordinary NAT. Live collection remains OFF until all release gates in the current architecture and [DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md](./DEVICE_LOCAL_PAYMENT_ENGINE_SPEC.md) are met.
