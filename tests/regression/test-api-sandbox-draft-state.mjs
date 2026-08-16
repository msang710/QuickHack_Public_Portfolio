import assert from "node:assert/strict";
import {
  API_SANDBOX_FORM_ID,
  apiSandboxDraftsEqual,
  createApiSandboxDraftSnapshot,
  defaultApiSandboxDraft,
} from "../../quickhack_client/components/developer/api-sandbox-draft-state.ts";

assert.equal(API_SANDBOX_FORM_ID, "developer.api-sandbox-request");

{
  const baseline = defaultApiSandboxDraft();
  assert.equal(apiSandboxDraftsEqual(baseline, { ...baseline }), true);
  assert.equal(
    apiSandboxDraftsEqual(baseline, {
      ...baseline,
      method: " get ",
      path: " /api/developer/diagnostics ",
    }),
    true,
    "Method and path normalization created a false dirty state."
  );
  assert.equal(
    apiSandboxDraftsEqual(baseline, {
      ...baseline,
      body: "{\n  \n}",
    }),
    false,
    "An exact request body change was not detected."
  );
  assert.equal(
    apiSandboxDraftsEqual(baseline, {
      ...baseline,
      allowWrite: true,
    }),
    false,
    "The write permission change was not detected."
  );
}

assert.deepEqual(
  createApiSandboxDraftSnapshot({
    method: " post ",
    path: " /api/inventory/device?pg=1 ",
    body: '{"ok":true}',
    allowWrite: true,
  }),
  {
    method: "POST",
    path: "/api/inventory/device?pg=1",
    body: '{"ok":true}',
    allowWrite: true,
  }
);

console.log("API sandbox draft state verified.");
