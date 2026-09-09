export const ADB_CLIENT_API_CODE = {
  clientRuntimeRequired: "CLIENT_RUNTIME_REQUIRED",
  authRequired: "AUTH_REQUIRED",
  invalidBody: "INVALID_BODY",
  provisionForbidden: "PROVISION_FORBIDDEN",
  deviceReadForbidden: "DEVICE_READ_FORBIDDEN",
  actionForbidden: "ACTION_FORBIDDEN",
  actionRequired: "ACTION_REQUIRED",
  serialsRequired: "SERIALS_REQUIRED",
  serialEmpty: "SERIAL_EMPTY",
  physicalDeviceRequired: "PHYSICAL_DEVICE_REQUIRED",
  targetNotReady: "ADB_TARGET_NOT_READY",
  actionUnsupported: "ADB_ACTION_UNSUPPORTED",
  trustBundleInvalid: "TRUST_BUNDLE_INVALID",
  centralResponseInvalid: "CENTRAL_RESPONSE_INVALID",
  deliveryCompensated: "DELIVERY_COMPENSATED",
  deliveryRecoveryRequired: "DELIVERY_RECOVERY_REQUIRED",
  provisionDelivered: "PROVISION_DELIVERED",
  serverProxyUnavailable: "SERVER_PROXY_UNAVAILABLE",
  serverProxyTimeout: "SERVER_PROXY_TIMEOUT",
  serverProxyInvalidResponse: "SERVER_PROXY_INVALID_RESPONSE",
  serverProxyUpstreamError: "SERVER_PROXY_UPSTREAM_ERROR",
} as const;

export type AdbClientApiCode =
  (typeof ADB_CLIENT_API_CODE)[keyof typeof ADB_CLIENT_API_CODE];

export const ADB_CLIENT_API_MESSAGE_KEYS = {
  CLIENT_RUNTIME_REQUIRED: "clientRuntimeRequired",
  AUTH_REQUIRED: "authRequired",
  INVALID_BODY: "invalidBody",
  PROVISION_FORBIDDEN: "provisionForbidden",
  DEVICE_READ_FORBIDDEN: "deviceReadForbidden",
  ACTION_FORBIDDEN: "actionForbidden",
  ACTION_REQUIRED: "actionRequired",
  SERIALS_REQUIRED: "serialsRequired",
  SERIAL_EMPTY: "serialEmpty",
  PHYSICAL_DEVICE_REQUIRED: "physicalDeviceRequired",
  ADB_TARGET_NOT_READY: "targetNotReady",
  ADB_ACTION_UNSUPPORTED: "actionUnsupported",
  TRUST_BUNDLE_INVALID: "trustBundleInvalid",
  CENTRAL_RESPONSE_INVALID: "centralResponseInvalid",
  DELIVERY_COMPENSATED: "deliveryCompensated",
  DELIVERY_RECOVERY_REQUIRED: "deliveryRecoveryRequired",
  PROVISION_DELIVERED: "provisionDelivered",
  SERVER_PROXY_UNAVAILABLE: "serverProxyUnavailable",
  SERVER_PROXY_TIMEOUT: "serverProxyTimeout",
  SERVER_PROXY_INVALID_RESPONSE: "serverProxyInvalidResponse",
  SERVER_PROXY_UPSTREAM_ERROR: "serverProxyUpstreamError",
} as const satisfies Record<AdbClientApiCode, string>;

export function isAdbClientApiCode(value: unknown): value is AdbClientApiCode {
  return typeof value === "string" && value in ADB_CLIENT_API_MESSAGE_KEYS;
}
