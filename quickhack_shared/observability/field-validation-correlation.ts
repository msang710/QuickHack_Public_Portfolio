export const FIELD_VALIDATION_RUN_ID_HEADER = "x-quickhack-validation-run-id";
export const FIELD_VALIDATION_SCENARIO_ID_HEADER = "x-quickhack-validation-scenario-id";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function readFieldValidationCorrelation(headers: Pick<Headers, "get">) {
  const runId = headers.get(FIELD_VALIDATION_RUN_ID_HEADER);
  const scenarioId = headers.get(FIELD_VALIDATION_SCENARIO_ID_HEADER);
  if (!runId || !scenarioId || !SAFE_ID.test(runId) || !SAFE_ID.test(scenarioId)) return null;
  return { runId, scenarioId };
}
