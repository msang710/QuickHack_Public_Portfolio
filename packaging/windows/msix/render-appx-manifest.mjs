import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { msixArtifactConfig } from "./msix-artifact-config.mjs";
import { msixVersionFromSemver } from "./msix-version.mjs";

const TEMPLATE_PATH = fileURLToPath(new URL("./AppxManifest.template.xml", import.meta.url));

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function serviceExtensions(config) {
  return config.services.map((service) => {
    const dependencies = service.dependencies.length === 0
      ? ""
      : [
          "          <desktop6:Dependencies>",
          ...service.dependencies.map(
            (dependency) => `            <desktop6:DependentService Name="${xml(dependency)}" />`
          ),
          "          </desktop6:Dependencies>",
        ].join("\n");
    const body = dependencies ? `\n${dependencies}\n        ` : "";
    return [
      `        <desktop6:Extension Category="windows.service" Executable="${xml(service.executable)}" EntryPoint="Windows.FullTrustApplication">`,
      `          <desktop6:Service Name="${xml(service.name)}" StartupType="${xml(service.startupType)}" StartAccount="${xml(service.startAccount)}">${body}</desktop6:Service>`,
      "        </desktop6:Extension>",
    ].join("\n");
  });
}

function applicationExtensions(config, includeServices) {
  const extensions = [
    [
      `        <uap5:Extension Category="windows.appExecutionAlias" Executable="${xml(config.launcherFileName)}" EntryPoint="Windows.FullTrustApplication">`,
      "          <uap5:AppExecutionAlias>",
      `            <uap5:ExecutionAlias Alias="${xml(config.launcherFileName)}" />`,
      "          </uap5:AppExecutionAlias>",
      "        </uap5:Extension>",
    ].join("\n"),
    ...(includeServices ? serviceExtensions(config) : []),
  ];
  return ["      <Extensions>", ...extensions, "      </Extensions>"].join("\n");
}

function additionalApplications(config, includeServerSetup) {
  if (!includeServerSetup) return "";
  return [
    "    <Application",
    `      Id="${xml(config.setup.applicationId)}"`,
    `      Executable="${xml(config.setup.executable)}"`,
    "      EntryPoint=\"Windows.FullTrustApplication\">",
    "      <uap:VisualElements",
    "        AppListEntry=\"default\"",
    `        DisplayName="${xml(config.setup.displayName)}"`,
    `        Description="${xml(config.description)}"`,
    "        BackgroundColor=\"transparent\"",
    "        Square44x44Logo=\"Assets\\Square44x44Logo.png\"",
    "        Square150x150Logo=\"Assets\\Square150x150Logo.png\" />",
    "    </Application>",
  ].join("\n");
}

export function renderAppxManifest(input) {
  const config = msixArtifactConfig(input?.target, {
    publisher: input?.publisher,
    preview: input?.preview === true,
  });
  const includeServices = input?.includeServices === true;
  const includeServerSetup = input?.includeServerSetup === true;
  if (includeServices && config.role !== "server") {
    throw new Error("MSIX service extensions are only valid for server artifacts.");
  }
  if (includeServices && config.serviceHostsReady !== true && input?.allowPreviewServices !== true) {
    const error = new Error("Packaged service hosts have not passed the Windows-native feasibility gate.");
    error.code = "MSIX_SERVICE_GATE_CLOSED";
    throw error;
  }
  if (includeServerSetup && config.role !== "server") {
    const error = new Error("MSIX Server Setup is only valid for server artifacts.");
    error.code = "MSIX_SETUP_TARGET_INVALID";
    throw error;
  }
  const msixVersion = input?.msixVersion ?? msixVersionFromSemver(input?.version);
  const replacements = {
    IDENTITY_NAME: config.identityName,
    PUBLISHER: config.publisher,
    VERSION: msixVersion,
    ARCHITECTURE: config.architecture,
    DISPLAY_NAME: config.applicationName,
    DESCRIPTION: config.description,
    MINIMUM_OS_VERSION: config.minimumOsVersion,
    MAX_VERSION_TESTED: config.maxVersionTested,
    APPLICATION_ID: config.applicationId,
    EXECUTABLE: config.launcherFileName,
    APPLICATION_EXTENSIONS: applicationExtensions(config, includeServices),
    ADDITIONAL_APPLICATIONS: additionalApplications(config, includeServerSetup),
    CAPABILITIES: [
      "    <rescap:Capability Name=\"runFullTrust\" />",
      ...(includeServerSetup
        ? ["    <rescap:Capability Name=\"allowElevation\" />"]
        : []),
      ...(includeServices
        ? ["    <rescap:Capability Name=\"packagedServices\" />"]
        : []),
    ].join("\n"),
  };
  let template = readFileSync(TEMPLATE_PATH, "utf8");
  const rawPlaceholders = new Set([
    "APPLICATION_EXTENSIONS",
    "ADDITIONAL_APPLICATIONS",
    "CAPABILITIES",
  ]);
  for (const [name, value] of Object.entries(replacements)) {
    template = template.replaceAll(
      `{{${name}}}`,
      rawPlaceholders.has(name) ? value : xml(value)
    );
  }
  if (/\{\{[A-Z0-9_]+\}\}/u.test(template)) {
    throw new Error("AppxManifest template contains an unresolved placeholder.");
  }
  return `${template.trim()}\n`;
}

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    if (argument === "--include-services") result.includeServices = true;
    else if (argument === "--include-server-setup") result.includeServerSetup = true;
    else if (argument === "--preview") result.preview = true;
    else if (argument === "--allow-preview-services") result.allowPreviewServices = true;
    else if (argument.startsWith("--") && argument.includes("=")) {
      const [name, ...valueParts] = argument.slice(2).split("=");
      result[name.replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = valueParts.join("=");
    } else {
      throw new Error(`Unsupported AppxManifest renderer argument: ${argument}`);
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = parseArguments(process.argv.slice(2));
  if (!input.output) throw new Error("--output is required.");
  writeFileSync(input.output, renderAppxManifest(input), "utf8");
}
