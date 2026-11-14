package com.aurelia.pms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Device-local durable payment journal. This stores intent and verified evidence
 * state; it never treats a checkout UI callback as proof of payment.
 * Provider verification and folio posting are separate, auditable transitions.
 */
final class LocalPaymentLedger extends SQLiteOpenHelper {
  private static final String DB_NAME = "aurelia-local-ledger.db";
  private static final int DB_VERSION = 3;
  private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9._:-]{8,128}$");
  private static final Pattern SAFE_PROVIDER_REF = Pattern.compile("^[A-Za-z0-9._:-]{1,256}$");
  private static final Set<String> PROVIDERS = new HashSet<>(Arrays.asList(
      "razorpay", "cashfree", "payu", "phonepe", "paytm", "ccavenue", "jiopay"));
  private static final String COLUMNS = "transaction_id,provider,environment,folio_id,amount_minor,currency,local_status,provider_order_id,provider_payment_id,created_at,updated_at";

  LocalPaymentLedger(Context context) { super(context.getApplicationContext(), DB_NAME, null, DB_VERSION); }

  @Override public void onCreate(SQLiteDatabase db) { createSchema(db); }

  private void createSchema(SQLiteDatabase db) {
    db.execSQL("CREATE TABLE IF NOT EXISTS payment_ledger (" +
      "transaction_id TEXT PRIMARY KEY NOT NULL," +
      "provider TEXT NOT NULL CHECK(provider IN ('razorpay','cashfree','payu','phonepe','paytm','ccavenue','jiopay'))," +
      "environment TEXT NOT NULL CHECK(environment IN ('test','live','uat','production','staging'))," +
      "folio_id TEXT NOT NULL," +
      "amount_minor INTEGER NOT NULL CHECK(amount_minor > 0)," +
      "currency TEXT NOT NULL CHECK(currency='INR')," +
      "local_status TEXT NOT NULL CHECK(local_status IN ('SAVED_ON_DEVICE','READY_FOR_ONLINE','ORDER_CREATED','AWAITING_PROVIDER','CAPTURED_UNPOSTED','POSTED_TO_FOLIO','FAILED','RECONCILIATION_REQUIRED'))," +
      "provider_order_id TEXT," +
      "provider_payment_id TEXT," +
      "created_at INTEGER NOT NULL," +
      "updated_at INTEGER NOT NULL)");
    db.execSQL("CREATE INDEX IF NOT EXISTS payment_ledger_pending_idx ON payment_ledger(local_status,created_at)");
    db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_order_idx ON payment_ledger(provider,environment,provider_order_id) WHERE provider_order_id IS NOT NULL");
    db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_payment_idx ON payment_ledger(provider,environment,provider_payment_id) WHERE provider_payment_id IS NOT NULL");
  }

  @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    if (oldVersion < 2) {
      db.beginTransaction();
      try {
        db.execSQL("ALTER TABLE payment_ledger RENAME TO payment_ledger_v1");
        createSchema(db);
        db.execSQL("INSERT INTO payment_ledger(transaction_id,provider,environment,folio_id,amount_minor,currency,local_status,created_at,updated_at) " +
          "SELECT transaction_id,provider,environment,folio_id,amount_minor,currency," +
          "CASE WHEN local_status='PROCESSED_BY_LAN' THEN 'RECONCILIATION_REQUIRED' " +
          "WHEN local_status='RECONCILIATION_REQUIRED' THEN 'RECONCILIATION_REQUIRED' ELSE 'SAVED_ON_DEVICE' END,created_at,updated_at " +
          "FROM payment_ledger_v1 WHERE provider IN ('razorpay','cashfree')");
        db.execSQL("DROP TABLE payment_ledger_v1");
        db.setTransactionSuccessful();
      } finally { db.endTransaction(); }
    }
    if (oldVersion < 3) {
      db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_payment_idx ON payment_ledger(provider,environment,provider_payment_id) WHERE provider_payment_id IS NOT NULL");
    }
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
        !PROVIDERS.contains(provider) || !validEnvironment(provider, env) ||
        amount <= 0 || !"INR".equals(currency)) {
      throw new IllegalArgumentException("invalid_payment_ledger_entry");
    }
    long now = System.currentTimeMillis();
    ContentValues values = new ContentValues();
    values.put("transaction_id", tx); values.put("provider", provider);
    values.put("environment", env); values.put("folio_id", folio);
    values.put("amount_minor", amount); values.put("currency", currency);
    values.put("local_status", "SAVED_ON_DEVICE");
    values.put("created_at", now); values.put("updated_at", now);
    SQLiteDatabase db = getWritableDatabase();
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

  private boolean validEnvironment(String provider, String env) {
    if ("phonepe".equals(provider) || "jiopay".equals(provider))
      return "uat".equals(env) || "production".equals(env);
    if ("paytm".equals(provider)) return "staging".equals(env) || "production".equals(env);
    return "test".equals(env) || "live".equals(env);
  }

  /** WebView may only move a saved intent into the online queue, never mark it paid. */
  synchronized JSONObject updateLocalStatus(String tx, String status) {
    if (!safe(tx) || !("SAVED_ON_DEVICE".equals(status) || "READY_FOR_ONLINE".equals(status) ||
        "RECONCILIATION_REQUIRED".equals(status))) throw new IllegalArgumentException("invalid_local_payment_status");
    SQLiteDatabase db = getWritableDatabase();
    String old;
    try (Cursor c = db.rawQuery("SELECT local_status FROM payment_ledger WHERE transaction_id=?", new String[]{tx})) {
      if (!c.moveToFirst()) throw new IllegalArgumentException("payment_ledger_entry_not_found");
      old = c.getString(0);
    }
    boolean allowed = old.equals(status) ||
      ("SAVED_ON_DEVICE".equals(old) && ("READY_FOR_ONLINE".equals(status) || "RECONCILIATION_REQUIRED".equals(status))) ||
      ("READY_FOR_ONLINE".equals(old) && "RECONCILIATION_REQUIRED".equals(status));
    if (!allowed) throw new IllegalStateException("invalid_payment_ledger_transition");
    ContentValues values = new ContentValues(); values.put("local_status", status); values.put("updated_at", System.currentTimeMillis());
    db.update("payment_ledger", values, "transaction_id=?", new String[]{tx});
    return get(tx);
  }

  /** Native provider engine only. Persist the first provider order reference; never replace it on replay. */
  synchronized JSONObject recordProviderOrder(String tx, String orderId) {
    if (!safe(tx) || !safeProviderRef(orderId)) throw new IllegalArgumentException("invalid_provider_order_reference");
    ContentValues v = new ContentValues(); v.put("local_status", "ORDER_CREATED");
    v.put("provider_order_id", orderId); v.put("updated_at", System.currentTimeMillis());
    int changed = getWritableDatabase().update("payment_ledger", v,
        "transaction_id=? AND ((local_status='READY_FOR_ONLINE' AND provider_order_id IS NULL) OR (local_status IN ('ORDER_CREATED','RECONCILIATION_REQUIRED') AND provider_order_id=?))", new String[]{tx, orderId});
    if (changed != 1) throw new IllegalStateException("payment_order_transition_rejected_or_reference_conflict");
    return get(tx);
  }

  /** Native provider engine only. Marks the order as handed to the provider; this is not payment evidence. */
  synchronized JSONObject recordAwaitingProvider(String tx) {
    if (!safe(tx)) throw new IllegalArgumentException("invalid_transaction_id");
    ContentValues v = new ContentValues(); v.put("local_status", "AWAITING_PROVIDER"); v.put("updated_at", System.currentTimeMillis());
    int changed = getWritableDatabase().update("payment_ledger", v,
        "transaction_id=? AND local_status IN ('ORDER_CREATED','AWAITING_PROVIDER') AND provider_order_id IS NOT NULL", new String[]{tx});
    if (changed != 1) throw new IllegalStateException("payment_awaiting_provider_transition_rejected");
    return get(tx);
  }

  /** Native provider engine only. Provider capture is not yet a PMS folio credit. */
  synchronized JSONObject recordVerifiedCapture(String tx, String paymentId) {
    if (!safe(tx) || !safeProviderRef(paymentId)) throw new IllegalArgumentException("invalid_provider_payment_reference");
    ContentValues v = new ContentValues(); v.put("local_status", "CAPTURED_UNPOSTED");
    v.put("provider_payment_id", paymentId); v.put("updated_at", System.currentTimeMillis());
    int changed = getWritableDatabase().update("payment_ledger", v,
        "transaction_id=? AND provider_order_id IS NOT NULL AND (provider_payment_id IS NULL OR provider_payment_id=?) AND local_status IN ('ORDER_CREATED','AWAITING_PROVIDER','CAPTURED_UNPOSTED','RECONCILIATION_REQUIRED')", new String[]{tx, paymentId});
    if (changed != 1) throw new IllegalStateException("payment_capture_transition_rejected");
    return get(tx);
  }

  /** No public status-only method may mark a payment posted. The canonical PMS
   * accounting transaction must be implemented before this transition exists.
   */

  synchronized JSONObject get(String tx) {
    try (Cursor c = getReadableDatabase().rawQuery("SELECT " + COLUMNS + " FROM payment_ledger WHERE transaction_id=?", new String[]{tx})) {
      if (!c.moveToFirst()) throw new IllegalArgumentException("payment_ledger_entry_not_found");
      return row(c);
    }
  }

  synchronized JSONArray listPending(int limit) {
    JSONArray out = new JSONArray();
    int safeLimit = Math.max(1, Math.min(100, limit));
    try (Cursor c = getReadableDatabase().rawQuery("SELECT " + COLUMNS +
        " FROM payment_ledger WHERE local_status NOT IN ('POSTED_TO_FOLIO','FAILED') ORDER BY created_at ASC LIMIT ?",
        new String[]{String.valueOf(safeLimit)})) {
      while (c.moveToNext()) out.put(row(c));
    }
    return out;
  }

  private boolean safe(String value) { return value != null && SAFE_ID.matcher(value).matches(); }
  private boolean safeProviderRef(String value) { return value != null && SAFE_PROVIDER_REF.matcher(value).matches(); }

  private JSONObject row(Cursor c) {
    JSONObject out = new JSONObject();
    try {
      out.put("transactionId", c.getString(0)); out.put("provider", c.getString(1));
      out.put("environment", c.getString(2)); out.put("folioId", c.getString(3));
      out.put("amountMinor", c.getLong(4)); out.put("currency", c.getString(5));
      out.put("localStatus", c.getString(6));
      out.put("providerOrderId", c.isNull(7) ? JSONObject.NULL : c.getString(7));
      out.put("providerPaymentId", c.isNull(8) ? JSONObject.NULL : c.getString(8));
      out.put("createdAt", c.getLong(9)); out.put("updatedAt", c.getLong(10));
    } catch (Exception e) { throw new IllegalStateException("payment_ledger_serialization_failed", e); }
    return out;
  }
}
