/**
 * Typed storage errors for Aurelia PMS.
 *
 * Storage adapters and persistence boundaries must normalize failures before
 * they cross into domain or UI code. Keep details free of PII and secrets.
 */

export class StorageError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.cause = options.cause ?? null;
    this.details = options.details ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
  }
}

export class StorageFullError extends StorageError {
  constructor(message = "Device storage is full", options = {}) {
    super("STORAGE_FULL", message, { retryable: false, ...options });
    this.name = "StorageFullError";
  }
}

export class DatabaseUnavailableError extends StorageError {
  constructor(message = "Database is unavailable", options = {}) {
    super("DATABASE_UNAVAILABLE", message, { retryable: true, ...options });
    this.name = "DatabaseUnavailableError";
  }
}

export class PermissionDeniedError extends StorageError {
  constructor(message = "Storage permission denied", options = {}) {
    super("PERMISSION_DENIED", message, { retryable: false, ...options });
    this.name = "PermissionDeniedError";
  }
}

export class DatabaseCorruptionError extends StorageError {
  constructor(message = "Database appears corrupted", options = {}) {
    super("DATABASE_CORRUPTION", message, { retryable: false, ...options });
    this.name = "DatabaseCorruptionError";
  }
}

export class TransactionAbortedError extends StorageError {
  constructor(message = "Transaction was aborted", options = {}) {
    super("TRANSACTION_ABORTED", message, { retryable: true, ...options });
    this.name = "TransactionAbortedError";
  }
}

export class VersionConflictError extends StorageError {
  constructor(message = "Entity version conflict", options = {}) {
    super("VERSION_CONFLICT", message, { retryable: false, ...options });
    this.name = "VersionConflictError";
  }
}

export class AttachmentWriteError extends StorageError {
  constructor(message = "Attachment write failed", options = {}) {
    super("ATTACHMENT_WRITE_FAILED", message, { retryable: true, ...options });
    this.name = "AttachmentWriteError";
  }
}

export class MigrationFailedError extends StorageError {
  constructor(message = "Migration failed", options = {}) {
    super("MIGRATION_FAILED", message, { retryable: false, ...options });
    this.name = "MigrationFailedError";
  }
}

/**
 * Normalize an unknown adapter failure at a storage boundary.
 * Prefer throwing a concrete error at the source when its failure mode is known.
 */
export function normalizeStorageError(error) {
  if (error instanceof StorageError) return error;

  const message = error && error.message
    ? String(error.message)
    : typeof error === "string"
      ? error
      : "Unknown storage failure";
  const lower = message.toLowerCase();
  const name = String(error?.name ?? "");
  const code = String(error?.code ?? "");

  const options = { cause: error instanceof Error ? error : null };

  if (name === "QuotaExceededError" || code === "22" ||
      lower.includes("quota") || lower.includes("storage full") || lower.includes("disk full")) {
    return new StorageFullError(message, options);
  }
  if (name === "NotAllowedError" || lower.includes("permission") || lower.includes("access denied")) {
    return new PermissionDeniedError(message, options);
  }
  if (lower.includes("corrupt") || lower.includes("malformed") || lower.includes("not a database")) {
    return new DatabaseCorruptionError(message, options);
  }
  if ((lower.includes("version") && lower.includes("conflict")) ||
      code === "VERSION_CONFLICT") {
    return new VersionConflictError(message, options);
  }
  if (lower.includes("abort") || name === "AbortError") {
    return new TransactionAbortedError(message, options);
  }
  if (lower.includes("migrat")) {
    return new MigrationFailedError(message, options);
  }

  return new DatabaseUnavailableError(message, options);
}
