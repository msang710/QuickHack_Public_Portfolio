import { unsavedFormSnapshotsEqual } from "@/quickhack_client/lib/unsaved-changes";

export const API_SANDBOX_FORM_ID = "developer.api-sandbox-request";

export type ApiSandboxDraft = {
  method: string;
  path: string;
  body: string;
  allowWrite: boolean;
};

export function defaultApiSandboxDraft(): ApiSandboxDraft {
  return {
    method: "GET",
    path: "/api/developer/diagnostics",
    body: "{\n}",
    allowWrite: false,
  };
}

export function createApiSandboxDraftSnapshot(
  draft: ApiSandboxDraft
): ApiSandboxDraft {
  return {
    method: draft.method.trim().toUpperCase(),
    path: draft.path.trim(),
    body: draft.body,
    allowWrite: Boolean(draft.allowWrite),
  };
}

export function apiSandboxDraftsEqual(
  baseline: ApiSandboxDraft,
  current: ApiSandboxDraft
) {
  return unsavedFormSnapshotsEqual(
    createApiSandboxDraftSnapshot(baseline),
    createApiSandboxDraftSnapshot(current)
  );
}
