export type ManualOrderMatchOperation = "ASSIGN" | "REPLACE" | "RELEASE";

export type ManualOrderMatchPreview = {
  eligible: boolean;
  reasonCodes: string[];
  manifestToken: string;
  currentAllocation: { allocationId: number; pgNo: string; status: string } | null;
  candidate: {
    pgNo: string;
    inventoryStatus: string | null;
    model: string;
    storage: string | null;
    color: string | null;
    differences: Array<{ field: string; required: string; actual: string }>;
  } | null;
};

export type ManualOrderMatchCommandDraft = {
  operation: ManualOrderMatchOperation;
  allocationId: number | null;
  pgNo: string;
  selectionReceiptId: string;
  requestChannel: string;
  reason: string;
  preview: ManualOrderMatchPreview | null;
  commandKey: string;
};

export const initialManualOrderMatchCommandDraft: ManualOrderMatchCommandDraft = {
  operation: "ASSIGN",
  allocationId: null,
  pgNo: "",
  selectionReceiptId: "",
  requestChannel: "COUPANG_INQUIRY",
  reason: "",
  preview: null,
  commandKey: "",
};

type DraftEvent =
  | { type: "ORDER_SELECTED"; allocationId: number | null }
  | { type: "OPERATION_CHANGED"; operation: ManualOrderMatchOperation; allocationId: number | null }
  | { type: "ALLOCATION_CHANGED"; allocationId: number | null }
  | { type: "CANDIDATE_SELECTED"; pgNo: string; selectionReceiptId: string }
  | { type: "CANDIDATE_INVALIDATED" }
  | { type: "REQUEST_CHANNEL_CHANGED"; requestChannel: string }
  | { type: "REASON_CHANGED"; reason: string }
  | { type: "PREVIEW_SUCCEEDED"; preview: ManualOrderMatchPreview; commandKey: string }
  | { type: "PREVIEW_FAILED" }
  | { type: "EXECUTE_FINISHED" };

function withoutExecution(state: ManualOrderMatchCommandDraft) {
  return { ...state, preview: null, commandKey: "" };
}

function withoutCandidate(state: ManualOrderMatchCommandDraft) {
  return withoutExecution({ ...state, pgNo: "", selectionReceiptId: "" });
}

export function manualOrderMatchCommandDraftReducer(
  state: ManualOrderMatchCommandDraft,
  event: DraftEvent
): ManualOrderMatchCommandDraft {
  switch (event.type) {
    case "ORDER_SELECTED":
      return {
        ...initialManualOrderMatchCommandDraft,
        operation: event.allocationId === null ? "ASSIGN" : "REPLACE",
        allocationId: event.allocationId,
      };
    case "OPERATION_CHANGED":
      return withoutCandidate({
        ...state,
        operation: event.operation,
        allocationId: event.operation === "ASSIGN" ? null : event.allocationId,
      });
    case "ALLOCATION_CHANGED":
      return withoutExecution({ ...state, allocationId: event.allocationId });
    case "CANDIDATE_SELECTED":
      if (!event.pgNo || !event.selectionReceiptId) {
        return withoutCandidate(state);
      }
      return withoutExecution({
        ...state,
        pgNo: event.pgNo,
        selectionReceiptId: event.selectionReceiptId,
      });
    case "CANDIDATE_INVALIDATED":
      return withoutCandidate(state);
    case "REQUEST_CHANNEL_CHANGED":
      return withoutExecution({ ...state, requestChannel: event.requestChannel });
    case "REASON_CHANGED":
      return withoutExecution({ ...state, reason: event.reason });
    case "PREVIEW_SUCCEEDED":
      return { ...state, preview: event.preview, commandKey: event.commandKey };
    case "PREVIEW_FAILED":
      return withoutExecution(state);
    case "EXECUTE_FINISHED":
      return withoutExecution(state);
  }
}

export function canPreviewManualOrderMatch(
  state: ManualOrderMatchCommandDraft,
  hasSelectedWorkItem: boolean
) {
  return (
    hasSelectedWorkItem &&
    state.reason.trim().length >= 2 &&
    (state.operation === "RELEASE" ||
      (state.pgNo.length > 0 && state.selectionReceiptId.length > 0))
  );
}

export function manualOrderMatchCommandBody(
  state: ManualOrderMatchCommandDraft,
  input: { action: "PREVIEW" | "EXECUTE"; workItemId: number }
) {
  if (!canPreviewManualOrderMatch(state, true)) return null;
  if (
    input.action === "EXECUTE" &&
    (!state.preview?.eligible || !state.commandKey)
  ) {
    return null;
  }
  return {
    action: input.action,
    workItemId: input.workItemId,
    operation: state.operation,
    allocationId: state.allocationId,
    pgNo: state.operation === "RELEASE" ? null : state.pgNo,
    selectionReceiptId:
      state.operation === "RELEASE" ? null : state.selectionReceiptId,
    requestChannel: state.requestChannel,
    reason: state.reason,
    ...(input.action === "EXECUTE"
      ? {
          manifestToken: state.preview!.manifestToken,
          idempotencyKey: state.commandKey,
        }
      : {}),
  };
}
