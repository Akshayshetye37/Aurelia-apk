package com.aurelia.pms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;

public final class NotificationQueueDb extends SQLiteOpenHelper {
  private static final String DB_NAME = "aurelia_upi_evidence.db";
  private static final int DB_VERSION = 1;
  public static final String PENDING = "pending";

  public NotificationQueueDb(Context context) { super(context, DB_NAME, null, DB_VERSION); }

  @Override public void onCreate(SQLiteDatabase db) {
    db.execSQL("CREATE TABLE upi_notification_queue (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, source_package TEXT NOT NULL, utr TEXT, " +
      "amount_paise INTEGER NOT NULL, notification_text TEXT NOT NULL, received_at INTEGER NOT NULL, " +
      "status TEXT NOT NULL DEFAULT 'pending', status_updated_at INTEGER, review_note TEXT, " +
      "fingerprint TEXT NOT NULL UNIQUE)");
    db.execSQL("CREATE INDEX idx_upi_status_time ON upi_notification_queue(status, received_at)");
    db.execSQL("CREATE INDEX idx_upi_utr ON upi_notification_queue(utr)");
  }

  @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    // Preserve existing evidence; future schema changes require explicit ALTER TABLE migrations.
  }

  public synchronized JSONObject enqueue(String pkg, String utr, long paise, String text,
      long receivedAt, String fingerprint) throws Exception {
    if (pkg == null || pkg.trim().isEmpty() || text == null || text.trim().isEmpty()
        || fingerprint == null || fingerprint.trim().isEmpty() || paise <= 0) {
      throw new IllegalArgumentException("Invalid notification evidence");
    }
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      if (utr != null && !utr.trim().isEmpty()) {
        try (Cursor c = db.rawQuery("SELECT id, amount_paise FROM upi_notification_queue WHERE utr=? LIMIT 1",
            new String[]{utr.trim()})) {
          if (c.moveToFirst()) {
            JSONObject result = new JSONObject();
            if (c.getLong(1) == paise) {
              JSONObject result = new JSONObject();
              result.put("status", "duplicate");
              result.put("id", c.getLong(0));
              result.put("existingAmountPaise", c.getLong(1));
              db.setTransactionSuccessful();
              return result;
            }
            // Preserve the conflicting notification as a separate reviewable record below.
          }
        }
      }
      ContentValues v = new ContentValues();
      v.put("source_package", pkg); v.put("utr", utr); v.put("amount_paise", paise);
      v.put("notification_text", text); v.put("received_at", receivedAt);
      boolean conflict = false;
      if (utr != null && !utr.trim().isEmpty()) {
        try (Cursor c = db.rawQuery("SELECT amount_paise FROM upi_notification_queue WHERE utr=? LIMIT 1",
            new String[]{utr.trim()})) {
          conflict = c.moveToFirst() && c.getLong(0) != paise;
        }
      }
      v.put("status", conflict ? "conflict" : PENDING); v.put("fingerprint", fingerprint);
      long id = db.insertWithOnConflict("upi_notification_queue", null, v, SQLiteDatabase.CONFLICT_IGNORE);
      JSONObject result = new JSONObject();
      if (id == -1) {
        try (Cursor c = db.rawQuery("SELECT id FROM upi_notification_queue WHERE fingerprint=?",
            new String[]{fingerprint})) {
          result.put("status", c.moveToFirst() ? "duplicate" : "storage_error");
          if (c.moveToFirst()) result.put("id", c.getLong(0));
        }
      } else { result.put("status", "queued"); result.put("id", id); }
      db.setTransactionSuccessful();
      return result;
    } finally { db.endTransaction(); }
  }

  public synchronized JSONArray fetchPending(int limit) throws Exception {
    JSONArray out = new JSONArray();
    int safeLimit = Math.max(1, Math.min(limit, 200));
    try (Cursor c = getReadableDatabase().rawQuery(
        "SELECT id,source_package,utr,amount_paise,notification_text,received_at,status " +
        "FROM upi_notification_queue WHERE status IN ('pending','conflict') ORDER BY received_at DESC LIMIT ?",
        new String[]{String.valueOf(safeLimit)})) {
      while (c.moveToNext()) {
        JSONObject row = new JSONObject();
        row.put("id", c.getLong(0)); row.put("sourcePackage", c.getString(1));
        row.put("utr", c.isNull(2) ? JSONObject.NULL : c.getString(2));
        row.put("amountPaise", c.getLong(3)); row.put("notificationText", c.getString(4));
        row.put("receivedAt", c.getLong(5)); row.put("status", c.getString(6)); out.put(row);
      }
    }
    return out;
  }

  public synchronized JSONObject updateStatus(long id, String status, String note) throws Exception {
    if (!"pending".equals(status) && !"conflict".equals(status) && !"reviewed".equals(status) && !"rejected".equals(status)) {
      throw new IllegalArgumentException("Unsupported evidence status");
    }
    ContentValues v = new ContentValues();
    v.put("status", status); v.put("status_updated_at", System.currentTimeMillis());
    v.put("review_note", note == null ? "" : note);
    int changed = getWritableDatabase().update("upi_notification_queue", v, "id=?",
        new String[]{String.valueOf(id)});
    JSONObject out = new JSONObject();
    out.put("ok", changed == 1); out.put("id", id); out.put("status", status);
    if (changed != 1) out.put("error", "Evidence record not found");
    return out;
  }
}
