const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u;

function invalidVersion(message) {
  const error = new TypeError(message);
  error.code = "MSIX_VERSION_INVALID";
  return error;
}

function component(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw invalidVersion(`${fieldName} must be an integer from 0 through 65535.`);
  }
  return parsed;
}

function prereleaseRevision(prerelease) {
  if (!prerelease) return 0;
  const lastIdentifier = prerelease.split(".").at(-1);
  if (/^(?:0|[1-9]\d*)$/u.test(lastIdentifier)) {
    const numeric = component(lastIdentifier, "MSIX prerelease revision");
    return numeric === 0 ? 1 : numeric;
  }

  let hash = 2_166_136_261;
  for (const byte of Buffer.from(prerelease, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return (hash % 65_535) + 1;
}

export function msixVersionFromSemver(value, options = {}) {
  const source = String(value ?? "").trim();
  const match = SEMVER_PATTERN.exec(source);
  if (!match) throw invalidVersion(`Invalid semantic version: ${source || "empty"}.`);

  const revision = options.revision === undefined
    ? prereleaseRevision(match[4])
    : component(options.revision, "MSIX revision");
  return [
    component(match[1], "MSIX major version"),
    component(match[2], "MSIX minor version"),
    component(match[3], "MSIX patch version"),
    revision,
  ].join(".");
}

export function assertMsixVersion(value) {
  const source = String(value ?? "").trim();
  const components = source.split(".");
  if (components.length !== 4) {
    throw invalidVersion("MSIX version must have exactly four numeric components.");
  }
  components.forEach((valuePart, index) => component(valuePart, `MSIX component ${index + 1}`));
  return source;
}
