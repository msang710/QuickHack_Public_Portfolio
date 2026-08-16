import assert from "node:assert/strict";
import {
  assertClientServerPackagePair,
} from "../../quickhack_shared/core/package-runtime-identity.mjs";

const demonstrationServer = {
  runtimeContractVersion: 1,
  role: "server",
  deploymentFlavor: "DEMONSTRATION",
  artifactKind: "DEMONSTRATION_SERVER",
};
const operationalServer = {
  runtimeContractVersion: 1,
  role: "server",
  deploymentFlavor: "OPERATIONAL",
  artifactKind: "OPERATIONAL_SERVER",
};

assert.deepEqual(
  assertClientServerPackagePair(
    { artifactKind: "DEMONSTRATION_CLIENT" },
    demonstrationServer
  ),
  {
    clientArtifactKind: "DEMONSTRATION_CLIENT",
    serverArtifactKind: "DEMONSTRATION_SERVER",
    deploymentFlavor: "DEMONSTRATION",
  }
);
assert.deepEqual(
  assertClientServerPackagePair(
    { artifactKind: "OPERATIONAL_CLIENT" },
    operationalServer
  ),
  {
    clientArtifactKind: "OPERATIONAL_CLIENT",
    serverArtifactKind: "OPERATIONAL_SERVER",
    deploymentFlavor: "OPERATIONAL",
  }
);

for (const [clientArtifactKind, runtime] of [
  ["DEMONSTRATION_CLIENT", operationalServer],
  ["OPERATIONAL_CLIENT", demonstrationServer],
  ["OPERATIONAL_CLIENT", { ...operationalServer, role: "client" }],
  ["OPERATIONAL_CLIENT", { ...operationalServer, runtimeContractVersion: 2 }],
]) {
  assert.throws(
    () => assertClientServerPackagePair({ artifactKind: clientArtifactKind }, runtime),
    (error) => error?.code === "PACKAGE_FLAVOR_MISMATCH"
  );
}

console.log("Client package pre-auth pairing gate verified.");
