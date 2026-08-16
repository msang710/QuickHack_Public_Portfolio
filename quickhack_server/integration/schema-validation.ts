import { createHash } from "node:crypto";
import type {
  IntegrationJsonObject,
  IntegrationJsonValue,
} from "@/quickhack_shared/integration/contracts";

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class IntegrationSchemaValidationError extends Error {
  readonly code = "INTEGRATION_SCHEMA_INVALID";
  readonly provider: string;
  readonly endpoint: string;
  readonly path: string;
  readonly reason: string;

  constructor(input: {
    provider: string;
    endpoint: string;
    path: string;
    reason: string;
  }) {
    super(
      `Integration response schema is invalid (${input.provider}:${input.endpoint}:${input.path}:${input.reason}).`
    );
    this.name = "IntegrationSchemaValidationError";
    this.provider = input.provider;
    this.endpoint = input.endpoint;
    this.path = input.path;
    this.reason = input.reason;
  }
}

function isDigit(char: string) {
  return char >= "0" && char <= "9";
}

function shouldQuoteIntegerToken(token: string) {
  if (!/^-?\d+$/.test(token)) return false;
  const unsigned = token.startsWith("-") ? token.slice(1) : token;
  if (unsigned.length < 16) return false;

  try {
    const value = BigInt(token);
    const absolute = value < 0n ? -value : value;
    return absolute > MAX_SAFE_INTEGER_BIGINT;
  } catch {
    return false;
  }
}

export function quoteUnsafeJsonIntegers(rawText: string) {
  let output = "";
  let index = 0;

  while (index < rawText.length) {
    const char = rawText[index];

    if (char === '"') {
      const stringStart = index;
      index += 1;
      let escaped = false;

      while (index < rawText.length) {
        const current = rawText[index];
        index += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (current === "\\") {
          escaped = true;
          continue;
        }
        if (current === '"') break;
      }

      output += rawText.slice(stringStart, index);
      continue;
    }

    if (char === "-" || isDigit(char)) {
      const numberStart = index;
      if (char === "-") index += 1;
      while (index < rawText.length && isDigit(rawText[index])) index += 1;

      let hasFractionOrExponent = false;
      if (rawText[index] === ".") {
        hasFractionOrExponent = true;
        index += 1;
        while (index < rawText.length && isDigit(rawText[index])) index += 1;
      }
      if (rawText[index] === "e" || rawText[index] === "E") {
        hasFractionOrExponent = true;
        index += 1;
        if (rawText[index] === "+" || rawText[index] === "-") index += 1;
        while (index < rawText.length && isDigit(rawText[index])) index += 1;
      }

      const token = rawText.slice(numberStart, index);
      output +=
        !hasFractionOrExponent && shouldQuoteIntegerToken(token)
          ? `"${token}"`
          : token;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

export function digestRawIntegrationPayload(rawText: string) {
  return createHash("sha256").update(rawText).digest("hex");
}

export function parseLosslessIntegrationJson<T = unknown>(input: {
  provider: string;
  endpoint: string;
  rawText: string;
}): T {
  try {
    return JSON.parse(quoteUnsafeJsonIntegers(input.rawText)) as T;
  } catch {
    throw new IntegrationSchemaValidationError({
      provider: input.provider,
      endpoint: input.endpoint,
      path: "$",
      reason: "MALFORMED_JSON",
    });
  }
}

export function schemaError(input: {
  provider: string;
  endpoint: string;
  path: string;
  reason: string;
}): never {
  throw new IntegrationSchemaValidationError(input);
}

type ValidationContext = {
  provider: string;
  endpoint: string;
};

export function expectIntegrationObject(
  value: unknown,
  context: ValidationContext,
  path = "$"
): IntegrationJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return schemaError({ ...context, path, reason: "EXPECTED_OBJECT" });
  }
  return value as IntegrationJsonObject;
}

export function expectIntegrationArray(
  value: unknown,
  context: ValidationContext,
  path: string
): IntegrationJsonValue[] {
  if (!Array.isArray(value)) {
    return schemaError({ ...context, path, reason: "EXPECTED_ARRAY" });
  }
  return value as IntegrationJsonValue[];
}

export function expectIntegrationString(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  if (typeof value !== "string") {
    return schemaError({ ...context, path, reason: "EXPECTED_STRING" });
  }
  return value;
}

export function expectIntegrationDecimalId(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  const text =
    typeof value === "string"
      ? value
      : Number.isSafeInteger(value) && Number(value) >= 0
        ? String(value)
        : null;
  if (text === null) {
    return schemaError({ ...context, path, reason: "EXPECTED_DECIMAL_ID" });
  }
  if (!/^\d+$/.test(text)) {
    return schemaError({ ...context, path, reason: "EXPECTED_DECIMAL_ID" });
  }
  return text;
}

export function expectIntegrationSafeInteger(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  if (!Number.isSafeInteger(value)) {
    return schemaError({ ...context, path, reason: "EXPECTED_SAFE_INTEGER" });
  }
  return value as number;
}

export function expectIntegrationNonnegativeSafeInteger(
  value: unknown,
  context: ValidationContext,
  path: string
) {
  const integer = expectIntegrationSafeInteger(value, context, path);
  if (integer < 0) {
    return schemaError({
      ...context,
      path,
      reason: "EXPECTED_NONNEGATIVE_SAFE_INTEGER",
    });
  }
  return integer;
}

export function validateIntegrationJson<
  TNormalized extends IntegrationJsonValue,
>(input: {
  provider: string;
  endpoint: string;
  rawText: string;
  validate: (
    payload: unknown,
    context: ValidationContext
  ) => TNormalized;
}) {
  const context = { provider: input.provider, endpoint: input.endpoint };
  const payload = parseLosslessIntegrationJson({ ...context, rawText: input.rawText });
  return {
    rawPayloadDigest: digestRawIntegrationPayload(input.rawText),
    normalizedResult: input.validate(payload, context),
  } as const;
}
