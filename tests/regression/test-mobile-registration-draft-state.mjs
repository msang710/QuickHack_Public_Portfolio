import assert from "node:assert/strict";
import {
  MOBILE_REGISTRATION_FORM_IDS,
  ONE_TIME_RESULT_FORM_IDS,
  applyAdbSuggestionAsCleanBaseline,
  emptyMobileRegistrationDraft,
  mobileRegistrationDraftsEqual,
  oneTimeResultIsPending,
} from "../../quickhack_client/components/user/mobile-registration-draft-state.ts";

assert.deepEqual(MOBILE_REGISTRATION_FORM_IDS, {
  personal: "account.mobile-registration",
  admin: "admin.user.mobile-registration",
});
assert.deepEqual(ONE_TIME_RESULT_FORM_IDS, {
  personalRecoveryCodes: "account.totp-recovery-result",
  sensitiveRecoveryCodes: "sensitive.totp-recovery-result",
  adminRecoveryCodes: "admin.user.totp-recovery-result",
});

{
  const baseline = emptyMobileRegistrationDraft();
  assert.equal(
    mobileRegistrationDraftsEqual(baseline, {
      adbSerial: "  ",
      label: " ",
    }),
    true,
    "Whitespace-only registration inputs should stay clean."
  );
  assert.equal(
    mobileRegistrationDraftsEqual(baseline, {
      adbSerial: "R3CT123",
      label: "",
    }),
    false,
    "A manually entered ADB serial was not detected."
  );
  assert.equal(
    mobileRegistrationDraftsEqual(baseline, {
      adbSerial: "",
      label: "포장라인 1",
    }),
    false,
    "A device label change was not detected."
  );
}

{
  const baseline = emptyMobileRegistrationDraft();
  const current = {
    adbSerial: "",
    label: "작성 중인 라벨",
  };
  const next = applyAdbSuggestionAsCleanBaseline({
    baseline,
    current,
    suggestedSerial: " R3CT123 ",
  });

  assert.deepEqual(next, {
    baseline: {
      adbSerial: "R3CT123",
      label: "",
    },
    current: {
      adbSerial: "R3CT123",
      label: "작성 중인 라벨",
    },
  });
  assert.equal(
    mobileRegistrationDraftsEqual(next.baseline, next.current),
    false,
    "ADB lookup incorrectly promoted an edited label into the clean baseline."
  );
}

{
  const baseline = {
    adbSerial: "",
    label: "",
  };
  const current = {
    adbSerial: "MANUAL-1",
    label: "",
  };
  assert.deepEqual(
    applyAdbSuggestionAsCleanBaseline({
      baseline,
      current,
      suggestedSerial: "AUTO-1",
    }),
    { baseline, current },
    "ADB lookup replaced a manually entered serial."
  );
}

assert.equal(oneTimeResultIsPending(["123456"], false), true);
assert.equal(oneTimeResultIsPending(["123456"], true), false);
assert.equal(oneTimeResultIsPending(["", "  "], false), false);

console.log("Mobile registration draft state verified.");
