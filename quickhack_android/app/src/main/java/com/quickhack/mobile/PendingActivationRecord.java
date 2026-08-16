package com.quickhack.mobile;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;
import java.util.regex.Pattern;

final class PendingActivationRecord {
    private static final int VERSION = 2;
    private static final Pattern CREDENTIAL = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern BASE64 = Pattern.compile("^[A-Za-z0-9+/]+={0,2}$");
    private static final Pattern BASE64_URL = Pattern.compile("^[A-Za-z0-9_-]+$");
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");

    final String operationId;
    final String serverOrigin;
    final int deviceId;
    final int registrationRevision;
    final String provisioningToken;
    final String appInstanceId;
    final String deviceToken;
    final String proofPublicKeySpki;
    final String trustBundleDigestSha256;
    final String inboxPayload;
    final long createdAtEpochMillis;

    private PendingActivationRecord(
        String operationId,
        String serverOrigin,
        int deviceId,
        int registrationRevision,
        String provisioningToken,
        String appInstanceId,
        String deviceToken,
        String proofPublicKeySpki,
        String trustBundleDigestSha256,
        String inboxPayload,
        long createdAtEpochMillis,
        boolean legacy
    ) {
        this.operationId = requireUuid(operationId);
        this.serverOrigin = ServerOrigin.normalize(serverOrigin);
        this.deviceId = requirePositive(deviceId, "deviceId");
        this.registrationRevision = requireNonNegative(
            registrationRevision,
            "registrationRevision"
        );
        this.provisioningToken = requireCredential(provisioningToken, "provisioningToken");
        this.appInstanceId = requireBounded(appInstanceId, 1, 128, "appInstanceId");
        this.deviceToken = requireCredential(deviceToken, "deviceToken");
        this.proofPublicKeySpki = requirePattern(
            proofPublicKeySpki,
            BASE64,
            80,
            256,
            "proofPublicKeySpki"
        );
        this.trustBundleDigestSha256 = legacy &&
            (trustBundleDigestSha256 == null || trustBundleDigestSha256.isEmpty())
            ? ""
            : requirePattern(
                trustBundleDigestSha256,
                SHA256,
                64,
                64,
                "trustBundleDigestSha256"
            );
        this.inboxPayload = requirePattern(
            inboxPayload,
            BASE64_URL,
            1,
            16384,
            "inboxPayload"
        );
        if (createdAtEpochMillis <= 0) {
            throw new IllegalArgumentException("createdAtEpochMillis must be positive.");
        }
        this.createdAtEpochMillis = createdAtEpochMillis;
    }

    static PendingActivationRecord create(
        String serverOrigin,
        int deviceId,
        int registrationRevision,
        String provisioningToken,
        String appInstanceId,
        String deviceToken,
        String proofPublicKeySpki,
        String trustBundleDigestSha256,
        String inboxPayload,
        long createdAtEpochMillis
    ) {
        return new PendingActivationRecord(
            UUID.randomUUID().toString(),
            serverOrigin,
            deviceId,
            registrationRevision,
            provisioningToken,
            appInstanceId,
            deviceToken,
            proofPublicKeySpki,
            trustBundleDigestSha256,
            inboxPayload,
            createdAtEpochMillis,
            false
        );
    }

    JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("version", VERSION);
        json.put("operationId", operationId);
        json.put("serverOrigin", serverOrigin);
        json.put("deviceId", deviceId);
        json.put("registrationRevision", registrationRevision);
        json.put("provisioningToken", provisioningToken);
        json.put("appInstanceId", appInstanceId);
        json.put("deviceToken", deviceToken);
        json.put("proofPublicKeySpki", proofPublicKeySpki);
        json.put("trustBundleDigestSha256", trustBundleDigestSha256);
        json.put("inboxPayload", inboxPayload);
        json.put("createdAtEpochMillis", createdAtEpochMillis);
        return json;
    }

    static PendingActivationRecord parse(JSONObject json) throws JSONException {
        int version = json.getInt("version");
        if (version != 1 && version != VERSION) {
            throw new IllegalArgumentException("Unsupported pending activation version.");
        }
        return new PendingActivationRecord(
            json.getString("operationId"),
            json.getString("serverOrigin"),
            json.getInt("deviceId"),
            json.getInt("registrationRevision"),
            json.getString("provisioningToken"),
            json.getString("appInstanceId"),
            json.getString("deviceToken"),
            json.getString("proofPublicKeySpki"),
            version == 1 ? "" : json.getString("trustBundleDigestSha256"),
            json.getString("inboxPayload"),
            json.getLong("createdAtEpochMillis"),
            version == 1
        );
    }

    private static String requireUuid(String value) {
        String normalized = requireBounded(value, 36, 36, "operationId");
        if (!UUID.fromString(normalized).toString().equals(normalized)) {
            throw new IllegalArgumentException("operationId must be a canonical UUID.");
        }
        return normalized;
    }

    private static int requirePositive(int value, String label) {
        if (value <= 0) throw new IllegalArgumentException(label + " must be positive.");
        return value;
    }

    private static int requireNonNegative(int value, String label) {
        if (value < 0) throw new IllegalArgumentException(label + " must be non-negative.");
        return value;
    }

    private static String requireCredential(String value, String label) {
        return requirePattern(value, CREDENTIAL, 43, 43, label);
    }

    private static String requirePattern(
        String value,
        Pattern pattern,
        int minLength,
        int maxLength,
        String label
    ) {
        String normalized = requireBounded(value, minLength, maxLength, label);
        if (!pattern.matcher(normalized).matches()) {
            throw new IllegalArgumentException(label + " has an invalid encoding.");
        }
        return normalized;
    }

    private static String requireBounded(
        String value,
        int minLength,
        int maxLength,
        String label
    ) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.length() < minLength || normalized.length() > maxLength) {
            throw new IllegalArgumentException(label + " has an invalid length.");
        }
        return normalized;
    }
}
