package com.quickhack.mobile;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public final class PendingActivationRecordTest {
    @Test
    public void roundTripsEveryReplayIdentityField() throws Exception {
        PendingActivationRecord original = PendingActivationRecord.create(
            "https://quickhack.example/",
            17,
            4,
            repeat("A", 43),
            "d7652774-60a6-4e60-95c8-5d0581e32584",
            repeat("B", 43),
            repeat("C", 88),
            repeat("d", 64),
            "eyJ2ZXJzaW9uIjoxfQ",
            1786932000000L
        );

        PendingActivationRecord recovered = PendingActivationRecord.parse(
            new JSONObject(original.toJson().toString())
        );

        assertEquals(original.operationId, recovered.operationId);
        assertEquals("https://quickhack.example", recovered.serverOrigin);
        assertEquals(original.deviceId, recovered.deviceId);
        assertEquals(original.registrationRevision, recovered.registrationRevision);
        assertEquals(original.provisioningToken, recovered.provisioningToken);
        assertEquals(original.appInstanceId, recovered.appInstanceId);
        assertEquals(original.deviceToken, recovered.deviceToken);
        assertEquals(original.proofPublicKeySpki, recovered.proofPublicKeySpki);
        assertEquals(original.trustBundleDigestSha256, recovered.trustBundleDigestSha256);
        assertEquals(original.inboxPayload, recovered.inboxPayload);
        assertEquals(original.createdAtEpochMillis, recovered.createdAtEpochMillis);
    }

    @Test
    public void rejectsCredentialsThatCannotBeReplayedExactly() {
        assertThrows(
            IllegalArgumentException.class,
            () -> PendingActivationRecord.create(
                "https://quickhack.example",
                17,
                4,
                "predictable-token",
                "app-instance",
                repeat("B", 43),
                repeat("C", 88),
                repeat("d", 64),
                "payload",
                1786932000000L
            )
        );
    }

    @Test
    public void readsLegacyV1WithoutInventingTrustIdentity() throws Exception {
        PendingActivationRecord current = PendingActivationRecord.create(
            "https://quickhack.example",
            17,
            4,
            repeat("A", 43),
            "d7652774-60a6-4e60-95c8-5d0581e32584",
            repeat("B", 43),
            repeat("C", 88),
            repeat("d", 64),
            "eyJ2ZXJzaW9uIjoxfQ",
            1786932000000L
        );
        JSONObject legacy = new JSONObject(current.toJson().toString());
        legacy.put("version", 1);
        legacy.remove("trustBundleDigestSha256");

        PendingActivationRecord recovered = PendingActivationRecord.parse(legacy);
        assertEquals("", recovered.trustBundleDigestSha256);
    }

    @Test
    public void rejectsInvalidOriginAndRevision() {
        assertThrows(
            IllegalArgumentException.class,
            () -> PendingActivationRecord.create(
                "not-an-origin",
                17,
                -1,
                repeat("A", 43),
                "app-instance",
                repeat("B", 43),
                repeat("C", 88),
                repeat("d", 64),
                "payload",
                1786932000000L
            )
        );
    }

    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }
}
