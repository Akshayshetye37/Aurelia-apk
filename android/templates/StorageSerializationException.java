package com.aurelia.pms;

/** Unchecked serialization failure; propagating it aborts the active SQLite transaction. */
final class StorageSerializationException extends RuntimeException {
  StorageSerializationException(String message, Throwable cause) { super(message, cause); }
}
