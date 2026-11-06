package com.aurelia.pms;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class UPINotificationListener extends NotificationListenerService {
  private static final String TAG = "AureliaUPI";
  private static final String[] PACKAGES = {
    "com.google.android.apps.nbu.paisa.user", "com.phonepe.app",
    "net.one97.paytm", "in.org.npci.upiapp"
  };
  private static final Pattern AMOUNT = Pattern.compile(
    "(?i)(?:₹|INR\\s*|Rs\\.?\\s*)([0-9,]+(?:\\.[0-9]{1,2})?)");
  private static final Pattern UTR = Pattern.compile(
    "(?i)\\b(?:UTR|UPI\\s*(?:Ref(?:erence)?|ID)|Ref(?:erence)?\\s*(?:No\\.?)?)\\s*[:#-]?\\s*([A-Z0-9]{8,30})\\b");
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private NotificationQueueDb db;

  @Override public void onCreate() { super.onCreate(); db = new NotificationQueueDb(this); }

  @Override public void onNotificationPosted(StatusBarNotification sbn) {
    if (sbn == null || sbn.getPackageName() == null || !allowed(sbn.getPackageName())) return;
    Notification n = sbn.getNotification();
    if (n == null || n.extras == null) return;
    Bundle e = n.extras;
    CharSequence title = e.getCharSequence(Notification.EXTRA_TITLE);
    CharSequence body = e.getCharSequence(Notification.EXTRA_TEXT);
    String text = ((title == null ? "" : title.toString()) + " " +
      (body == null ? "" : body.toString())).trim();
    if (text.isEmpty()) return;
    String normalized = text.toLowerCase(Locale.ROOT);
    if (contains(normalized, "payment failed", "transaction failed", "payment declined",
        "you paid", "sent to", "money sent", "debited", "reversed", "refund initiated")) return;
    if (!contains(normalized, "received", "credited", "money received", "payment successful",
        "paid you", "received from")) return;
    Matcher am = AMOUNT.matcher(text);
    if (!am.find()) return;
    final long paise;
    try { paise = new BigDecimal(am.group(1).replace(",", "")).movePointRight(2).longValueExact(); }
    catch (Exception ex) { return; }
    if (paise <= 0 || paise > 100000000000L) return;
    Matcher um = UTR.matcher(text);
    final String utr = um.find() ? um.group(1) : null;
    final String pkg = sbn.getPackageName();
    final long time = sbn.getPostTime();
    executor.execute(() -> {
      try {
        String fingerprint = digest(pkg + "\n" + time + "\n" + text);
        Log.i(TAG, "Evidence captured: " + db.enqueue(pkg, utr, paise, text, time, fingerprint));
      } catch (Exception ex) { Log.e(TAG, "Could not persist notification evidence", ex); }
    });
  }

  private static boolean allowed(String p) {
    for (String candidate : PACKAGES) if (candidate.equals(p)) return true;
    return false;
  }
  private static boolean contains(String s, String... terms) {
    for (String term : terms) if (s.contains(term)) return true;
    return false;
  }
  private static String digest(String s) throws Exception {
    byte[] bytes = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder();
    for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }
  @Override public void onDestroy() {
    executor.shutdown();
    if (db != null) db.close();
    super.onDestroy();
  }
}
