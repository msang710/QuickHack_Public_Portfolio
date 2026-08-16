import { assertProcessEnvironmentPolicy } from "../platform/process-execution-contract.mjs";

function environmentValue(source, name, caseInsensitive) {
  const direct = source?.[name];
  if (direct !== undefined && direct !== null && String(direct) !== "") {
    return String(direct);
  }
  if (!caseInsensitive || !source || typeof source !== "object") return "";
  const matchedName = Object.keys(source).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  const matched = matchedName ? source[matchedName] : undefined;
  return matched === undefined || matched === null ? "" : String(matched);
}

function scalarEnvironmentValue(value, name) {
  if (value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new TypeError(`Child process environment override must be scalar: ${name}.`);
}

function uniqueAbsoluteDirectories(values, delimiter) {
  const result = [];
  const identities = new Set();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) continue;
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(normalized)) {
      throw new TypeError(`Child process PATH entry must be absolute: ${normalized}.`);
    }
    const resolved = normalized;
    const identity = delimiter === ";" ? resolved.toLowerCase() : resolved;
    if (identities.has(identity)) continue;
    identities.add(identity);
    result.push(resolved);
  }
  return result;
}

export function createChildProcessEnvironment({
  policy,
  source = {},
  executableDirectories = [],
  overrides = {},
} = {}) {
  const validatedPolicy = assertProcessEnvironmentPolicy(policy);
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Child process environment source must be an object.");
  }
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("Child process environment overrides must be an object.");
  }

  const environment = {};
  for (const name of validatedPolicy.inheritedNames) {
    const value = environmentValue(
      source,
      name,
      validatedPolicy.caseInsensitiveNames === true
    );
    if (value) environment[name] = value;
  }
  Object.assign(environment, validatedPolicy.requiredValues);
  environment[validatedPolicy.pathName] = uniqueAbsoluteDirectories(
    [...executableDirectories, ...validatedPolicy.basePathEntries],
    validatedPolicy.pathDelimiter
  ).join(validatedPolicy.pathDelimiter);

  for (const [name, value] of Object.entries(overrides)) {
    const normalized = scalarEnvironmentValue(value, name);
    if (normalized === undefined) delete environment[name];
    else environment[name] = normalized;
  }
  return environment;
}
