package com.aurelia.pms.security;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the local, pre-network grant gate with real ES256 signatures. */
@RunWith(AndroidJUnit4.class)
public final class RecoveryGrantVerifierInstrumentedTest {
  private static final long NOW = 1_800_000_000L;
  private static final String KID = "test-key-1";
  private static final String UID = "owner-uid-123";
  private static final String TENANT = "tenant-test-123";
  private static final String NONCE = "nonce-test-123";
  private static final String DID = "device-hash-test-123";

  @Test public void rejectsInvalidGrantsBeforeAnyRecoveryGateCanArm() throws Exception {
    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair pair = generator.generateKeyPair();

    assertRejected(pair, claims(), UID + "-wrong", TENANT, KID);
    assertRejected(pair, claims(), UID, TENANT + "-wrong", KID);

    for (String missing : new String[] {"uid", "tenant", "jti", "nonce", "did"}) {
      JSONObject payload = claims();
      payload.remove(missing);
      assertRejected(pair, payload, UID, TENANT, KID);
    }

    JSONObject legacy = claims();
    legacy.remove("uid");
    assertRejected(pair, legacy, UID, TENANT, KID);

    String valid = sign(pair, claims(), KID);
    String[] parts = valid.split("\\.");
    byte[] signature = Base64.decode(parts[2], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    signature[signature.length - 1] ^= 1;
    String badSignature = parts[0] + "." + parts[1] + "." +
        Base64.encodeToString(signature, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    assertRejectedToken(pair, badSignature, UID, TENANT, KID);

    // The signature is valid, but this kid is not the pinned key identifier selected by the caller.
    assertRejectedToken(pair, valid, UID, TENANT, "unknown-key");
    assertRejectedToken(pair, sign(pair, claims(), null), UID, TENANT, KID);
  }

  private static void assertRejected(KeyPair pair, JSONObject payload, String uid,
      String tenant, String expectedKid) throws Exception {
    assertRejectedToken(pair, sign(pair, payload, KID), uid, tenant, expectedKid);
  }

  private static void assertRejectedToken(KeyPair pair, String jwt, String uid,
      String tenant, String expectedKid) {
    RecoveryGate.clear();
    RecoveryGrantVerifier.Result result = RecoveryGrantVerifier.INSTANCE.verify(
        jwt, pair.getPublic(), tenant, NONCE, DID, uid, expectedKid, NOW);
    assertFalse("invalid local grant must be rejected",
        result instanceof RecoveryGrantVerifier.Result.Verified);
    assertFalse("invalid grant must not arm the local recovery gate", RecoveryGate.isOpen());
  }

  private static JSONObject claims() throws Exception {
    return new JSONObject()
        .put("uid", UID).put("tenant", TENANT).put("sub", TENANT)
        .put("did", DID).put("nonce", NONCE).put("jti", UUID.randomUUID().toString())
        .put("iss", "aurelia-recovery").put("aud", "aurelia-recovery-client")
        .put("scope", "recovery:continue").put("iat", NOW - 1).put("exp", NOW + 299);
  }

  private static String sign(KeyPair pair, JSONObject payload, String kid) throws Exception {
    JSONObject header = new JSONObject().put("alg", "ES256").put("typ", "JWT");
    if (kid != null) header.put("kid", kid);
    String first = Base64.encodeToString(header.toString().getBytes(StandardCharsets.UTF_8),
        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    String second = Base64.encodeToString(payload.toString().getBytes(StandardCharsets.UTF_8),
        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    byte[] input = (first + "." + second).getBytes(StandardCharsets.US_ASCII);
    Signature signer = Signature.getInstance("SHA256withECDSA");
    signer.initSign(pair.getPrivate());
    signer.update(input);
    byte[] raw = derToRaw(signer.sign());
    return first + "." + second + "." +
        Base64.encodeToString(raw, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
  }

  private static byte[] derToRaw(byte[] der) {
    int offset = 2;
    if ((der[offset] & 0xff) != 0x02) throw new IllegalArgumentException("Invalid ECDSA DER");
    int rLength = der[offset + 1] & 0xff;
    byte[] r = new byte[32];
    System.arraycopy(der, offset + 2 + Math.max(0, rLength - 32), r,
        Math.max(0, 32 - rLength), Math.min(32, rLength));
    offset += 2 + rLength;
    if ((der[offset] & 0xff) != 0x02) throw new IllegalArgumentException("Invalid ECDSA DER");
    int sLength = der[offset + 1] & 0xff;
    byte[] s = new byte[32];
    System.arraycopy(der, offset + 2 + Math.max(0, sLength - 32), s,
        Math.max(0, 32 - sLength), Math.min(32, sLength));
    byte[] raw = new byte[64];
    System.arraycopy(r, 0, raw, 0, 32);
    System.arraycopy(s, 0, raw, 32, 32);
    return raw;
  }
}
