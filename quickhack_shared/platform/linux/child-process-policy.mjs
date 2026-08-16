import path from "node:path";

const LINUX_INHERITED_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "TMPDIR",
  "USER",
]);

const LINUX_EXECUTABLES = Object.freeze({
  adb: "/usr/bin/adb",
  env: "/usr/bin/env",
  lp: "/usr/bin/lp",
  lpstat: "/usr/bin/lpstat",
  systemdCreds: "/usr/bin/systemd-creds",
});

export function resolveLinuxSystemExecutable(key) {
  if (!Object.hasOwn(LINUX_EXECUTABLES, key)) {
    throw new TypeError(`Unsupported Linux system executable key: ${key}.`);
  }
  return LINUX_EXECUTABLES[key];
}

export function createLinuxChildProcessPolicy(_source = {}) {
  return Object.freeze({
    version: 1,
    inheritedNames: LINUX_INHERITED_ENVIRONMENT_NAMES,
    pathName: "PATH",
    pathDelimiter: ":",
    basePathEntries: Object.freeze([
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].map((entry) => path.posix.normalize(entry))),
    requiredValues: Object.freeze({}),
    caseInsensitiveNames: false,
  });
}
