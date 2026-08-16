export {
  ensureCurrentWindowsUserSecretDirectory,
  protectForCurrentWindowsUser,
  secureWindowsDirectoryAcl,
  unprotectForCurrentWindowsUser,
  unprotectForCurrentWindowsUserSync,
} from "../platform/windows/server-secret-protector.mjs";
