import { packageReleaseVariant } from "../../../packaging/package-release-matrix.mjs";
import { LINUX_PACKAGE_TARGETS, linuxArtifactConfig } from "../../../packaging/linux/linux-artifact-config.mjs";
import path from "node:path";

export const LINUX_PHYSICAL_SMOKE_OPT_IN = "QUICKHACK_RUN_PHYSICAL_LINUX_SMOKE";

function notRun(reason) {
  return Object.freeze({ status: "NOT_RUN", reason, steps: Object.freeze([]) });
}

export function linuxPackageSmokeInputs({ version, artifactRoot }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(version ?? ""))) {
    throw new TypeError("A semantic --version is required for the Linux package smoke.");
  }
  if (
    typeof artifactRoot !== "string" ||
    artifactRoot.trim() === "" ||
    !path.posix.isAbsolute(artifactRoot)
  ) {
    throw new TypeError("An absolute artifact root is required for the Linux package smoke.");
  }
  return Object.freeze(
    Object.fromEntries(
      LINUX_PACKAGE_TARGETS.map((target) => {
        const release = packageReleaseVariant("linux", target, version);
        return [target, Object.freeze({
          target,
          identity: linuxArtifactConfig(target).installedIdentity,
          artifactDirectory: path.posix.join(artifactRoot, target),
          artifactFileName: release.artifactFileName,
        })];
      })
    )
  );
}

export async function runLinuxPackageSmoke({ approved, version, artifactRoot, runtime }) {
  if (!approved) return notRun("EXPLICIT_OPT_IN_REQUIRED");
  if (runtime.platform() !== "linux") return notRun("ARCH_LINUX_REQUIRED");
  if (!runtime.isArchLinux()) return notRun("ARCH_LINUX_REQUIRED");
  if (runtime.uid() !== 0) return notRun("ROOT_REQUIRED");

  const inputs = linuxPackageSmokeInputs({ version, artifactRoot });
  const steps = [];
  const installed = [];
  const record = (name, status, details = undefined) => {
    steps.push(Object.freeze({ name, status, ...(details ? { details } : {}) }));
  };

  try {
    for (const input of Object.values(inputs)) {
      await runtime.verifyArtifact(input);
      record(`verify:${input.target}`, "PASS");
    }

    await runtime.install(inputs["demo-server"]);
    installed.push(inputs["demo-server"].identity);
    await runtime.assertInstalled(inputs["demo-server"]);
    record("install:demo-server", "PASS");

    await runtime.assertConflict(inputs["operational-server"], inputs["demo-server"]);
    record("conflict:server-flavors", "PASS");

    await runtime.install(inputs["demo-client"]);
    installed.push(inputs["demo-client"].identity);
    await runtime.install(inputs["operational-client"]);
    installed.push(inputs["operational-client"].identity);
    await runtime.assertInstalled(inputs["demo-client"]);
    await runtime.assertInstalled(inputs["operational-client"]);
    record("coexist:clients", "PASS");

    await runtime.remove(inputs["demo-server"].identity);
    installed.splice(installed.indexOf(inputs["demo-server"].identity), 1);
    await runtime.assertMutableStatePreserved(inputs["demo-server"]);
    record("remove:demo-server-preserves-state", "PASS");

    return Object.freeze({ status: "PASS", reason: null, steps: Object.freeze(steps) });
  } catch (error) {
    record("smoke", "FAIL", { code: error?.code ?? "LINUX_PACKAGE_SMOKE_FAILED" });
    return Object.freeze({ status: "FAIL", reason: error?.code ?? "LINUX_PACKAGE_SMOKE_FAILED", steps: Object.freeze(steps) });
  } finally {
    for (const identity of installed.reverse()) {
      await runtime.remove(identity);
    }
  }
}
