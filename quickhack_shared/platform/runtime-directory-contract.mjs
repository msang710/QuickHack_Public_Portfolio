export const RUNTIME_DIRECTORY_FIELDS = Object.freeze([
  "appRoot",
  "runtimeDir",
  "configDir",
  "dataDir",
  "stateDir",
  "logDir",
  "cacheDir",
  "secretDir",
  "artifactDir",
]);

function absolutePath(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized || !/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(normalized)) {
    throw new TypeError(`Runtime directory ${fieldName} must be an absolute path.`);
  }
  return normalized;
}

export function createRuntimeDirectorySnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Runtime directory snapshot input is required.");
  }
  const snapshot = {};
  for (const fieldName of RUNTIME_DIRECTORY_FIELDS) {
    snapshot[fieldName] = absolutePath(input[fieldName], fieldName);
  }
  return Object.freeze(snapshot);
}

export function assertAbsoluteRuntimeDirectory(value, fieldName) {
  return absolutePath(value, fieldName);
}
