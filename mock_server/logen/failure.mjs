import { sendJson, sendMalformedJson } from "./response.mjs";

function percentageHit(rate) {
  return Number(rate) > 0 && Math.random() * 100 < Number(rate);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(low, max);
  return low + Math.floor(Math.random() * (high - low + 1));
}

export function updateFailurePolicy(policy, input) {
  if (typeof input.enabled === "boolean") policy.enabled = input.enabled;
  if (typeof input.target === "string" && input.target.trim()) {
    policy.target = input.target.trim();
  }
  for (const name of [
    "httpFailureRate",
    "timeoutRate",
    "malformedJsonRate",
    "missingRequiredFieldRate",
    "partialDataLossRate",
    "writeAppliedResponseFailureRate",
  ]) {
    if (Number.isFinite(Number(input[name]))) {
      policy[name] = Math.min(100, Math.max(0, Number(input[name])));
    }
  }
  for (const name of ["minDelayMs", "maxDelayMs", "timeoutMs"]) {
    if (Number.isSafeInteger(Number(input[name])) && Number(input[name]) >= 0) {
      policy[name] = Math.min(120000, Number(input[name]));
    }
  }
  if (Number.isSafeInteger(Number(input.httpStatus))) {
    policy.httpStatus = Math.min(599, Math.max(400, Number(input.httpStatus)));
  }
  return policy;
}

export async function maybeSimulateFailure(response, policy, target) {
  if (!policy.enabled || (policy.target !== "all" && policy.target !== target)) {
    return false;
  }

  if (policy.maxDelayMs > 0) {
    await sleep(randomDelay(policy.minDelayMs, policy.maxDelayMs));
  }

  if (percentageHit(policy.timeoutRate)) {
    setTimeout(() => {
      if (!response.writableEnded) {
        sendJson(response, 504, {
          sttsCd: "FAIL",
          sttsMsg: "Mock timeout simulation",
        });
      }
    }, policy.timeoutMs);
    return true;
  }

  if (percentageHit(policy.httpFailureRate)) {
    sendJson(response, policy.httpStatus, {
      sttsCd: "FAIL",
      sttsMsg: "Mock HTTP failure simulation",
    });
    return true;
  }

  return false;
}

function targetMatches(policy, target) {
  return policy.enabled && (policy.target === "all" || policy.target === target);
}

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

export function applyPayloadFailure(policy, target, payload) {
  if (!targetMatches(policy, target)) return payload;
  const next = clonePayload(payload);
  if (
    percentageHit(policy.partialDataLossRate) &&
    Array.isArray(next.data) &&
    next.data.length > 1
  ) {
    next.data = next.data.slice(0, -1);
    next.sttsMsg = `${next.sttsMsg || ""} [Mock partial data loss]`.trim();
  }
  if (percentageHit(policy.missingRequiredFieldRate)) {
    if (Array.isArray(next.data) && next.data[0] && typeof next.data[0] === "object") {
      delete next.data[0].resultCd;
    } else {
      delete next.sttsCd;
    }
  }
  return next;
}

export function maybeSendPostProcessingFailure(response, policy, target, isWrite) {
  if (!targetMatches(policy, target)) return false;
  if (isWrite && percentageHit(policy.writeAppliedResponseFailureRate)) {
    sendJson(response, policy.httpStatus, {
      sttsCd: "FAIL",
      sttsMsg: "Mock write was applied but its success response was lost.",
    });
    return true;
  }
  if (percentageHit(policy.malformedJsonRate)) {
    sendMalformedJson(response);
    return true;
  }
  return false;
}
