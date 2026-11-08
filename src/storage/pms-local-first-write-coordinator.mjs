/**
 * Serializes all ordinary PMS state writes through the canonical local repository.
 * The UI receives a verified in-memory snapshot; no Web Storage cache is written.
 */
const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class PmsLocalFirstWriteCoordinator {
  constructor({ persist, readBack, onFailure = () => {} } = {}) {
    if (typeof persist !== "function" || typeof readBack !== "function") {
      throw new TypeError("Canonical persist and read-back functions are required");
    }
    this.persistCanonical = persist;
    this.readCanonical = readBack;
    this.onFailure = onFailure;
    this.queue = Promise.resolve();
    this.failure = null;
    this.sequence = 0;
  }

  save(snapshot) {
    if (this.failure) return Promise.reject(this.failure);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return Promise.reject(new TypeError("A complete PMS snapshot object is required"));
    }
    const immutableSnapshot = clone(snapshot);
    const sequence = ++this.sequence;
    const commit = async () => {
      if (this.failure) throw this.failure;
      try {
        await this.persistCanonical(immutableSnapshot);
        const stored = await this.readCanonical();
        if (!stored || !sameJson(stored.snapshot, immutableSnapshot)) {
          throw new Error("Canonical local PMS snapshot failed exact read-back verification");
        }
        return Object.freeze({ committed: true, sequence, snapshot: clone(stored.snapshot) });
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        try { this.onFailure(this.failure, sequence); } catch (_) {}
        throw this.failure;
      }
    };
    const result = this.queue.then(commit, commit);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  get status() {
    return Object.freeze({ queuedSequence: this.sequence, failed: Boolean(this.failure), error: this.failure?.message || null });
  }
}
