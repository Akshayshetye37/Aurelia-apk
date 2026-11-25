package com.aurelia.pms;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Optional, user-enabled incoming UPI notification observer.
 * Captures only allowlisted UPI/bank apps and only credit-like UPI alerts.
 * The encrypted SQLCipher repository must be unlocked; no SMS permission is used.
 */
public final class AureliaUPINotificationListener extends NotificationListenerService {
  private static final String TAG = "AureliaUPIObserver";
  private static final Set<String> ALLOWED_PACKAGES = new HashSet<>(Arrays.asList(
    "com.google.android.apps.nbu.paisa.user",
    "com.phonepe.app",
    "net.one97.paytm",
    "in.org.npci.upiapp",
    "com.sbi.lotusintouch",
    "com.csam.icici.bank.imobile",
    "com.snapwork.hdfc",
    "com.axis.mobile",
    "com.kotak811",
    "com.bankofbaroda.mpassbook",
    "com.idfcfirstbank.optimus",
    "com.fss.pnbpsp"
  ));
  private static final Pattern AMOUNT = Pattern.compile("(?:₹|INR\\s*|Rs\\.?\\s*)([0-9,]+(?:\\.[0-9]{1,2})?)", Pattern.CASE_INSENSITIVE);
  private static final Pattern UTR = Pattern.compile("\\b(?:UTR|UPI\\s*(?:Ref(?:erence)?|ID)|RRN|Ref(?:erence)?\\s*(?:No\\.?|Number)?)\\s*[:#-]?\\s*([A-Z0-9]{8,30})\\b", Pattern.CASE_INSENSITIVE);
  private static final String[] CREDIT = {"credited", "received", "received from", "paid you", "money received", "payment successful"};
  private static final String[] EXCLUDE = {"debited", "you paid", "sent to", "money sent", "payment failed", "declined", "reversed", "refund", "otp"};
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private volatile boolean connected;

  @Override public void onListenerConnected() {
    super.onListenerConnected();
    connected = true;
  }

  @Override public void onListenerDisconnected() {
    connected = false;
    super.onListenerDisconnected();
  }

  @Override public void onNotificationPosted(StatusBarNotification posted) {
    if (!connected || posted == null || posted.getNotification() == null) return;
    String packageName = posted.getPackageName();
    if (packageName == null || !ALLOWED_PACKAGES.contains(packageName)) return;
    String text = notificationText(posted.getNotification().extras);
    if (text.isEmpty() || text.length() > 4000) return;
    ParsedCredit parsed = parseCredit(text);
    if (parsed == null) return;
    long receivedAt = posted.getPostTime() > 0L ? posted.getPostTime() : System.currentTimeMillis();
    String fingerprint;
    try {
      fingerprint = sha256(packageName + "|" + receivedAt + "|" + text.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT));
    } catch (Exception error) {
      Log.w(TAG, "UPI evidence fingerprint unavailable");
      return;
    }
    String evidenceId = "upi_noti_" + fingerprint.substring(0, 32);
    worker.execute(() -> {
      try (LocalPmsRepository repository = new LocalPmsRepository(this)) {
        repository.enqueueUpiEvidence(evidenceId, packageName, parsed.amountPaise,
          parsed.utr, text, receivedAt, fingerprint);
      } catch (Exception error) {
        // The database is intentionally not unlocked by the observer. If PMS is locked,
        // evidence is not persisted and no plaintext fallback is created.
        Log.w(TAG, "UPI observer could not persist evidence; PMS may be locked");
      }
    });
  }

  private static String notificationText(Bundle extras) {
    if (extras == null) return "";
    StringBuilder value = new StringBuilder();
    append(value, extras.getCharSequence(Notification.EXTRA_TITLE));
    append(value, extras.getCharSequence(Notification.EXTRA_TEXT));
    append(value, extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
    append(value, extras.getCharSequence(Notification.EXTRA_SUB_TEXT));
    return value.toString().trim();
  }

  private static void append(StringBuilder target, CharSequence value) {
    if (value == null || value.length() == 0) return;
    if (target.length() > 0) target.append(" · ");
    target.append(value);
  }

  private static ParsedCredit parseCredit(String text) {
    String normalized = text.toLowerCase(Locale.ROOT);
    for (String word : EXCLUDE) if (normalized.contains(word)) return null;
    boolean credit = false;
    for (String word : CREDIT) if (normalized.contains(word)) { credit = true; break; }
    if (!credit || !Pattern.compile("\\bupi\\b|vpa|utr|rrn", Pattern.CASE_INSENSITIVE).matcher(text).find()) return null;
    Matcher amountMatcher = AMOUNT.matcher(text);
    if (!amountMatcher.find()) return null;
    try {
      BigDecimal rupees = new BigDecimal(amountMatcher.group(1).replace(",", ""));
      long paise = rupees.movePointRight(2).longValueExact();
      if (paise <= 0L || paise > 100000000000L) return null;
      Matcher utrMatcher = UTR.matcher(text);
      String utr = utrMatcher.find() ? utrMatcher.group(1).toUpperCase(Locale.ROOT) : null;
      return new ParsedCredit(paise, utr);
    } catch (Exception ignored) {
      return null;
    }
  }

  private static String sha256(String value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    StringBuilder result = new StringBuilder(digest.length * 2);
    for (byte b : digest) result.append(String.format(Locale.ROOT, "%02x", b & 0xff));
    return result.toString();
  }

  @Override public void onDestroy() {
    connected = false;
    worker.shutdown();
    super.onDestroy();
  }

  private static final class ParsedCredit {
    final long amountPaise;
    final String utr;
    ParsedCredit(long amountPaise, String utr) {
      this.amountPaise = amountPaise;
      this.utr = utr;
    }
  }
}
