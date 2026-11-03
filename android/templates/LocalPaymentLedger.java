package com.aurelia.pms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * Durable device-local payment operation journal.
 *
 * This journal records intent and synchronization state only. It is NOT a
 * payment processor and must never mark a payment as captured/paid. Provider
 * verification and PMS accounting remain authoritative server-side steps.
 */
final class LocalPaymentLedger extends SQLiteOpenHelper {
  private static final String DB_NAME = "aurelia-local-ledger.db";
  private static final int DB_VERSION = 1;
  private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9._:-]{8,128}$");

  LocalPaymentLedger(Context context) { super(context.getApplicationContext(), DB_NAME, null, DB_VERSION); }

  @Override public void onCreate(SQLiteDatabase db) {
    db.execSQL("CREATE TABLE payment_ledger (" +
      "transaction_id TEXT PRIMARY KEY NOT NULL," +
      "provider TEXT NOT NULL CHECK(provider IN ('razorpay','cashfree'))," +
      "environment TEXT NOT NULL CHECK(environment IN ('test','live'))," +
      "folio_id TEXT NOT NULL," +
      "amount_minor INTEGER NOT NULL CHECK(amount_minor > 0)," +
      "currency TEXT NOT NULL CHECK(currency='INR')," +
      "local_status TEXT NOT NULL CHECK(local_status IN ('SAVED_ON_DEVICE','SENT_TO_LAN','PROCESSED_BY_LAN','RECONCILIATION_REQUIRED'))," +
      "cloud_sync_status TEXT NOT NULL CHECK(cloud_sync_status IN ('PENDING','SYNCED'))," +
      "created_at INTEGER NOT NULL," +
      "updated_at INTEGER NOT NULL)");
    db.execSQL("CREATE INDEX payment_ledger_sync_idx ON payment_ledger(cloud_sync_status,created_at)");
  }

  @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    // Additive migrations only. Never drop payment history here.
  }

  synchronized JSONObject create(JSONObject input) {
    if (input == null) throw new IllegalArgumentException("payment_ledger_payload_required");
    String tx = input.optString("transactionId", "").trim();
    String provider = input.optString("provider", "").trim().toLowerCase();
    String env = input.optString("environment", "test").trim().toLowerCase();
    String folio = input.optString("folioId", "").trim();
    String currency = input.optString("currency", "INR").trim().toUpperCase();
    long amount = input.optLong("amountMinor", -1);
    if (!SAFE_ID.matcher(tx).matches() || !SAFE_ID.matcher(folio).matches() ||
        !("razorpay".equals(provider) || "cashfree".equals(provider)) ||
        !("test".equals(env) || "live".equals(env)) || amount <= 0 ||
        !"INR".equals(currency)) {
      throw new IllegalArgumentException("invalid_payment_ledger_entry");
    }
    long now = System.currentTimeMillis();
    SQLiteDatabase db = getWritableDatabase();
    ContentValues values = new ContentValues();
    values.put("transaction_id", tx); values.put("provider", provider);
    values.put("environment", env); values.put("folio_id", folio);
    values.put("amount_minor", amount); values.put("currency", currency);
    values.put("local_status", "SAVED_ON_DEVICE");
    values.put("cloud_sync_status", "PENDING");
    values.put("created_at", now); values.put("updated_at", now);
    long inserted = db.insertWithOnConflict("payment_ledger", null, values, SQLiteDatabase.CONFLICT_IGNORE);
    if (inserted == -1) {
      try (Cursor c = db.rawQuery("SELECT provider,environment,folio_id,amount_minor,currency FROM payment_ledger WHERE transaction_id=?", new String[]{tx})) {
        if (!c.moveToFirst() || !provider.equals(c.getString(0)) || !env.equals(c.getString(1)) ||
            !folio.equals(c.getString(2)) || amount != c.getLong(3) || !currency.equals(c.getString(4))) {
          throw new IllegalStateException("payment_ledger_idempotency_conflict");
        }
      }
    }
    return get(tx);
  }

  synchronized JSONObject updateLocalStatus(String tx, String status) {
    if (!SAFE_ID.matcher(tx == null ? "" : tx).matches()) throw new IllegalArgumentException("invalid_transaction_id");
    if (!("SAVED_ON_DEVICE".equals(status) || "SENT_TO_LAN".equals(status) ||
          "PROCESSED_BY_LAN".equals(status) || "RECONCILIATION_REQUIRED".equals(status))) {
      throw new IllegalArgumentException("invalid_local_payment_status");
    }
    SQLiteDatabase db = getWritableDatabase();
    try (Cursor c = db.rawQuery("SELECT local_status FROM payment_ledger WHERE transaction_id=?", new String[]{tx})) {
      if (!c.moveToFirst()) throw new IllegalArgumentException("payment_ledger_entry_not_found");
      String old = c.getString(0);
      boolean allowed = old.equals(status) ||
        ("SAVED_ON_DEVICE".equals(old) && "SENT_TO_LAN".equals(status)) ||
        ("SENT_TO_LAN".equals(old) && ("PROCESSED_BY_LAN".equals(status) || "RECONCILIATION_REQUIRED".equals(status))) ||
        ("PROCESSED_BY_LAN".equals(old) && "RECONCILIATION_REQUIRED".equals(status));
      if (!allowed) throw new IllegalStateException("invalid_payment_ledger_transition");
    }
    ContentValues values = new ContentValues(); values.put("local_status", status); values.put("updated_at", System.currentTimeMillis());
    db.update("payment_ledger", values, "transaction_id=?", new String[]{tx});
    return get(tx);
  }

  synchronized JSONObject get(String tx) {
    try (Cursor c = getReadableDatabase().rawQuery("SELECT transaction_id,provider,environment,folio_id,amount_minor,currency,local_status,cloud_sync_status,created_at,updated_at FROM payment_ledger WHERE transaction_id=?", new String[]{tx})) {
      if (!c.moveToFirst()) throw new IllegalArgumentException("payment_ledger_entry_not_found");
      return row(c);
    }
  }

  synchronized JSONArray listPending(int limit) {
    JSONArray out = new JSONArray();
    int safeLimit = Math.max(1, Math.min(100, limit));
    try (Cursor c = getReadableDatabase().rawQuery("SELECT transaction_id,provider,environment,folio_id,amount_minor,currency,local_status,cloud_sync_status,created_at,updated_at FROM payment_ledger WHERE cloud_sync_status='PENDING' ORDER BY created_at ASC LIMIT ?", new String[]{String.valueOf(safeLimit)})) {
      while (c.moveToNext()) out.put(row(c));
    }
    return out;
  }

  private JSONObject row(Cursor c) {
    JSONObject out = new JSONObject();
    try {
      out.put("transactionId", c.getString(0)); out.put("provider", c.getString(1));
      out.put("environment", c.getString(2)); out.put("folioId", c.getString(3));
      out.put("amountMinor", c.getLong(4)); out.put("currency", c.getString(5));
      out.put("localStatus", c.getString(6)); out.put("cloudSyncStatus", c.getString(7));
      out.put("createdAt", c.getLong(8)); out.put("updatedAt", c.getLong(9));
    } catch (Exception e) { throw new IllegalStateException("payment_ledger_serialization_failed", e); }
    return out;
  }
}
