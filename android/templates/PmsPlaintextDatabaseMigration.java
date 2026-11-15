package com.aurelia.pms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * One-time, fail-closed migration from the previous plaintext SQLite file to
 * the encrypted SQLCipher database. The plaintext source is deleted only after
 * transaction commit and exact per-table read-back digest verification.
 */
final class PmsPlaintextDatabaseMigration {
  private static final String LEGACY_NAME = "aurelia-pms.db";
  private static final String[] TABLES = {
    "pms_entities", "pms_outbox", "pms_migrations", "pms_migration_snapshots"
  };
  private static final String[] ORDER_BY = {
    "entity_type,entity_id", "event_id", "migration_key", "snapshot_id"
  };

  private PmsPlaintextDatabaseMigration() {}

  static void migrateIfNeeded(Context context, net.zetetic.database.sqlcipher.SQLiteDatabase encrypted) {
    java.io.File sourceFile = context.getDatabasePath(LEGACY_NAME);
    if (!sourceFile.exists()) return;

    android.database.sqlite.SQLiteDatabase source = null;
    try {
      source = android.database.sqlite.SQLiteDatabase.openDatabase(
        sourceFile.getAbsolutePath(), null, android.database.sqlite.SQLiteDatabase.OPEN_READONLY);
      if (source.getVersion() != 3) {
        throw new IllegalStateException("PMS_PLAINTEXT_DB_VERSION_UNSUPPORTED");
      }
      try (Cursor integrity = source.rawQuery("PRAGMA quick_check", null)) {
        if (!integrity.moveToFirst() || !"ok".equalsIgnoreCase(integrity.getString(0))) {
          throw new IllegalStateException("PMS_PLAINTEXT_DB_INTEGRITY_FAILED");
        }
      }
      for (String table : TABLES) {
        if (!hasTable(source, table)) throw new IllegalStateException("PMS_PLAINTEXT_DB_SCHEMA_INCOMPLETE");
        if (!hasTable(encrypted, table)) throw new IllegalStateException("PMS_ENCRYPTED_DB_SCHEMA_INCOMPLETE");
      }

      encrypted.beginTransactionNonExclusive();
      try {
        boolean destinationEmpty = true;
        for (String table : TABLES) destinationEmpty &= count(encrypted, table) == 0;
        if (destinationEmpty) {
          for (int i = 0; i < TABLES.length; i++) copyTable(source, encrypted, TABLES[i], ORDER_BY[i]);
        } else {
          // A prior process may have committed the encrypted copy and died
          // before deleting the plaintext source. Accept only exact parity.
          for (int i = 0; i < TABLES.length; i++) {
            if (!digestTable(source, TABLES[i], ORDER_BY[i]).equals(
                digestTable(encrypted, TABLES[i], ORDER_BY[i]))) {
              throw new IllegalStateException("PMS_PLAINTEXT_MIGRATION_DIVERGENCE");
            }
          }
        }
        encrypted.setTransactionSuccessful();
      } finally {
        encrypted.endTransaction();
      }

      // Verify after commit, not merely against uncommitted transaction state.
      for (int i = 0; i < TABLES.length; i++) {
        if (!digestTable(source, TABLES[i], ORDER_BY[i]).equals(
            digestTable(encrypted, TABLES[i], ORDER_BY[i]))) {
          throw new IllegalStateException("PMS_ENCRYPTED_MIGRATION_READBACK_MISMATCH");
        }
      }
    } catch (RuntimeException failure) {
      throw failure;
    } catch (Exception failure) {
      throw new IllegalStateException("PMS_PLAINTEXT_MIGRATION_FAILED", failure);
    } finally {
      if (source != null) source.close();
    }

    // Never delete the old database before the encrypted destination is
    // committed and verified. If deletion fails, block writes rather than
    // silently leave two writable copies of business data.
    if (!context.deleteDatabase(LEGACY_NAME)) {
      throw new IllegalStateException("PMS_PLAINTEXT_SOURCE_CLEANUP_FAILED");
    }
  }

  private static boolean hasTable(android.database.sqlite.SQLiteDatabase db, String table) {
    try (Cursor cursor = db.rawQuery(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", new String[]{table})) {
      return cursor.moveToFirst();
    }
  }

  private static boolean hasTable(net.zetetic.database.sqlcipher.SQLiteDatabase db, String table) {
    try (Cursor cursor = db.rawQuery(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", new String[]{table})) {
      return cursor.moveToFirst();
    }
  }

  private static long count(android.database.sqlite.SQLiteDatabase db, String table) {
    try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM " + table, null)) {
      if (!cursor.moveToFirst()) throw new IllegalStateException("PMS_MIGRATION_COUNT_FAILED");
      return cursor.getLong(0);
    }
  }

  private static long count(net.zetetic.database.sqlcipher.SQLiteDatabase db, String table) {
    try (Cursor cursor = db.rawQuery("SELECT COUNT(*) FROM " + table, null)) {
      if (!cursor.moveToFirst()) throw new IllegalStateException("PMS_MIGRATION_COUNT_FAILED");
      return cursor.getLong(0);
    }
  }

  private static void copyTable(android.database.sqlite.SQLiteDatabase source,
      net.zetetic.database.sqlcipher.SQLiteDatabase destination, String table, String orderBy) {
    try (Cursor cursor = source.rawQuery("SELECT * FROM " + table + " ORDER BY " + orderBy, null)) {
      while (cursor.moveToNext()) {
        ContentValues values = new ContentValues();
        for (int column = 0; column < cursor.getColumnCount(); column++) {
          String name = cursor.getColumnName(column);
          switch (cursor.getType(column)) {
            case Cursor.FIELD_TYPE_NULL: values.putNull(name); break;
            case Cursor.FIELD_TYPE_INTEGER: values.put(name, cursor.getLong(column)); break;
            case Cursor.FIELD_TYPE_FLOAT: values.put(name, cursor.getDouble(column)); break;
            case Cursor.FIELD_TYPE_BLOB: values.put(name, cursor.getBlob(column)); break;
            case Cursor.FIELD_TYPE_STRING: values.put(name, cursor.getString(column)); break;
            default: throw new IllegalStateException("PMS_MIGRATION_UNKNOWN_SQLITE_VALUE_TYPE");
          }
        }
        destination.insertOrThrow(table, null, values);
      }
    }
  }

  private static String digestTable(android.database.sqlite.SQLiteDatabase db, String table, String orderBy) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (Cursor cursor = db.rawQuery("SELECT * FROM " + table + " ORDER BY " + orderBy, null)) {
      while (cursor.moveToNext()) updateRowDigest(digest, cursor);
    }
    return hex(digest.digest());
  }

  private static String digestTable(net.zetetic.database.sqlcipher.SQLiteDatabase db, String table, String orderBy) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (Cursor cursor = db.rawQuery("SELECT * FROM " + table + " ORDER BY " + orderBy, null)) {
      while (cursor.moveToNext()) updateRowDigest(digest, cursor);
    }
    return hex(digest.digest());
  }

  private static void updateRowDigest(MessageDigest digest, Cursor cursor) {
    digest.update((byte) 0x7f); // row boundary
    for (int column = 0; column < cursor.getColumnCount(); column++) {
      digest.update((byte) cursor.getType(column));
      if (cursor.isNull(column)) {
        digest.update(ByteBuffer.allocate(4).putInt(-1).array());
        continue;
      }
      byte[] value = cursor.getType(column) == Cursor.FIELD_TYPE_BLOB
        ? cursor.getBlob(column)
        : cursor.getString(column).getBytes(StandardCharsets.UTF_8);
      digest.update(ByteBuffer.allocate(4).putInt(value.length).array());
      digest.update(value);
      Arrays.fill(value, (byte) 0);
    }
  }

  private static String hex(byte[] value) {
    StringBuilder out = new StringBuilder(value.length * 2);
    for (byte b : value) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    Arrays.fill(value, (byte) 0);
    return out.toString();
  }
}
