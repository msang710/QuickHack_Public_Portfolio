package com.quickhack.mobile;

final class ActivationRecoveryPolicy {
    enum StartupAction {
        NONE,
        REPLAY,
        FINALIZE_SAVED_CREDENTIAL,
        BLOCK_PROOF_MISMATCH
    }

    static StartupAction startupAction(
        PendingActivationRecord record,
        String storedDeviceToken,
        String currentProofPublicKeySpki
    ) {
        if (record == null) return StartupAction.NONE;
        if (!record.proofPublicKeySpki.equals(currentProofPublicKeySpki)) {
            return StartupAction.BLOCK_PROOF_MISMATCH;
        }
        if (record.deviceToken.equals(storedDeviceToken)) {
            return StartupAction.FINALIZE_SAVED_CREDENTIAL;
        }
        return StartupAction.REPLAY;
    }

    static boolean isTerminalFailure(QuickHackApi.ApiResponse response) {
        if (response == null) return false;
        String code = response.errorCode();
        return "MOBILE_DEVICE_PROVISIONING_EXPIRED".equals(code)
            || "MOBILE_DEVICE_PROVISIONING_INVALIDATED".equals(code);
    }

    private ActivationRecoveryPolicy() {}
}
