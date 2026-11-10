package com.aurelia.pms.security;

import static org.junit.Assert.*;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.security.MessageDigest;
import java.security.SecureRandom;

@RunWith(AndroidJUnit4.class)
public final class AureliaSecurityInstrumentedTest {
    private final AureliaCryptoEngine crypto = new AureliaCryptoEngine();
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void pinPolicyRejectsShortRepeatedAndSequentialPins() {
        assertRejected("12345");
        assertRejected("123456");
        assertRejected("654321");
        assertRejected("111111");
        assertRejected("999999");
        crypto.validatePin("481592".toCharArray());
        crypto.validatePin("82649173".toCharArray());
    }

    @Test
    public void base32RecoveryKeyRoundTripsAndChecksumDetectsMutation() {
        byte[] recovery = crypto.createRecoveryKey();
        char[] encoded = crypto.encodeRecoveryKey(recovery);
        try {
            assertEquals(9, new String(encoded).split("-").length);
            assertArrayEquals(recovery, crypto.decodeRecoveryKey(encoded));
            char original = encoded[0];
            encoded[0] = original == 'A' ? 'B' : 'A';
            try {
                crypto.decodeRecoveryKey(encoded);
                fail("Mutated recovery key must fail checksum verification.");
            } catch (SecurityException expected) {
                // Expected checksum rejection.
            }
        } finally {
            recovery = wipe(recovery);
            java.util.Arrays.fill(encoded, '\\u0000');
        }
    }

    @Test
    public void pinAndRecoveryWrappersUnwrapTheIdenticalDek() throws Exception {
        byte[] dek = new byte[32];
        new SecureRandom().nextBytes(dek);
        byte[] recoveryKey = crypto.createRecoveryKey();
        char[] pin = "481592".toCharArray();
        try {
            String pinEnvelope = crypto.wrapDataKey(dek, pin).getJson();
            String recoveryEnvelope = crypto.wrapDataKeyWithRecovery(dek, recoveryKey);
            byte[] fromPin = crypto.unwrapDataKey(pinEnvelope, pin);
            byte[] fromRecovery = crypto.unwrapDataKeyWithRecovery(recoveryEnvelope, recoveryKey);
            try {
                assertTrue(MessageDigest.isEqual(dek, fromPin));
                assertTrue(MessageDigest.isEqual(dek, fromRecovery));
            } finally {
                java.util.Arrays.fill(fromPin, (byte) 0);
                java.util.Arrays.fill(fromRecovery, (byte) 0);
            }
        } finally {
            java.util.Arrays.fill(dek, (byte) 0);
            java.util.Arrays.fill(recoveryKey, (byte) 0);
            java.util.Arrays.fill(pin, '\\u0000');
        }
    }

    @Test
    public void replacementPinWrapperIsReadBackAgainstSameDekAndRecoveryWrapperIsUnchanged() throws Exception {
        byte[] dek = new byte[32];
        new SecureRandom().nextBytes(dek);
        byte[] recoveryKey = crypto.createRecoveryKey();
        char[] oldPin = "481592".toCharArray();
        char[] newPin = "826491".toCharArray();
        try {
            String recoveryEnvelope = crypto.wrapDataKeyWithRecovery(dek, recoveryKey);
            byte[] recovered = crypto.unwrapDataKeyWithRecovery(recoveryEnvelope, recoveryKey);
            String replacement = crypto.wrapDataKey(recovered, newPin).getJson();
            byte[] verified = crypto.unwrapDataKey(replacement, newPin);
            try {
                assertTrue(MessageDigest.isEqual(dek, recovered));
                assertTrue(MessageDigest.isEqual(recovered, verified));
                assertEquals(recoveryEnvelope, crypto.wrapDataKeyWithRecovery(dek, recoveryKey)
                    .replace(recoveryEnvelope, recoveryEnvelope));
            } finally {
                java.util.Arrays.fill(recovered, (byte) 0);
                java.util.Arrays.fill(verified, (byte) 0);
            }
        } finally {
            java.util.Arrays.fill(dek, (byte) 0);
            java.util.Arrays.fill(recoveryKey, (byte) 0);
            java.util.Arrays.fill(oldPin, '\\u0000');
            java.util.Arrays.fill(newPin, '\\u0000');
        }
    }

    @Test
    public void recoveryEnvelopeStoreRetainsPreviousUntilSuccessfulUnlockAcknowledgement() {
        AureliaEnvelopeStore store = new AureliaEnvelopeStore(context);
        String first = "{\\"test\\":\\"before\\"}";
        String second = "{\\"test\\":\\"after\\"}";
        store.delete();
        try {
            store.write(first);
            store.writeRecoveryReplacement(second);
            assertEquals(second, store.read());
            assertTrue(store.hasPreviousEnvelope());
            store.confirmRecoveryPinUnlock();
            assertFalse(store.hasPreviousEnvelope());
        } finally {
            store.delete();
        }
    }

    private static void assertRejected(String pin) {
        try {
            new AureliaCryptoEngine().validatePin(pin.toCharArray());
            fail("Weak PIN accepted: " + pin);
        } catch (IllegalArgumentException expected) {
            // Expected policy rejection.
        }
    }

    private static byte[] wipe(byte[] value) {
        java.util.Arrays.fill(value, (byte) 0);
        return value;
    }
}
