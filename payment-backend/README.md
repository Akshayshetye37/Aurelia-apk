# Aurelia Payment Backend

Separately deployable service; not part of either APK. Razorpay reference adapter only. Production use is blocked until the owner-controlled cloud project, Firebase Identity Platform MFA, Firestore, Secret Manager, least-privilege IAM, owner console and sandbox verification are configured.

Secrets remain server-side in Google Secret Manager. PMS and Pay Bridge receive no API secret or webhook secret. Admin routes require a revoked-token-checked Firebase ID token, deployment-allowlisted UID, verified email, MFA second-factor claim and recent authentication. Use Cloud Run service identity, never service-account key files.

The backend must expose only non-secret status to PMS. Explicit owner activation follows credential validation, verified webhook and independently fetched captured payment. Live activation requires sandbox acceptance. Add rate limiting, alerting, audit export, rotation and recovery testing before production.
