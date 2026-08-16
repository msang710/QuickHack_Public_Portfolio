import path from "node:path";
import { resolveClientRuntimePlan } from "../../tools/client-runtime-plan.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = path.resolve("C:/quickhack-client-runtime-fixture");

function existsOnly(...relativePaths) {
  const existing = new Set(
    relativePaths.map((relativePath) => path.resolve(root, relativePath))
  );
  return (candidate) => existing.has(path.resolve(candidate));
}

const packaged = resolveClientRuntimePlan({
  root,
  host: "127.0.0.1",
  port: 3001,
  existsSync: existsOnly("client/server.js", "package.json"),
});
assert(packaged.mode === "standalone", "Packaged client was not preferred.");
assert(
  packaged.entry === path.join(root, "client", "server.js"),
  "Packaged client entry is incorrect."
);
assert(packaged.nodeEnv === "production", "Packaged client must be production.");

const localStandalone = resolveClientRuntimePlan({
  root,
  host: "127.0.0.1",
  port: 3001,
  existsSync: existsOnly(".next/standalone/server.js", "package.json"),
});
assert(
  localStandalone.entry === path.join(root, ".next", "standalone", "server.js"),
  "Local standalone client entry is incorrect."
);

const source = resolveClientRuntimePlan({
  root,
  host: "127.0.0.1",
  port: 3001,
  existsSync: existsOnly("node_modules/next/dist/bin/next", "package.json"),
});
assert(source.mode === "next-source", "Source fallback was not selected.");
assert(source.nodeEnv === "development", "Source fallback must use development.");
assert(source.nextDistDir === ".next-client", "Client dist directory is not isolated.");
assert(
  source.args.join(" ").includes("dev --hostname 127.0.0.1 --port 3001"),
  "Source fallback arguments are incorrect."
);

let missingError;
try {
  resolveClientRuntimePlan({
    root,
    host: "127.0.0.1",
    port: 3001,
    existsSync: () => false,
  });
} catch (error) {
  missingError = error;
}
assert(missingError instanceof Error, "Missing runtime did not fail.");
assert(
  missingError.message.includes("node_modules") &&
    missingError.message.includes("client") &&
    missingError.message.includes("server.js"),
  "Missing runtime error did not show all supported entries."
);

console.log("Client runtime resolution plans verified.");
