package com.quickhack.mobile;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class ActivationRecoveryPolicyTest {
    @Test
    public void replaysAfterResponseLossAndFinalizesAfterCredentialCommit() {
        PendingActivationRecord record = record();
        assertTrue(
            ActivationRecoveryPolicy.startupAction(record, "", record.proofPublicKeySpki)
                == ActivationRecoveryPolicy.StartupAction.REPLAY
        );
        assertTrue(
            ActivationRecoveryPolicy.startupAction(
                record,
                record.deviceToken,
                record.proofPublicKeySpki
            ) == ActivationRecoveryPolicy.StartupAction.FINALIZE_SAVED_CREDENTIAL
        );
        assertTrue(
            ActivationRecoveryPolicy.startupAction(record, "", "different-proof")
                == ActivationRecoveryPolicy.StartupAction.BLOCK_PROOF_MISMATCH
        );
        assertTrue(
            ActivationRecoveryPolicy.startupAction(null, "", "")
                == ActivationRecoveryPolicy.StartupAction.NONE
        );
    }

    @Test
    public void discardsOnlyExplicitTerminalProvisioningFailures() {
        assertTrue(ActivationRecoveryPolicy.isTerminalFailure(response(
            409,
            "MOBILE_DEVICE_PROVISIONING_EXPIRED"
        )));
        assertTrue(ActivationRecoveryPolicy.isTerminalFailure(response(
            409,
            "MOBILE_DEVICE_PROVISIONING_INVALIDATED"
        )));
        assertFalse(ActivationRecoveryPolicy.isTerminalFailure(response(500, "INTERNAL_ERROR")));
        assertFalse(ActivationRecoveryPolicy.isTerminalFailure(response(
            403,
            "MOBILE_DEVICE_AUTH_FAILED"
        )));
        assertFalse(ActivationRecoveryPolicy.isTerminalFailure(null));
    }

    private static QuickHackApi.ApiResponse response(int status, String code) {
        return new QuickHackApi.ApiResponse(
            status,
            "{\"ok\":false,\"code\":\"" + code + "\"}",
            true
        );
    }

    private static PendingActivationRecord record() {
        return PendingActivationRecord.create(
            "https://quickhack.example",
            17,
            4,
            repeat("A", 43),
            "app-instance",
            repeat("B", 43),
            repeat("C", 88),
            repeat("d", 64),
            "payload",
            1786932000000L
        );
    }

    private static String repeat(String value, int count) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }
}
