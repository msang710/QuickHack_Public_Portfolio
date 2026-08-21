import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertMsixStagingContent,
} from "../../packaging/windows/msix/create-msix-layout.mjs";
import { msixArtifactConfig } from "../../packaging/windows/msix/msix-artifact-config.mjs";
import { renderAppxManifest } from "../../packaging/windows/msix/render-appx-manifest.mjs";

const buildScript = readFileSync(
  new URL("../../packaging/build-msix.ps1", import.meta.url),
  "utf8"
);
const sdkResolver = readFileSync(
  new URL("../../packaging/windows/msix/resolve-windows-sdk-tools.ps1", import.meta.url),
  "utf8"
);
const verifier = readFileSync(
  new URL("../../tools/verify-msix-package.mjs", import.meta.url),
  "utf8"
);

for (const target of ["demo-server", "demo-client", "operational-server", "operational-client"]) {
  const config = msixArtifactConfig(target);
  const manifest = renderAppxManifest({
    target,
    version: "1.2.3",
    publisher: "CN=QuickHack Development",
  });
  assert.match(manifest, new RegExp(`Name="${config.identityName.replaceAll(".", "\\.")}"`, "u"));
  assert.match(manifest, new RegExp(`Id="${config.applicationId}"`, "u"));
  assert.match(manifest, /Version="1\.2\.3\.0"/u);
  assert.match(manifest, /MinVersion="10\.0\.19041\.0"/u);
  assert.match(manifest, /Name="runFullTrust"/u);
  assert.match(manifest, /xmlns:uap5="http:\/\/schemas\.microsoft\.com\/appx\/manifest\/uap\/windows10\/5"/u);
  assert.match(manifest, /Category="windows\.appExecutionAlias"/u);
  assert.match(
    manifest,
    new RegExp(`<uap5:ExecutionAlias Alias="${config.launcherFileName}"`, "u")
  );
  assert.doesNotMatch(manifest, /windows\.service|packagedServices/u);
  const paths = [
    config.launcherFileName,
    "runtime/node/node.exe",
    "runtime/node/LICENSE",
    "runtime/node/quickhack-node-runtime.json",
  ];
  if (config.role === "server") {
    paths.push(
      "runtime/postgresql/bin/postgres.exe",
      "runtime/postgresql/lib/runtime.dll",
      "runtime/postgresql/share/runtime.txt"
    );
  }
  assert.equal(assertMsixStagingContent(config, paths), true);
}

const client = msixArtifactConfig("demo-client");
assert.throws(
  () => assertMsixStagingContent(client, [
    client.launcherFileName,
    "runtime/node/node.exe",
    "runtime/node/LICENSE",
    "runtime/node/quickhack-node-runtime.json",
    "runtime/postgresql/bin/postgres.exe",
  ]),
  (error) => error.code === "MSIX_ROLE_CONTENT_FORBIDDEN"
);
const server = msixArtifactConfig("demo-server");
assert.equal(server.serviceHostsReady, true);
assert.equal(msixArtifactConfig("operational-server").serviceHostsReady, false);
const productionDemoServerManifest = renderAppxManifest({
  target: "demo-server",
  version: "1.0.0",
  includeServices: true,
});
assert.match(productionDemoServerManifest, /Name="QuickHackDemoPostgreSQL"/u);
assert.match(productionDemoServerManifest, /Name="QuickHackDemoServerConsole"/u);
assert.throws(
  () => renderAppxManifest({
    target: "operational-server",
    version: "1.0.0",
    includeServices: true,
  }),
  (error) => error.code === "MSIX_SERVICE_GATE_CLOSED"
);
const serverSetupManifest = renderAppxManifest({
  target: "demo-server",
  version: "1.0.0",
  includeServerSetup: true,
});
assert.match(serverSetupManifest, /Id="QuickHackDemoServerSetup"/u);
assert.match(serverSetupManifest, /Name="allowElevation"/u);
assert.equal((serverSetupManifest.match(/<Application\b/gu) ?? []).length, 2);
const completeDemoServerPaths = [
  server.launcherFileName,
  "runtime/node/node.exe",
  "runtime/node/LICENSE",
  "runtime/node/quickhack-node-runtime.json",
  "runtime/postgresql/bin/postgres.exe",
  "runtime/postgresql/lib/runtime.dll",
  "runtime/postgresql/share/runtime.txt",
  "Services/QuickHackPostgresqlServiceHost.exe",
  "Services/QuickHackServerServiceHost.exe",
  "QuickHack-Demo-Server-Setup.exe",
];
assert.equal(assertMsixStagingContent(server, completeDemoServerPaths, {
  includeServices: true,
  includeServerSetup: true,
}), true);
assert.throws(
  () => assertMsixStagingContent(server, completeDemoServerPaths.filter(
    (entry) => entry !== "Services/QuickHackServerServiceHost.exe"
  ), { includeServices: true }),
  (error) => error.code === "MSIX_RUNTIME_MISSING"
);
assert.throws(
  () => assertMsixStagingContent(server, completeDemoServerPaths.filter(
    (entry) => entry !== "QuickHack-Demo-Server-Setup.exe"
  ), { includeServerSetup: true }),
  (error) => error.code === "MSIX_RUNTIME_MISSING"
);
assert.throws(
  () => assertMsixStagingContent(server, [
    server.launcherFileName,
    "runtime/node/node.exe",
    "runtime/node/LICENSE",
    "runtime/node/quickhack-node-runtime.json",
  ]),
  (error) => error.code === "MSIX_RUNTIME_MISSING"
);
assert.throws(
  () => assertMsixStagingContent(client, [
    client.launcherFileName,
    "runtime/node/node.exe",
    "runtime/node/LICENSE",
    "runtime/node/quickhack-node-runtime.json",
    "AppxManifest.xml",
  ]),
  (error) => error.code === "MSIX_STAGING_STALE"
);
const previewManifest = renderAppxManifest({
  target: "demo-server",
  version: "1.0.0-preview.1",
  preview: true,
  includeServices: true,
});
assert.match(previewManifest, /Name="QuickHack\.Preview\.Demonstration\.Server"/u);
assert.match(previewManifest, /Name="QuickHackPreviewDemoPostgreSQL"/u);
assert.match(previewManifest, /Name="QuickHackPreviewDemoServerConsole"/u);
assert.match(previewManifest, /Name="packagedServices"/u);
assert.equal((previewManifest.match(/<Extensions>/gu) ?? []).length, 1);
assert.match(previewManifest, /Category="windows\.appExecutionAlias"/u);

assert.match(buildScript, /MakeAppx pack \/o \/h SHA256/u);
assert.match(buildScript, /MakeAppx unpack \/o/u);
assert.match(buildScript, /TestCertificate/u);
assert.match(buildScript, /SignTool verify \/pa \/v/u);
assert.match(buildScript, /sourceDirty/u);
assert.match(
  buildScript,
  /\$sourceDirty = \[bool\]\(@\(& git -C \$repositoryRoot status --porcelain\)\.Count\)/u
);
assert.match(sdkResolver, /Microsoft\.Windows\.SDK\.BuildTools/u);
assert.match(verifier, /AppxSignature\.p7x/u);
assert.match(verifier, /visualAssetManifestSha256/u);
assert.match(verifier, /canonical branding revision/u);

console.log("QuickHack MSIX manifest, layout, pack, signature, and verifier contracts verified.");
