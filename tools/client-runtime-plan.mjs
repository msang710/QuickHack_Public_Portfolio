import fs from "node:fs";
import path from "node:path";

export function resolveClientRuntimePlan({
  root,
  host,
  port,
  existsSync = fs.existsSync,
}) {
  const standaloneCandidates = [
    path.join(root, "client", "server.js"),
    path.join(root, ".next", "standalone", "server.js"),
  ].filter(Boolean);
  const standaloneEntry = standaloneCandidates.find((candidate) =>
    existsSync(candidate)
  );

  if (standaloneEntry) {
    return {
      mode: "standalone",
      label: "standalone client runtime",
      entry: standaloneEntry,
      cwd: path.dirname(standaloneEntry),
      args: [standaloneEntry],
      nodeEnv: "production",
      nextDistDir: "",
    };
  }

  const sourceNextEntry = path.join(
    root,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next"
  );
  const sourcePackageJson = path.join(root, "package.json");

  if (existsSync(sourceNextEntry) && existsSync(sourcePackageJson)) {
    return {
      mode: "next-source",
      label: "Next source client runtime",
      entry: sourceNextEntry,
      cwd: root,
      args: [
        sourceNextEntry,
        "dev",
        "--hostname",
        host,
        "--port",
        String(port),
      ],
      nodeEnv: "development",
      nextDistDir: ".next-client",
    };
  }

  throw new Error(
    `QuickHack client runtime was not found. Expected one of: ${[
      ...standaloneCandidates,
      sourceNextEntry,
    ].join(", ")}`
  );
}
