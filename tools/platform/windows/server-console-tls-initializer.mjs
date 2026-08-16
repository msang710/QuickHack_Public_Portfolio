import path from "node:path";
import fs from "node:fs";
import { runPowerShellScript } from "../../../quickhack_server/security/async-powershell.mjs";

export async function initializeWindowsServerConsoleTls(input) {
  if (!fs.existsSync(input.scriptPath)) {
    const error = new Error("The HTTPS initialization script was not found.");
    error.code = "DEPENDENCY_MISSING";
    throw error;
  }
  const hostNames = [...new Set(input.hostNames.map((value) => String(value).trim()).filter(Boolean))];
  const argumentsLine = JSON.stringify({
    scriptPath: path.resolve(input.scriptPath),
    dataDir: path.resolve(input.dataDir),
    httpsPort: input.httpsPort,
    hostNames,
  });
  const encoded = Buffer.from(argumentsLine, "utf8").toString("base64");
  await runPowerShellScript(
    "$ErrorActionPreference='Stop'; $input=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))|ConvertFrom-Json; " +
      "& $input.scriptPath -DataDir $input.dataDir -HttpsPort $input.httpsPort -HostNamesCsv ($input.hostNames -join ',')",
    { inputLine: encoded, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 }
  );
}
