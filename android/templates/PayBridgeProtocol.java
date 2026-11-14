package com.aurelia.pms;

/**
 * Stable PMS-side message identifiers for the future Aurelia Pay Bridge.
 *
 * Protocol v1 is intentionally limited to authenticated connection handshake.
 * Reserved operation IDs are not enabled until both APKs implement and test them.
 * Keep this contract synchronized with PAY_BRIDGE_IPC_CONTRACT.md.
 */
public final class PayBridgeProtocol {
  private PayBridgeProtocol() {}

  public static final String PMS_PACKAGE = "com.aurelia.pms";
  public static final String BRIDGE_PACKAGE = "com.aurelia.paybridge";
  public static final String BRIDGE_SERVICE = "com.aurelia.paybridge.ipc.PayBridgeService";
  public static final String BIND_ACTION = "com.aurelia.paybridge.BIND";
  public static final String BIND_PERMISSION = "com.aurelia.paybridge.permission.BIND_PAY_BRIDGE";

  public static final int PROTOCOL_MIN = 1;
  public static final int PROTOCOL_MAX = 1;

  public static final int MSG_HANDSHAKE = 100;
  public static final int MSG_HANDSHAKE_RESULT = 101;

  // Reserved for the future, mutually implemented payment protocol.
  public static final int MSG_CREATE_PAYMENT = 200;
  public static final int MSG_CREATE_PAYMENT_RESULT = 201;
  public static final int MSG_GET_PAYMENT_STATUS = 202;
  public static final int MSG_PAYMENT_STATUS_RESULT = 203;
  public static final int MSG_REQUEST_REFUND = 300;
  public static final int MSG_REQUEST_REFUND_RESULT = 301;
  public static final int MSG_GET_REFUND_STATUS = 302;
  public static final int MSG_GET_REFUND_STATUS_RESULT = 303;
  public static final int MSG_RECONCILE = 400;
  public static final int MSG_RECONCILE_RESULT = 401;
  public static final int MSG_PAYMENT_EVENT = 500;
  public static final int MSG_EVENT_ACK = 501;

  public static final String KEY_PROTOCOL_MIN = "protocolMin";
  public static final String KEY_PROTOCOL_MAX = "protocolMax";
  public static final String KEY_PROTOCOL_VERSION = "protocolVersion";
  public static final String KEY_PACKAGE_NAME = "packageName";
  public static final String KEY_NONCE = "nonce";
  public static final String KEY_CAPABILITIES_JSON = "capabilitiesJson";
  public static final String KEY_REQUEST_ID = "requestId";
  public static final String KEY_TRANSACTION_ID = "transactionId";
  public static final String KEY_BOOKING_ID = "bookingId";
  public static final String KEY_FOLIO_ID = "folioId";
  public static final String KEY_AMOUNT_PAISE = "amountPaise";
  public static final String KEY_CURRENCY = "currency";
  public static final String KEY_PROVIDER_ID = "providerId";
  public static final String KEY_MERCHANT_REFERENCE = "merchantReference";
  public static final String KEY_STATUS = "status";
  public static final String KEY_EVIDENCE_ID = "evidenceId";

  public static final String CAP_HANDSHAKE = "handshake";
  public static final String CAP_PAYMENT_CREATE = "payment.create";
  public static final String CAP_PAYMENT_STATUS = "payment.status";
  public static final String CAP_REFUND_CREATE = "refund.create";
  public static final String CAP_REFUND_STATUS = "refund.status";
  public static final String CAP_RECONCILIATION = "payment.reconciliation";
  public static final String CAP_PAYMENT_EVENTS = "payment.events";

  public static final int MAX_REQUEST_ID_LENGTH = 128;
  public static final int MAX_REFERENCE_LENGTH = 128;
  public static final int MAX_MESSAGE_BYTES = 64 * 1024;
  public static final String CURRENCY_INR = "INR";
}
