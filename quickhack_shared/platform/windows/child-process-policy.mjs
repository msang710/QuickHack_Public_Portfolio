import path from "node:path";

const WINDOWS_INHERITED_ENVIRONMENT_NAMES = Object.freeze([
  "ALLUSERSPROFILE",
  "APPDATA",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "SESSIONNAME",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

const WINDOWS_EXECUTABLE_NAMES = Object.freeze({
  commandShell: "cmd.exe",
  explorer: "explorer.exe",
  icacls: "icacls.exe",
  netstat: "netstat.exe",
  powerShell: "powershell.exe",
  taskkill: "taskkill.exe",
  w32tm: "w32tm.exe",
  whoami: "whoami.exe",
});

function environmentValue(source, name) {
  const matchedName = Object.keys(source ?? {}).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return matchedName ? String(source[matchedName] ?? "").trim() : "";
}

export function windowsSystemPaths(source = process.env) {
  const systemRoot = path.win32.resolve(
    environmentValue(source, "SystemRoot") ||
      environmentValue(source, "WINDIR") ||
      "C:\\Windows"
  );
  const system32 = path.win32.join(systemRoot, "System32");
  const powerShellDirectory = path.win32.join(
    system32,
    "WindowsPowerShell",
    "v1.0"
  );
  return Object.freeze({
    systemRoot,
    system32,
    wbem: path.win32.join(system32, "Wbem"),
    powerShellDirectory,
    powerShellModules: path.win32.join(powerShellDirectory, "Modules"),
    commandShell: path.win32.join(system32, WINDOWS_EXECUTABLE_NAMES.commandShell),
    powerShell: path.win32.join(
      powerShellDirectory,
      WINDOWS_EXECUTABLE_NAMES.powerShell
    ),
    explorer: path.win32.join(systemRoot, WINDOWS_EXECUTABLE_NAMES.explorer),
  });
}

export function resolveWindowsSystemExecutable(key, source = process.env) {
  if (!Object.hasOwn(WINDOWS_EXECUTABLE_NAMES, key)) {
    throw new TypeError(`Unsupported Windows system executable key: ${key}.`);
  }
  const paths = windowsSystemPaths(source);
  if (key === "powerShell" || key === "commandShell" || key === "explorer") {
    return paths[key];
  }
  return path.win32.join(paths.system32, WINDOWS_EXECUTABLE_NAMES[key]);
}

export function createWindowsChildProcessPolicy(source = process.env) {
  const paths = windowsSystemPaths(source);
  const systemDrive =
    environmentValue(source, "SystemDrive") ||
    path.win32.parse(paths.systemRoot).root.replace(/\\$/, "");
  return Object.freeze({
    version: 1,
    inheritedNames: WINDOWS_INHERITED_ENVIRONMENT_NAMES,
    pathName: "Path",
    pathDelimiter: ";",
    basePathEntries: Object.freeze([
      paths.system32,
      paths.systemRoot,
      paths.wbem,
      paths.powerShellDirectory,
    ]),
    requiredValues: Object.freeze({
      SystemRoot: paths.systemRoot,
      WINDIR: paths.systemRoot,
      SystemDrive: systemDrive,
      ComSpec: paths.commandShell,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PSModulePath: paths.powerShellModules,
    }),
    caseInsensitiveNames: true,
  });
}
