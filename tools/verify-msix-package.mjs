import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { msixArtifactConfig } from "../packaging/windows/msix/msix-artifact-config.mjs";
import { msixVersionFromSemver } from "../packaging/windows/msix/msix-version.mjs";

const canonicalBranding = JSON.parse(
  readFileSync(new URL("../assets/branding/windows-icon.json", import.meta.url), "utf8")
);

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withoutBom(value) {
  return value.replace(/^\uFEFF/u, "");
}

function readJson(filename) {
  return JSON.parse(withoutBom(readFileSync(filename, "utf8")));
}

function xmlDecode(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function attribute(source, elementName, attributeName) {
  const element = new RegExp(`<${elementName}\\b[^>]*>`, "u").exec(source)?.[0];
  const observed = element
    ? new RegExp(`\\b${attributeName}="([^"]*)"`, "u").exec(element)?.[1]
    : undefined;
  if (observed === undefined) {
    throw failure("MSIX_MANIFEST_INVALID", `Missing ${elementName}@${attributeName}.`);
  }
  return xmlDecode(observed);
}

function pngDimensions(filename) {
  const bytes = readFileSync(filename);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw failure("MSIX_BRANDING_INVALID", `Visual asset is not a PNG: ${filename}`);
  }
  return Object.freeze({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}

function assertRegularTree(rootDirectory) {
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) {
        throw failure("MSIX_CONTENT_INVALID", `Unpacked MSIX contains a symbolic link: ${filename}`);
      }
      if (stat.isDirectory()) pending.push(filename);
    }
  }
}

function expectFile(rootDirectory, relativePath) {
  const filename = path.join(rootDirectory, ...relativePath.split("/"));
  if (!existsSync(filename) || !lstatSync(filename).isFile()) {
    throw failure("MSIX_CONTENT_MISSING", `MSIX content is missing: ${relativePath}`);
  }
  return filename;
}

export function verifyMsixPackage(input) {
  const rootDirectory = path.resolve(String(input?.directory ?? ""));
  if (!existsSync(rootDirectory)) throw failure("MSIX_CONTENT_MISSING", "Unpacked MSIX directory was not found.");
  assertRegularTree(rootDirectory);
  const config = msixArtifactConfig(input?.target, {
    publisher: input?.publisher,
    preview: input?.preview === true,
  });
  const expectedVersion = msixVersionFromSemver(input?.version, { revision: input?.revision });
  const manifest = readFileSync(expectFile(rootDirectory, "AppxManifest.xml"), "utf8");
  const evidence = readJson(expectFile(rootDirectory, "quickhack-msix-build.json"));

  const identityExpectations = {
    Name: config.identityName,
    Publisher: config.publisher,
    Version: expectedVersion,
    ProcessorArchitecture: config.architecture,
  };
  for (const [name, expected] of Object.entries(identityExpectations)) {
    if (attribute(manifest, "Identity", name) !== expected) {
      throw failure("MSIX_IDENTITY_MISMATCH", `MSIX Identity@${name} does not match its artifact contract.`);
    }
  }
  if (attribute(manifest, "Application", "Id") !== config.applicationId) {
    throw failure("MSIX_IDENTITY_MISMATCH", "MSIX Application@Id does not match its artifact contract.");
  }
  if (attribute(manifest, "Application", "Executable") !== config.launcherFileName) {
    throw failure("MSIX_IDENTITY_MISMATCH", "MSIX Application@Executable does not match its launcher.");
  }
  if (attribute(manifest, "TargetDeviceFamily", "MinVersion") !== config.minimumOsVersion) {
    throw failure("MSIX_OS_VERSION_MISMATCH", "MSIX minimum OS version does not match its contract.");
  }
  for (const expectedLogo of [
    "Assets\\StoreLogo.png",
    "Assets\\Square44x44Logo.png",
    "Assets\\Square150x150Logo.png",
  ]) {
    if (!manifest.includes(expectedLogo)) {
      throw failure("MSIX_BRANDING_INVALID", `MSIX manifest does not reference ${expectedLogo}.`);
    }
  }

  expectFile(rootDirectory, config.launcherFileName);
  expectFile(rootDirectory, "runtime/node/node.exe");
  expectFile(rootDirectory, "runtime/node/LICENSE");
  expectFile(rootDirectory, "runtime/node/quickhack-node-runtime.json");
  const postgresqlRoot = path.join(rootDirectory, "runtime", "postgresql");
  if (config.runtime.postgresql) {
    expectFile(rootDirectory, "runtime/postgresql/bin/postgres.exe");
    for (const directoryName of ["lib", "share"]) {
      if (!existsSync(path.join(postgresqlRoot, directoryName))) {
        throw failure("MSIX_RUNTIME_MISSING", `Server MSIX is missing PostgreSQL ${directoryName}.`);
      }
    }
  } else if (existsSync(postgresqlRoot)) {
    throw failure("MSIX_ROLE_CONTENT_FORBIDDEN", "Client MSIX contains PostgreSQL content.");
  }

  const includeServices = input?.includeServices === true;
  const observedServiceExtension = manifest.includes('Category="windows.service"');
  const observedPackagedServices = manifest.includes('Name="packagedServices"');
  if (observedServiceExtension !== includeServices || observedPackagedServices !== includeServices) {
    throw failure("MSIX_SERVICE_CONTRACT_INVALID", "MSIX packaged service declarations do not match the build mode.");
  }
  if (includeServices) {
    for (const service of config.services) {
      if (!manifest.includes(`Name="${service.name}"`)) {
        throw failure("MSIX_SERVICE_CONTRACT_INVALID", `MSIX service is missing: ${service.name}`);
      }
      expectFile(rootDirectory, service.executable.replaceAll("\\", "/"));
    }
  }

  const includeServerSetup = input?.includeServerSetup === true;
  const observedSetupApplication = config.setup
    ? manifest.includes(`Id="${config.setup.applicationId}"`)
    : false;
  const observedElevation = manifest.includes('Name="allowElevation"');
  if (observedSetupApplication !== includeServerSetup || observedElevation !== includeServerSetup) {
    throw failure("MSIX_SETUP_CONTRACT_INVALID", "MSIX Server Setup declarations do not match the build mode.");
  }
  if (includeServerSetup) {
    if (config.role !== "server" || !config.setup) {
      throw failure("MSIX_SETUP_TARGET_INVALID", "MSIX Server Setup requires a server artifact.");
    }
    expectFile(rootDirectory, config.setup.executable.replaceAll("\\", "/"));
  }

  const visualManifestPath = expectFile(rootDirectory, "Assets/visual-assets.manifest.json");
  const visualManifestBytes = readFileSync(visualManifestPath);
  const visualManifest = JSON.parse(withoutBom(visualManifestBytes.toString("utf8")));
  if (
    visualManifest.brandingRevision !== canonicalBranding.brandingRevision ||
    visualManifest.generatorVersion !== canonicalBranding.generatorVersion ||
    visualManifest.source?.sha256 !== canonicalBranding.source.sha256
  ) {
    throw failure("MSIX_BRANDING_INVALID", "MSIX visual assets do not match the canonical branding revision.");
  }
  const expectedVisualOutputs = new Map(
    canonicalBranding.outputs.map((output) => [output.path, output])
  );
  if ((visualManifest.outputs ?? []).length !== expectedVisualOutputs.size) {
    throw failure("MSIX_BRANDING_INVALID", "MSIX visual asset count does not match canonical branding.");
  }
  for (const output of visualManifest.outputs ?? []) {
    const expectedOutput = expectedVisualOutputs.get(output.path);
    if (
      !expectedOutput ||
      output.width !== expectedOutput.width ||
      output.height !== expectedOutput.height
    ) {
      throw failure("MSIX_BRANDING_INVALID", `MSIX visual asset contract is unexpected: ${output.path}`);
    }
    const filename = expectFile(rootDirectory, `Assets/${String(output.path).replaceAll("\\", "/")}`);
    const observedHash = createHash("sha256").update(readFileSync(filename)).digest("hex");
    const dimensions = pngDimensions(filename);
    if (observedHash !== output.sha256 || dimensions.width !== output.width || dimensions.height !== output.height) {
      throw failure("MSIX_BRANDING_INVALID", `MSIX visual asset does not match its manifest: ${output.path}`);
    }
  }

  const evidenceExpectations = {
    schemaVersion: 1,
    artifactKind: config.artifactKind,
    packageTarget: config.packageTarget,
    identityName: config.identityName,
    applicationId: config.applicationId,
    publisher: config.publisher,
    semanticVersion: String(input?.version),
    msixVersion: expectedVersion,
    architecture: config.architecture,
    minimumOsVersion: config.minimumOsVersion,
    visualAssetManifestSha256: createHash("sha256").update(visualManifestBytes).digest("hex"),
    brandingRevision: canonicalBranding.brandingRevision,
    serviceExtensions: includeServices,
    serverSetup: includeServerSetup,
    preview: config.preview,
  };
  for (const [name, expected] of Object.entries(evidenceExpectations)) {
    if (evidence[name] !== expected) {
      throw failure("MSIX_PROVENANCE_INVALID", `MSIX build evidence field does not match: ${name}.`);
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(evidence.sourceCommit)) {
    throw failure("MSIX_PROVENANCE_INVALID", "MSIX build evidence has an invalid source commit.");
  }
  if (evidence.runtime?.node !== true || evidence.runtime?.postgresql !== config.runtime.postgresql) {
    throw failure("MSIX_PROVENANCE_INVALID", "MSIX runtime evidence does not match its artifact role.");
  }
  const signatureMode = String(input?.signatureMode ?? "UNSIGNED").toUpperCase();
  const signatureExists = existsSync(path.join(rootDirectory, "AppxSignature.p7x"));
  if (signatureMode === "UNSIGNED" ? signatureExists : !signatureExists) {
    throw failure("MSIX_SIGNATURE_INVALID", "MSIX signature content does not match the requested signing mode.");
  }
  return Object.freeze({ config, evidence, signatureMode });
}

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    if (argument === "--include-services") result.includeServices = true;
    else if (argument === "--include-server-setup") result.includeServerSetup = true;
    else if (argument === "--preview") result.preview = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [name, ...valueParts] = argument.slice(2).split("=");
      result[name.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = valueParts.join("=");
    } else throw new Error(`Unsupported MSIX verifier argument: ${argument}`);
  }
  return {
    directory: result.directory,
    target: result.target,
    version: result.version,
    revision: result.revision === undefined ? undefined : Number(result.revision),
    publisher: result.publisher,
    signatureMode: result.signatureMode,
    includeServices: result.includeServices === true,
    includeServerSetup: result.includeServerSetup === true,
    preview: result.preview === true,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyMsixPackage(parseArguments(process.argv.slice(2)));
  console.log(`QuickHack MSIX package verified: ${result.config.packageTarget}`);
}
