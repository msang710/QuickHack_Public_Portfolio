export const INTEGRATION_COMMAND_STATUSES = [
  "PENDING",
  "DISPATCHING",
  "SUCCEEDED",
  "NOT_APPLIED",
  "AMBIGUOUS",
  "FAILED_LOCAL",
] as const;

export type IntegrationCommandStatus =
  (typeof INTEGRATION_COMMAND_STATUSES)[number];

export const INTEGRATION_COMMAND_OUTCOMES = [
  "SUCCEEDED",
  "NOT_APPLIED",
  "AMBIGUOUS",
  "FAILED_LOCAL",
] as const;

export type IntegrationCommandOutcome =
  (typeof INTEGRATION_COMMAND_OUTCOMES)[number];

export type IntegrationDispatchOutcome = Exclude<
  IntegrationCommandOutcome,
  "FAILED_LOCAL"
>;

export const INTEGRATION_ATTEMPT_STATUSES = [
  "CREATED",
  "DISPATCHED",
  "RESPONSE_RECEIVED",
  "CONNECTION_LOST",
  "FAILED_LOCAL",
] as const;

export type IntegrationAttemptStatus =
  (typeof INTEGRATION_ATTEMPT_STATUSES)[number];

export const INTEGRATION_PROJECTION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
] as const;

export type IntegrationProjectionStatus =
  (typeof INTEGRATION_PROJECTION_STATUSES)[number];

export type IntegrationJsonPrimitive = string | number | boolean | null;
export type IntegrationJsonValue =
  | IntegrationJsonPrimitive
  | IntegrationJsonValue[]
  | { [key: string]: IntegrationJsonValue };
export type IntegrationJsonObject = {
  [key: string]: IntegrationJsonValue;
};

export type IntegrationTransportResponse = {
  httpStatusCode: number;
  rawPayloadText: string;
  providerCode?: string | null;
  occurredAt?: Date | null;
};

export type IntegrationClassifiedResponse<
  TNormalized extends IntegrationJsonValue = IntegrationJsonValue,
> = {
  outcome: Exclude<IntegrationDispatchOutcome, "AMBIGUOUS">;
  normalizedResult?: TNormalized;
  projectionHandlerKeys?: readonly string[];
  errorCode?: string | null;
};

export type IntegrationClassifiedDispatchError = {
  outcome: "NOT_APPLIED" | "AMBIGUOUS";
  response?: IntegrationTransportResponse | null;
  errorCode?: string | null;
};
