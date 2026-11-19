/**
 * Explicit UI feedback for durable PMS operations.
 *
 * A save is "saved" only after its caller has verified the canonical commit.
 * Ambiguous outcomes remain blocked until startup/recovery verification.
 */
const STATES = new Set([
  "idle",
  "saving",
  "saved",
  "save_failed",
  "database_unavailable",
  "recovery_required"
]);

const snapshot = value => Object.freeze({
  state: value.state,
  message: value.message,
  errorCode: value.errorCode,
  sequence: value.sequence
});

export class PmsOperationalFeedback {
  constructor({ onChange = () => {} } = {}) {
    this.current = { state: "idle", message: "", errorCode: null, sequence: 0 };
    this.listeners = new Set();
    if (typeof onChange === "function") this.listeners.add(onChange);
  }

  get status() {
    return snapshot(this.current);
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("A feedback listener is required");
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  beginSave() {
    if (this.current.state === "recovery_required") {
      throw new Error("Operational writes are blocked until recovery is verified");
    }
    const sequence = this.current.sequence + 1;
    this.transition({
      state: "saving",
      message: "Saving to this device…",
      errorCode: null,
      sequence
    });
    return sequence;
  }

  completeSave(sequence) {
    if (sequence !== this.current.sequence || this.current.state !== "saving") return false;
    this.transition({
      state: "saved",
      message: "Saved on this device",
      errorCode: null,
      sequence
    });
    return true;
  }

  failSave(sequence, error, { recoveryRequired = false } = {}) {
    if (sequence !== this.current.sequence || this.current.state !== "saving") return false;
    const code = typeof error?.code === "string" ? error.code : null;
    const message = String(error?.message || "The device could not confirm this save");
    const state = recoveryRequired
      ? "recovery_required"
      : code === "DATABASE_UNAVAILABLE"
        ? "database_unavailable"
        : "save_failed";
    this.transition({ state, message, errorCode: code, sequence });
    return true;
  }

  completeRecovery({ verified = false } = {}) {
    if (this.current.state !== "recovery_required") return false;
    if (!verified) return false;
    this.transition({
      state: "saved",
      message: "Device data recovery verified",
      errorCode: null,
      sequence: this.current.sequence
    });
    return true;
  }

  transition(next) {
    if (!STATES.has(next.state)) throw new TypeError("Unknown operational feedback state");
    this.current = next;
    const status = this.status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        console.error("[Aurelia Feedback] Status listener failed.", error);
      }
    }
  }
}
