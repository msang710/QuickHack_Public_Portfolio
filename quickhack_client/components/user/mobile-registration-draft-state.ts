import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";

export const MOBILE_REGISTRATION_FORM_IDS = {
  personal: "account.mobile-registration",
  admin: "admin.user.mobile-registration",
} as const;

export const ONE_TIME_RESULT_FORM_IDS = {
  personalRecoveryCodes: "account.totp-recovery-result",
  sensitiveRecoveryCodes: "sensitive.totp-recovery-result",
  adminRecoveryCodes: "admin.user.totp-recovery-result",
} as const;

export type MobileRegistrationDraft = {
  adbSerial: string;
  label: string;
};

export function emptyMobileRegistrationDraft(): MobileRegistrationDraft {
  return {
    adbSerial: "",
    label: "",
  };
}

export function createMobileRegistrationDraftSnapshot(
  draft: MobileRegistrationDraft
): MobileRegistrationDraft {
  return {
    adbSerial: draft.adbSerial.trim(),
    label: draft.label.trim(),
  };
}

export function mobileRegistrationDraftsEqual(
  baseline: MobileRegistrationDraft,
  current: MobileRegistrationDraft
) {
  return unsavedFormSnapshotsEqual(
    createMobileRegistrationDraftSnapshot(baseline),
    createMobileRegistrationDraftSnapshot(current)
  );
}

export function applyAdbSuggestionAsCleanBaseline({
  baseline,
  current,
  suggestedSerial,
}: {
  baseline: MobileRegistrationDraft;
  current: MobileRegistrationDraft;
  suggestedSerial: string;
}) {
  if (current.adbSerial.trim() || !suggestedSerial.trim()) {
    return { baseline, current };
  }

  const normalizedSerial = suggestedSerial.trim();
  return {
    baseline: {
      ...baseline,
      adbSerial: normalizedSerial,
    },
    current: {
      ...current,
      adbSerial: normalizedSerial,
    },
  };
}

export function oneTimeResultIsPending(
  values: readonly string[],
  acknowledged: boolean
) {
  return !acknowledged && values.some((value) => value.trim().length > 0);
}
