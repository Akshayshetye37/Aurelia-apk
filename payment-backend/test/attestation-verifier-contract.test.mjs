import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const verifier = await readFile(new URL('../attestation-verifier/src/main/kotlin/com/aurelia/attestation/Main.kt', import.meta.url), 'utf8');
const build = await readFile(new URL('../attestation-verifier/build.gradle.kts', import.meta.url), 'utf8');
const settings = await readFile(new URL('../attestation-verifier/settings.gradle.kts', import.meta.url), 'utf8');
const docker = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/local-server.mjs', import.meta.url), 'utf8');

test('attestation verifier is pinned to the official v0.4 source build', () => {
  assert.match(build, /com\.android\.keyattestation:keyattestation:0\.4/);
  assert.match(settings, /includeBuild\("\/opt\/keyattestation"\)/);
  assert.match(docker, /git clone --depth 1 --branch v0\\.4 https:\/\/github\.com\/android\/keyattestation\\.git/);
  assert.match(docker, /621149c4ebaeeea844d6f43098687c73c4d370a3/);
  assert.match(docker, /aurelia-attestation-verifier\.jar/);
});

test('verifier pins the expected application package and signing certificate digest', () => {
  assert.match(verifier, /ATTESTATION_APP_PACKAGE/);
  assert.match(verifier, /ATTESTATION_APP_MIN_VERSION/);
  assert.match(verifier, /ATTESTATION_APP_SIGNER_SHA256/);
  assert.match(verifier, /expectedAttestationApplicationId = appId/);
});

test('verifier checks Google trust anchors, fresh revocation data and exact challenge', () => {
  assert.match(verifier, /GoogleTrustAnchors/);
  assert.match(verifier, /getRevocationStatusFromWeb/);
  assert.match(verifier, /REVOCATION_TTL_SECONDS/);
  assert.match(verifier, /connectTimeout = 5_000/);
  assert.match(verifier, /readTimeout = 5_000/);
  assert.match(verifier, /ChallengeMatcher\(challenge\)/);
});

test('verifier rejects software keys and insecure verified-boot states', () => {
  assert.match(verifier, /SecurityLevel\.TRUSTED_ENVIRONMENT/);
  assert.match(verifier, /SecurityLevel\.STRONG_BOX/);
  assert.match(verifier, /VerifiedBootState\.VERIFIED/);
  assert.match(verifier, /!result\.deviceLocked/);
  assert.match(verifier, /leaf_public_key_binding_failed/);
});

test('verifier is loopback-only, request-bounded, and included in readiness', () => {
  assert.match(verifier, /InetSocketAddress\("127\.0\.0\.1", 8091\)/);
  assert.match(verifier, /MAX_REQUEST_BYTES/);
  assert.match(server, /127\.0\.0\.1:8091\/healthz/);
  assert.match(server, /device_attestation_verifier_unavailable/);
});

test('enrollment binds challenge and verified attestation metadata to owner and property', () => {
  assert.match(server, /nonce_base64 TEXT/);
  assert.match(server, /owner_id INTEGER, property_id TEXT/);
  assert.match(server, /attestation_challenge_invalid_or_expired/);
  assert.match(server, /attestation_challenge_race_or_expiry/);
  assert.match(server, /attestation_verified_at/);
  assert.match(server, /PAYMENT_DEVICE_ACTIVATED_AFTER_VERIFIED_ATTESTATION/);
});
