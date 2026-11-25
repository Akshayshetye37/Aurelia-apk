const ENTITY_TYPES = Object.freeze({
  SESSION: "upi_session",
  EVIDENCE: "upi_evidence",
  PAYMENT: "upi_payment",
  REFUND: "upi_refund",
  AUDIT: "upi_audit"
});

function randomId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return prefix + "_" + (uuid || Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function nativePlugin() {
  return globalThis.Capacitor?.Plugins?.CapacitorPmsStorage || null;
}

export function createAureliaUPIRepository({ plugin = nativePlugin() } = {}) {
  const memory = new Map(Object.values(ENTITY_TYPES).map(type => [type, new Map()]));
  let identityPromise = null;

  const isNative = !!(plugin && typeof plugin.getEntity === "function" &&
    typeof plugin.listEntities === "function" &&
    typeof plugin.transactBusinessChange === "function");

  async function identity() {
    if (!isNative) return null;
    if (!identityPromise) {
      identityPromise = plugin.getOrCreateLocalIdentity().then(result => {
        const value = result?.identity;
        if (!value?.tenantId || !value?.propertyId || !value?.deviceId) {
          throw new Error("Aurelia local device identity is incomplete.");
        }
        return value;
      });
    }
    return identityPromise;
  }

  async function get(type, id) {
    if (!isNative) return memory.get(type).get(id) || null;
    const result = await plugin.getEntity({ entityType: type, entityId: id });
    return result?.entity || null;
  }

  async function list(type) {
    if (!isNative) return [...memory.get(type).values()];
    const result = await plugin.listEntities({ entityType: type });
    return (Array.isArray(result?.entities) ? result.entities : []).map(row => ({
      id: row.id,
      version: row.version,
      data: row.data,
      updatedAt: row.updatedAt
    }));
  }

  async function save(type, id, data, eventType, payload = {}) {
    if (!isNative) {
      const previous = memory.get(type).get(id);
      const record = { id, version: (previous?.version || 0) + 1, data: { ...data }, updatedAt: new Date().toISOString(), previewOnly: true };
      memory.get(type).set(id, record);
      return record;
    }
    const device = await identity();
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await get(type, id);
      const expectedVersion = Number(current?.version || 0);
      const event = {
        eventId: randomId("evt"),
        tenantId: device.tenantId,
        propertyId: device.propertyId,
        deviceId: device.deviceId,
        entityType: type,
        entityId: id,
        sequence: expectedVersion + 1,
        eventType,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        payload: {
          rail: "AURELIA_UPI",
          entityId: id,
          ...payload
        }
      };
      try {
        return await plugin.transactBusinessChange({
          entityType: type,
          entityId: id,
          expectedVersion,
          data,
          event
        });
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENTITY_VERSION_CONFLICT" && !String(error?.message || "").includes("ENTITY_VERSION_CONFLICT")) {
          throw error;
        }
      }
    }
    throw lastError || new Error("Aurelia UPI could not commit after a version conflict.");
  }

  return Object.freeze({
    isNative,
    entityTypes: ENTITY_TYPES,
    get,
    list,
    saveSession: (session, eventType = "AURELIA_UPI_SESSION_SAVED") =>
      save(ENTITY_TYPES.SESSION, session.id, session, eventType, {
        status: session.status, amountPaise: session.amountPaise, currency: "INR"
      }),
    listSessions: () => list(ENTITY_TYPES.SESSION),
    saveEvidence: (evidence, eventType = "AURELIA_UPI_EVIDENCE_RECORDED") =>
      save(ENTITY_TYPES.EVIDENCE, evidence.id, evidence, eventType, {
        amountPaise: evidence.amountPaise, utr: evidence.utr || null, status: evidence.status
      }),
    listEvidence: () => list(ENTITY_TYPES.EVIDENCE),
    savePayment: (payment, eventType = "AURELIA_UPI_PAYMENT_CONFIRMED") =>
      save(ENTITY_TYPES.PAYMENT, payment.id, payment, eventType, {
        amountPaise: payment.amountPaise, folioId: payment.folioId || null
      }),
    listPayments: () => list(ENTITY_TYPES.PAYMENT),
    saveRefund: (refund, eventType = "AURELIA_UPI_REFUND_REQUESTED") =>
      save(ENTITY_TYPES.REFUND, refund.id, refund, eventType, {
        amountPaise: refund.amountPaise, paymentId: refund.paymentId
      }),
    listRefunds: () => list(ENTITY_TYPES.REFUND),
    saveAudit: (entry, eventType = "AURELIA_UPI_AUDIT_RECORDED") =>
      save(ENTITY_TYPES.AUDIT, entry.id || randomId("audit"), entry, eventType, {
        action: entry.action || "UNKNOWN"
      }),
    listAudit: () => list(ENTITY_TYPES.AUDIT),
    listNativeNotificationEvidence: async () => {
      if (!isNative || typeof plugin.listUpiEvidence !== "function") return [];
      const result = await plugin.listUpiEvidence();
      return Array.isArray(result?.evidence) ? result.evidence : [];
    },
    updateNativeNotificationEvidence: async (id, status, note = "") => {
      if (!isNative || typeof plugin.updateUpiEvidence !== "function") {
        throw new Error("Native Aurelia UPI notification evidence is unavailable.");
      }
      return plugin.updateUpiEvidence({ evidenceId: id, status, reviewNote: note, manualVerified: status === "CONFIRMED" });
    }
  });
}
