package com.aurelia.pms;

import android.app.Application;
import android.util.Log;

import com.google.firebase.FirebaseApp;\nimport com.aurelia.pms.security.RecoveryGate;
import com.google.firebase.appcheck.FirebaseAppCheck;
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory;

/**
 * Installs Play Integrity App Check before Firebase Auth, Functions or Messaging
 * can issue a network request. Missing Firebase config never blocks local-first use.
 */
public final class AureliaApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();\n        // Load durable recovery authorization before any activity can inspect it.\n        RecoveryGate.INSTANCE.initialize(this);
        try {
            FirebaseApp firebaseApp = FirebaseApp.initializeApp(this);
            if (firebaseApp == null) return;
            FirebaseAppCheck.getInstance(firebaseApp).installAppCheckProviderFactory(
                PlayIntegrityAppCheckProviderFactory.getInstance()
            );
        } catch (RuntimeException error) {
            // Do not expose provider details or tokens. App Check enforcement makes
            // recovery/cloud calls fail closed; local PIN and biometric unlock remain usable.
            Log.w("AureliaAppCheck",
                "App Check initialization failed; cloud recovery remains unavailable.");
        }
    }
}
