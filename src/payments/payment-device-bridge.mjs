const pending = new Map();
const nativeTimeoutMs = 30_000;

function nativeRequest(type, payload = {}, timeoutMs = nativeTimeoutMs) {
  if (!window.AureliaNative || typeof window.AureliaNative.postMessage !== "function") {
    return Promise.reject(Object.assign(new Error("Aurelia Android native bridge is unavailable"), { code: "NATIVE_BRIDGE_UNAVAILABLE" }));
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(new Error("Native payment-device operation timed out"), { code: "NATIVE_BRIDGE_TIMEOUT" }));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { window.AureliaNative.postMessage(JSON.stringify({ type, requestId, ...payload })); }
    catch (error) {
      clearTimeout(timer); pending.delete(requestId); reject(error);
    }
  });
}

window.aureliaNativePaymentDeviceResult = (requestId, ok, raw) => {
  const item = pending.get(requestId);
  if (!item) return;
  clearTimeout(item.timer);
  pending.delete(requestId);
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { item.reject(new Error("Native payment-device response was not valid JSON")); return; }
  if (ok === true) item.resolve(value);
  else item.reject(Object.assign(new Error(value?.error || "Native payment-device operation failed"), {
    code: value?.error || "NATIVE_PAYMENT_DEVICE_FAILED"
  }));
};

async function postJson(baseUrl, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method: "POST", credentials: "include", mode: "cors", redirect: "error",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body), signal: controller.signal
    });
    const type = response.headers.get("content-type") || "";
    if (!type.toLowerCase().includes("application/json")) throw new Error("Payment appliance returned a non-JSON response");
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result?.error || "Payment appliance request failed"), {
      code: result?.error || "PAYMENT_APPLIANCE_HTTP_ERROR", status: response.status
    });
    return result;
  } finally { clearTimeout(timer); }
}

export async function enrollPaymentDevice({ applianceBaseUrl, deviceId = crypto.randomUUID() } = {}) {
  const base = new URL(applianceBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
      (base.pathname !== "/" && base.pathname !== "")) throw new TypeError("A trusted HTTPS appliance origin is required");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) throw new TypeError("Invalid payment device ID");

  const challenge = await postJson(base.origin, "/v1/admin/devices/enrollment/challenge", { deviceId });
  if (!challenge?.challengeId || !challenge?.nonce) throw new Error("Appliance returned an invalid attestation challenge");
  const identity = await nativeRequest("paymentDeviceCreateAttestedIdentity", {
    challengeBase64: challenge.nonce
  }, 60_000);
  if (!identity?.publicKeyPem || !Array.isArray(identity.certificateChainBase64) ||
      identity.certificateChainBase64.length < 1) throw new Error("Android Keystore did not return a valid attested identity");

  const enrollment = await postJson(base.origin, "/v1/admin/devices/enroll", {
    deviceId, challengeId: challenge.challengeId,
    publicKeyPem: identity.publicKeyPem,
    certificateChainBase64: identity.certificateChainBase64
  });
  if (!["PENDING", "ACTIVE"].includes(enrollment?.status)) throw new Error("Appliance did not accept the attested device enrollment");
  const activation = await postJson(base.origin, "/v1/admin/devices/" + encodeURIComponent(deviceId) + "/activate", {});
  if (activation?.status !== "ACTIVE") throw new Error("Owner-controlled device activation did not complete");

  const configured = await nativeRequest("paymentDeviceConfigure", {
    applianceBaseUrl: base.origin, deviceId
  });
  if (configured?.configured !== true || configured.deviceId !== deviceId) {
    throw new Error("Native payment-device transport could not be configured");
  }
  return { deviceId, status: "ACTIVE", securityLevel: identity.securityLevel, activation };
}

export function leaseNextSettlementCommand() {
  return nativeRequest("paymentDeviceLeaseNext");
}

export function acknowledgeSettlementCommand({ commandId, ledgerAckId } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(commandId || ""))) throw new TypeError("Invalid settlement command ID");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(ledgerAckId || ""))) throw new TypeError("Invalid durable ledger receipt ID");
  return nativeRequest("paymentDeviceAcknowledge", { commandId, ledgerAckId });
}

export function paymentDeviceNativeAvailable() {
  return !!(window.AureliaNative && typeof window.AureliaNative.postMessage === "function");
}
